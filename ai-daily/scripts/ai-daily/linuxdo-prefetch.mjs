// ai-daily linux.do Node prefetch 隔离层（Task 2，2026-08-27）。
//
// 定位：把「linux.do 登录态 CDP 抓取」从 Workflow realm 移到宿主 Node 进程（CLI 前置），
// 与既有 linuxdo.mjs 完全复用——本文件不复制任何 CDP 协议实现，只 re-export
// fetchLinuxDoNews34 并包一层 CLI 参数解析 + 可序列化成功 JSON 输出。
//
// 隔离收益：
//   - 「不启动 Chrome、不关闭用户 Chrome」：本脚本只对已运行在 127.0.0.1:9222 的现有 Chrome
//     发 CDP /json/new + /json/close（临时标签的开/关仍由 linuxdo.mjs readBodyText 的 finally
//     收敛负责）。脚本自身不 spawn 任何浏览器进程。
//   - 出错即非零退出 + stderr 诊断，绝不把错误文本当成功 JSON 写 stdout：
//     调用方（run-daily.sh）只认「exit 0 且 stdout 是合法 JSON」为成功。
//
// 注意：本文件不加入 build.mjs MODULES（不进 .claude/workflows/ai-daily.js），它只在宿主 Node
// 运行、不在 workflow realm 内——workflow realm 无 fetch/WebSocket/fs/process/require。

import { fetchLinuxDoNews34 } from './linuxdo.mjs'
import { CDP_DEFAULTS } from './cdp-core.mjs'
import { isCliMain } from './cli-main.mjs'

/** 默认 cdp host（与 linuxdo.mjs CDP_DEFAULTS.cdpHost 一致）。 */
export const DEFAULT_CDP_HOST = CDP_DEFAULTS.cdpHost

/** 默认 --max-sources 交付上限：prefetch 交付给 Workflow 的候选 buffer（Workflow 侧消费配额另设
 * linuxdoMaxSources=8，且会再做窗口过滤——交付量 > 消费量是有意冗余，供窗口过滤后仍有得选）。 */
export const DEFAULT_MAX_SOURCES = 8

/** 深抓条数上限（9/19 L3 深抓后置）：只对噪声过滤+质量排序（likeCount desc, date desc）后的前 N 帖
 * 做单帖 .json 深抓（富化正文 + 探测权威出链）。列表读 ≤maxPages 次 + 深抓 ≤N 次，全部花在入选帖上。 */
export const DEFAULT_DEEP_FETCH = 12

/** 09-13 预抓噪声：空 snippet 铸不进 mint；重置/羊毛/喜报/蹬完/买号/拼车/代充等标题核查会 0-2。 */
// 账号交易形态：动词后可隔 0-14 字再接「号/账号」（「收Google账号」「出ChatGPT Plus 账号」隔字/带英文不漏）。
// 与 DallyReport/src/snippet-hygiene.mjs 的 NEGATIVE_COMMUNITY_RE 账号交易段同源（linuxdo 侧多论坛热词）。
export const LINUXDO_NOISE_TITLE =
  /(?:出|收|买|卖|求购|出售|转让).{0,14}(?:号|账号)|(?:号|账号).{0,4}(?:出|收|买|卖)|\b\d+出\b|求车|人找车|车找人|车位|拼车|合租|代充|余额|挂号|抽奖|降智|封号|被封|土区|日区|美区|里拉|阿根廷|美运|低价订阅|怎么买|接码|退款|额度重置|鉴别渠道|收鸡|出鸡|溢价|邀请码|纯手工|黑五|秒杀|中转站|注册送|求个.*车|本质是个快捷方式|勇闯|重置|羊毛|喜报|蹬完|免费领|reset/i

/**
 * 过滤预抓帖：丢空摘要、图片元数据、噪声交易标题，再按 maxSources 截断。
 * 全噪声时返回 []，由 prefetchLinuxDo 当 empty_posts 失败（诚实降级，不把羊毛当新闻）。
 */
export function filterLinuxdoPosts(posts, maxSources = DEFAULT_MAX_SOURCES) {
  const cap = typeof maxSources === 'number' && maxSources > 0 ? maxSources : DEFAULT_MAX_SOURCES
  const kept = []
  for (const p of posts || []) {
    const snip = String(p && p.snippet || '').trim()
    if (!snip) continue
    // 过滤纯图片附件/元数据（如 "1000010515.jpg ... 97.4 KB"）
    if (/^[\s\d_.-]+\.(jpg|jpeg|png|webp|gif)/i.test(snip)) continue
    if (LINUXDO_NOISE_TITLE.test(String(p.title || ''))) continue
    kept.push(p)
    if (kept.length >= cap) break
  }
  return kept
}

/**
 * 解析 CLI 参数。未知参数/非法值 → throw（main 里 catch 后以非零退出）。
 * @param {string[]} argv e.g. process.argv.slice(2)
 * @returns {{ host: string, maxSources: number, help?: boolean }}
 */
