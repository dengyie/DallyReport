// ai-daily 跨天已报道账本（9/13 重构新增）——治理「同一事件连续多天整条重复成稿」的 P0 缺口。
// 旧架构跨 run 零状态：3 天窗口重叠让昨日头条今日仍窗内、KNOWN_MAJOR_OUT 种子 21 天逐日重注入，
// 实证 V4-Flash-Vision-Exp 连续 3 天、水彩 RL/孙鹏加盟等连续 2 天整条重复（同 URL）。
//
// 双端分工：
//   记录端 = finalize.mjs（宿主）：每轮成稿后把 confirmed[] 追加进
//     ~/.ai-daily/published-ledger.json（HOME 而非 iCloud——launchd TCC 读不了 Mobile Documents，
//     8/31 P4 实证；HOME 路径有 linuxdo-prefetch.json 先例）。
//   消费端 = workflow realm：args.reportedLedger 注入本模块的过滤函数——已报道 URL 硬过滤（fetch
//     配额前）、已报道种子退役（major-out 注入前）、已报道名单进 report prompt（软网，兜同事件换 URL）。
//
// 本模块纯函数、可 inline（无 fs/fetch/Date.now；日期算术走 date-utils 的纯函数）。

import { normURL, normalizeDate, daysBetween } from './date-utils.mjs'
import { clusterTokenize } from './cluster.mjs'
import { isJunkClaim } from './claim-gate.mjs'

// 硬匹配阈值（保守取向：宁可漏放——软网 report prompt 还有一道；不可误杀——同名家族条目如
// 「Gemini 3.8 Flash」vs「Gemini 3.8 Flash Cyber」overlap 天然偏高，靠「共享 ≥5 token」压误杀）。
// overlap = |A∩B| / min(|A|,|B|)。
export const LEDGER_OVERLAP_MIN = 0.8
export const LEDGER_SHARE_MIN = 5
// 常规条目回看窗：窗口为 D-2~D，跨天重叠最长 2 天 + 当日 = 3。
export const LEDGER_LOOKBACK_DAYS = 3
// 账本保留天数（prune）。种子退役判定依赖账本在保留窗内命中即可——种子自身 age gate 21d < 60d。
export const LEDGER_KEEP_DAYS = 60
// 单条指纹 token 上限（长 claim 防爆炸）。9/19 修复：旧版整体 Set 后 slice(64)——tokenizer 输出序
// ASCII 在前，长英文 snippet 的中文 bigram 全被截掉，「中文账本条目 vs 长英文混排候选」overlap=0，
// 同事件换 URL 的中文重复漏过硬过滤。改为 ASCII/CJK 两桶各留一半（分桶截断，类别间不再互相挤压）。
export const LEDGER_MAX_TOKENS = 64
// 09-20：无连字符产品名（fable/astra）与短版本号（gpt-6）打不进「连字符≥8」强实体，
// overlap 又因 note 改写 <0.8 → 昨日 [窗口外·重大] 次日重注入。通用厂商词不得进此路径。
const LEDGER_GENERIC_ASCII = new Set(['gemini', 'flash', 'grok', 'openai', 'google', 'agent', 'anthropic', 'nvidia', 'github', 'linux', 'huggingface', 'deepseek', 'claude', 'qwen', 'minimax', 'meta', 'microsoft', 'amazon', 'apple', 'intel', 'paper', 'blog', 'news', 'note', 'report', 'model', 'models', 'open', 'new', 'post', 'api', 'app', 'apps', 'ai', 'pro', 'free', 'beta', 'tool', 'tools', 'official', 'release', 'update', 'announce', 'launch', 'said', 'code', 'test', 'data', 'chat'])

const _isDistinctiveAscii = t => {
  if (typeof t !== 'string' || t.length < 5) return false
  if (!/^[a-z0-9][a-z0-9.%\-]*$/.test(t)) return false
  if (!/[a-z]/.test(t)) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false
  if (LEDGER_GENERIC_ASCII.has(t)) return false
  return true
}

// 消费端入口：宿主偶发把账本当 JSON 字符串注入；空/坏形态 → null（fail-open）。
// 10-05 P2 根因修复（10-05 日报实证）：质量门上线**前**写入的账本条目（10-04「image 580×286
// 7.97 KB」）经 buildYesterdayTopics 原样渲染进次日报告——声明质量门只拦今日 claim，拦不住
// 已入库的历史毒条目。入口统一卫生过滤（isJunkClaim 判已报道条目的 title）：一处过滤保护
// 全部消费者（fetch 硬过滤 / 种子退役 / report 软网 / 昨日话题追踪）。title 缺失不判（fail-open，
// 与本模块其余守卫一致）；全被滤掉 → null（等价无账本，degraded 旗标如实上报）。
export const parseReportedLedger = raw => {
  let v = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (!Array.isArray(v) || !v.length) return null
  const ok = v.filter(e => e && typeof e === 'object' && typeof e.day === 'string' && Array.isArray(e.tokens)
    && !(e.title && isJunkClaim({ claim: e.title })))
  return ok.length ? ok : null
}

// 指纹 token：复用 cluster 的 tokenizer（ASCII ≥4 + CJK bigram、双停用表），Set 去重后分桶截断。
export const fingerprintTokens = s => {
  const toks = [...new Set(clusterTokenize(s))]
  const half = Math.ceil(LEDGER_MAX_TOKENS / 2)
  const ascii = toks.filter(t => !/[\u4e00-\u9fff]/.test(t)).slice(0, half)
  const cjk = toks.filter(t => /[\u4e00-\u9fff]/.test(t)).slice(0, half)
  return [...ascii, ...cjk]
}

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

