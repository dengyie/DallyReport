// ai-daily 跨天已报道账本（9/13 重构新增）——治理「同一事件连续多天整条重复成稿」的 P0 缺口。
// 旧架构跨 run 零状态：3 天窗口重叠让昨日头条今日仍窗内、KNOWN_MAJOR_OUT 种子 21 天逐日重注入，
// 实证 V4-Flash-Vision-Exp 连续 3 天、水彩 RL/孙鹏加盟等连续 2 天整条重复（同 URL）。
//
// 双端分工：
//   记录端 = finalize.mjs（宿主）：每轮成稿后把 confirmed/outOfWindow 条目追加进
//     ~/.ai-daily/published-ledger.json（HOME 而非 iCloud——launchd TCC 读不了 Mobile Documents，
//     8/31 P4 实证；HOME 路径有 linuxdo-prefetch.json 先例）。
//   消费端 = workflow realm：args.reportedLedger 注入本模块的过滤函数——已报道 URL 硬过滤（fetch
//     配额前）、已报道种子退役（major-out 注入前）、已报道名单进 report prompt（软网，兜同事件换 URL）。
//
// 本模块纯函数、可 inline（无 fs/fetch/Date.now；日期算术走 date-utils 的纯函数）。

import { normURL, normalizeDate, daysBetween } from './date-utils.mjs'
import { clusterTokenize } from './cluster.mjs'

// 硬匹配阈值（保守取向：宁可漏放——软网 report prompt 还有一道；不可误杀——同名家族条目如
// 「Gemini 3.8 Flash」vs「Gemini 3.8 Flash Cyber」overlap 天然偏高，靠「共享 ≥5 token」压误杀）。
// overlap = |A∩B| / min(|A|,|B|)。
export const LEDGER_OVERLAP_MIN = 0.8
export const LEDGER_SHARE_MIN = 5
// 常规条目回看窗：窗口为 D-2~D，跨天重叠最长 2 天 + 当日 = 3。
export const LEDGER_LOOKBACK_DAYS = 3
// 账本保留天数（prune）。种子退役判定依赖账本在保留窗内命中即可——种子自身 age gate 21d < 60d。
export const LEDGER_KEEP_DAYS = 60
// 单条指纹 token 上限（长 claim 防爆炸；截断侧仍保实体词——tokenizer 输出序 ASCII 在前）。
export const LEDGER_MAX_TOKENS = 64

// 指纹 token：复用 cluster 的 tokenizer（ASCII ≥4 + CJK bigram、双停用表），Set 去重后截断。
export const fingerprintTokens = s => [...new Set(clusterTokenize(s))].slice(0, LEDGER_MAX_TOKENS)

// 账本条目构造（finalize 记账与测试共用同一 shape）。
export const makeLedgerEntry = (day, url, claimText, major) => ({
  day: String(day || ''),
  url: String(url || ''),
  tokens: fingerprintTokens(claimText),
  title: String(claimText || '').slice(0, 80),
  major: !!major,
})

const _overlap = (a, b) => {
  const A = new Set(a), B = new Set(b)
  if (!A.size || !B.size) return { shared: 0, ratio: 0 }
  let shared = 0
  for (const t of A) if (B.has(t)) shared++
  return { shared, ratio: shared / Math.min(A.size, B.size) }
}

// 同一事件判定（硬）：URL 归一命中即同事件；否则指纹高重叠 + 足量共享 token。
export const storyMatch = (claimLike, entry) => {
  if (!claimLike || !entry) return false
  const u1 = normURL(claimLike.url || '')
  if (u1 && entry.url && normURL(entry.url) === u1) return true
  const { shared, ratio } = _overlap(claimLike.tokens || [], entry.tokens || [])
  return shared >= LEDGER_SHARE_MIN && ratio >= LEDGER_OVERLAP_MIN
}

// entry.day 距 today 是否在 lookback 天内（含当日）。任一日期不可解析 → 视为在窗内（保守去重；
// finalize 只写合法 day，该分支仅防御手工编辑的账本）。
const _withinLookback = (entryDay, today, lookback) => {
  const e = normalizeDate(entryDay), t = normalizeDate(today)
  if (e == null || t == null) return true
  const age = daysBetween(e, t)
  return age >= 0 && age <= lookback
}

// 过滤近 lookbackDays 天已报道的 fetch 候选。返回 { keep, dropped }，不改输入数组。
// fail-open：ledger 非数组/空 → 全保留（该轮无账本可用，软网在 report prompt）。
export const filterReportedTargets = (targets, ledger, opts) => {
  const entries = Array.isArray(ledger) ? ledger : []
  const today = opts && opts.today
  const lookback = opts && typeof opts.lookbackDays === 'number' ? opts.lookbackDays : LEDGER_LOOKBACK_DAYS
  const recent = entries.filter(e => _withinLookback(e && e.day, today, lookback))
  const keep = [], dropped = []
  for (const t of (targets || [])) {
    const like = { url: t && t.url, tokens: fingerprintTokens((t && t.title) || (t && t.url) || '') }
    const hit = recent.find(e => storyMatch(like, e))
    if (hit) dropped.push({ url: t.url, board: t && t.board, matchedDay: hit.day, matchedUrl: hit.url || null })
    else keep.push(t)
  }
  return { keep, dropped }
}

// 种子退役（严格策略）：已报道过的 KNOWN_MAJOR_OUT 种子不再注入正文（报过一次即退役）。
// 不看 lookback——major-out 一旦成稿就不再逐日刷屏；账本 60d prune 兜底（> 种子 age gate 21d）。
// 返回 { fresh, reported }；reported 项附 reportedDay 供日志。
export const splitSeeds = (seeds, ledger) => {
  const entries = Array.isArray(ledger) ? ledger : []
  const fresh = [], reported = []
  for (const s of (seeds || [])) {
    const like = { url: (s && s.url) || '', tokens: fingerprintTokens(((s && s.name) || '') + ' ' + ((s && s.note) || '')) }
    const hit = entries.find(e => storyMatch(like, e))
    if (hit) reported.push({ ...s, reportedDay: hit.day })
    else fresh.push(s)
  }
  return { fresh, reported }
}

// prune：只保留近 keepDays 天条目；day 不可解析的条目剔除（账本卫生）。today 缺失 → 原样返回。
export const pruneLedger = (entries, today, keepDays) => {
  if (!Array.isArray(entries)) return []
  const keep = typeof keepDays === 'number' ? keepDays : LEDGER_KEEP_DAYS
  const t = normalizeDate(today)
  if (t == null) return entries
  return entries.filter(e => {
    const d = normalizeDate(e && e.day)
    if (d == null) return false
    const age = daysBetween(d, t)
    return age >= 0 && age <= keep
  })
}