export function parseArgs(argv) {
  const out = { host: DEFAULT_CDP_HOST, maxSources: DEFAULT_MAX_SOURCES }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--host') {
      if (i + 1 >= argv.length) throw new Error('--host 缺参数值')
      out.host = argv[i + 1]; i += 1
    } else if (a === '--max-sources') {
      if (i + 1 >= argv.length) throw new Error('--max-sources 缺参数值')
      const n = Number(argv[i + 1])
      if (!Number.isInteger(n) || n <= 0) throw new Error('--max-sources 必须为正整数')
      out.maxSources = n; i += 1
    } else if (a === '--deep-fetch') {
      if (i + 1 >= argv.length) throw new Error('--deep-fetch 缺参数值')
      const n = Number(argv[i + 1])
      if (!Number.isInteger(n) || n < 0) throw new Error('--deep-fetch 必须为非负整数')
      out.deepFetch = n; i += 1
    } else if (a === '--help' || a === '-h') {
      out.help = true
    } else {
      throw new Error('未知参数 ' + a)
    }
  }
  return out
}

/**
 * 预抓 linux.do 前沿快讯并返回可序列化成功 JSON。
 * @param {{host?: string, maxSources?: number}} opts
 * @returns {Promise<{ok: true, topics: number, posts: Array}>} 可序列化成功目标。
 *   失败/抓取不成功 → throw（携带原 linuxdoResult），调用方负责 stderr 诊断 + 非零退出。
 */
export async function prefetchLinuxDo(opts = {}) {
  const host = opts.host || DEFAULT_CDP_HOST
  const maxSources = typeof opts.maxSources === 'number' && opts.maxSources > 0 ? opts.maxSources : DEFAULT_MAX_SOURCES
  const deepFetch = typeof opts.deepFetch === 'number' && opts.deepFetch >= 0 ? opts.deepFetch : DEFAULT_DEEP_FETCH
  // 复用 fetchLinuxDoNews34（CDP 抓取 + 全部协议逻辑），不复制 transport。
  // 9/19 L1/L3：噪声过滤与质量排序移入 fetchLinuxDoNews34（列表读→过滤→排序→深抓后置），
  // 深抓只花在「过滤后按赞数/新度排名前 deepFetch」的入选帖上；正则真源仍在本文件（isNoise 回调注入）。
  const ld = await fetchLinuxDoNews34({
    cdpHost: host,
    deepFetch,
    isNoise: t => LINUXDO_NOISE_TITLE.test(String(t && t.title || '')),
  })
  if (!ld.ok || !ld.posts || !ld.posts.length) {
    // 不把失败当成功 JSON 输出：抛错（携带原因），CLI 层打印 stderr。
    const e = new Error('linuxdo-prefetch 未成功: ' + (ld.reason || 'empty_posts'))
    e.linuxdoResult = ld
    throw e
  }
  // 可序列化成功形状：posts（已过滤排序；再按 maxSources 截断 + 图片元数据兜底过滤）+ 元信息。
  const mapped = (ld.posts || []).map(p => ({
    id: p.id, title: p.title, url: p.url, date: p.date || '', snippet: p.snippet || '', likeCount: p.likeCount || 0,
  }))
  const posts = filterLinuxdoPosts(mapped, maxSources)
  if (!posts.length) {
    const e = new Error('linuxdo-prefetch 未成功: empty_posts')
    e.linuxdoResult = { ok: false, reason: 'empty_posts', topics: ld.topics || 0 }
    throw e
  }
  return {
    ok: true,
    host,
    topics: ld.topics || 0,
    posts,
  }
}

/** 执行预抓并把成功结果序列化为 JSON 文本。失败 → throw。 */
export async function runPrefetch(opts = {}) {
  const result = await prefetchLinuxDo(opts)
  return { ok: true, output: JSON.stringify(result, null, 1) }
}

/** Node CLI 入口：成功 → stdout 打印 JSON；失败 → stderr 诊断 + 非零退出。绝不把错误文本当成功 JSON。 */
export async function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (e) {
    process.stderr.write('linuxdo-prefetch: 参数错误: ' + e.message + '\n')
    process.exit(1)
  }
  if (parsed.help) {
    process.stdout.write('linuxdo-prefetch: 从 9222 登录态 Chrome 预抓 linux.do 前沿快讯。\n用法: node linuxdo-prefetch.mjs [--host 127.0.0.1:9222] [--max-sources 24] [--deep-fetch 12]\n--max-sources 是交付上限（交付 buffer，run-daily 传 24）；Workflow 消费配额 linuxdoMaxSources=8 另设。\n--deep-fetch 是质量排序后深抓的帖子数上限（默认 12）。\n')
    return
  }
  try {
    const { output } = await runPrefetch({ host: parsed.host, maxSources: parsed.maxSources, deepFetch: parsed.deepFetch })
    process.stdout.write(output)
  } catch (e) {
    const diag = (e && e.linuxdoResult && e.linuxdoResult.reason) ? e.linuxdoResult.reason : (e && e.message || e)
    process.stderr.write('linuxdo-prefetch: 失败: ' + String(diag).slice(0, 200) + '\n')
    process.exit(1)
  }
}

// 仅在作为脚本直接执行时运行 main（被 import 时不跑，测试可 import 接口）。
// argv[1] 可能是相对路径，必须走 isCliMain（path.resolve + pathToFileURL），
// 裸 `file://` + argv[1] 会对不上 import.meta.url → 静默 no-op。
if (isCliMain(import.meta.url, process.argv[1])) { main(process.argv.slice(2)) }