// 同一事件判定（硬）：URL 归一命中即同事件；否则指纹高重叠 + 足量共享 token；
// 再否则「强实体」——带连字符的长 ASCII 产品名（V4-Flash-Vision-Exp）在账本 token 精确命中。
// 必须含字母，并排除 ISO 日期（2026-09-13 长度≥8 且带连字符，日报/linux.do 标题几乎每天都有）。
// 不放宽 gemini/flash 这类无连字符通用词（同名家族误杀）。
export const storyMatch = (claimLike, entry) => {
  if (!claimLike || !entry) return false
  const u1 = normURL(claimLike.url || '')
  if (u1 && entry.url && normURL(entry.url) === u1) return true
  const cTok = claimLike.tokens || []
  const eTok = entry.tokens || []
  const { shared, ratio } = _overlap(cTok, eTok)
  if (shared >= LEDGER_SHARE_MIN && ratio >= LEDGER_OVERLAP_MIN) return true
  const eSet = new Set(eTok)
  for (const t of cTok) {
    if (typeof t !== 'string' || t.length < 8 || !t.includes('-')) continue
    if (!/^[a-z0-9][a-z0-9.%\-]*$/.test(t)) continue
    if (!/[a-z]/.test(t)) continue
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) continue
    if (eSet.has(t)) return true
  }
  // 09-20：fable/mythos 无连字符、gpt-6 连字符不足 8。共享 ≥2 个特异 ASCII，或带数字的产品版本号，即同事件。
  let distinctiveShared = 0
  for (const t of cTok) {
    if (!_isDistinctiveAscii(t) || !eSet.has(t)) continue
    if (/\d/.test(t)) return true
    distinctiveShared++
    if (distinctiveShared >= 2) return true
  }
  return false
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
    // URL 只走 normURL 等值，不进 token——ASCII 路径段会稀释 overlap（shared/min(|A|,|B|)）。
    const like = { url: t && t.url, tokens: fingerprintTokens([t && t.title, t && t.snippet, t && t.note].filter(Boolean).join(' ')) }
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

// ─── 10/03 对齐参考日报：昨日话题追踪（连续剧）───
// 参考报的「昨日话题追踪（第 N 日）」由跨天账本确定性渲染：昨日（含前日）已报道条目 + 今日
// confirmed 中 storyMatch 命中该事件的条目 = 「本次新增」。与 reportedBlock（软网去重）分工：
// reportedBlock 是 report prompt 的输入（禁重复成文），本函数是 md 渲染的数据（读者可见的追踪节）。
// 注意：同 URL 的昨日候选已被 filterReportedTargets 硬过滤、进不了今日 confirmed——
// 能命中 todayUpdate 的只可能是「同事件换 URL/新进展」，正是追踪节该呈现的内容。
// ledger/confirmedItems 可为空数组；today 不可解析 → []（fail-open，不渲染空骨架）。
export const buildYesterdayTopics = (ledger, confirmedItems, today, lookbackDays = 2) => {
  const t = normalizeDate(today)
  if (t == null) return []
  const ents = (Array.isArray(ledger) ? ledger : []).filter(e => {
    const d = normalizeDate(e && e.day)
    if (d == null) return false
    const age = daysBetween(d, t)
    return age > 0 && age <= lookbackDays
  })
  if (!ents.length) return []
  const likeOf = c => ({ url: c && c.sourceUrl, tokens: fingerprintTokens([c && c.claim, c && c.quote].filter(Boolean).join(' ')) })
  // 10-03 §12-⑤ 复杂度治理：streak 回看此前每步都对全账本 find（O(回看天数 × 账本条目 × storyMatch)）。
  // 改 day→entries 倒排索引一次建表，每步只 match 当天分桶；同天多条时任一命中即续（与旧行为一致——
  // 旧 find 也是「当天第一条命中的」）。账本 60d 上限内单日几十条时是常数级优化，膨胀后是线性→常数。
  const byDay = new Map()
  for (const e of (Array.isArray(ledger) ? ledger : [])) {
    const d = normalizeDate(e && e.day)
    if (d == null) continue
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push(e)
  }
  // 连续剧计数：该事件在此前账本里连续出现的天数（含本次 day）。从条目自身 day 往前逐天回看
  // + storyMatch 互认（回看起点是 e.day-1——从 t 回看会命中条目自己）。
  const streakOf = e => {
    const eDay = normalizeDate(e && e.day)
    if (eDay == null) return 1
    let streak = 1
    for (let back = 1; back <= LEDGER_KEEP_DAYS; back++) {
      const prevDay = _calendarDayMinus(eDay, back)
      const bucket = byDay.get(prevDay)
      if (!bucket) break
      const prev = bucket.find(x => storyMatch(e, x))
      if (!prev) break
      streak++
    }
    return streak
  }
  return ents.map(e => {
    const hit = (confirmedItems || []).find(c => storyMatch(likeOf(c), e))
    return {
      title: String(e.title || e.url || '').slice(0, 100),
      day: e.day || '', url: e.url || '', major: !!e.major,
      streak: streakOf(e),
      todayUpdate: hit ? String(hit.claim || '').slice(0, 160) : null,
    }
  })
}

// YYYYMMDD 数值减 back 天（纯日历逆推，无 Date——realm 禁 Date；daysBetween 同风格）。
const _calendarDayMinus = (dayNum, back) => {
  const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const dom = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  let y = Math.floor(dayNum / 10000), m = Math.floor(dayNum / 100) % 100, d = dayNum % 100
  d -= back
  while (d < 1) { m -= 1; if (m < 1) { m = 12; y -= 1 } ; d += dom(y, m) }
  return +(y + String(m).padStart(2, '0') + String(d).padStart(2, '0'))
}
