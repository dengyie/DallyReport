// ai-daily linux.do 登录态抓取（2026-08-23 第二十一项 §A）——纯导出零调用模块，自身零副作用。
// 背景（已核实）：Cloudflare cf_clearance 绑定浏览器 TLS 指纹，裸 fetch 必 403，唯一可靠客户端是
// 9222 真 Chrome（登录态）。经 CDP 开启临时标签 → 等 .json 文档在 Chrome 内渲染为 body 文本 → 读回。
//
// 9/13 重构：CDP 协议层（closeTab/readBodyText/CDP_DEFAULTS）抽到 cdp-core.mjs（与新增宿主 CLI
// cdp-fetch.mjs 共享）；本文件只保留 linux.do 域逻辑——Discourse JSON 解析、分页遍历、snippet 直铸。
// export CDP_DEFAULTS 移至 cdp-core.mjs（linuxdo.test/linuxdo-prefetch 的 import 同步改指 cdp-core）。
//
// build.mjs 只能把纯导出 inline 进产物（workflow realm 自包含）；CDP 层经 import 在 inline 后可用。
// 本文件满足约束：无 fs/require/process；fetch/AbortSignal/setTimeout/WebSocket 引用环境全局。

import { CDP_DEFAULTS, readBodyText } from './cdp-core.mjs'

// 深抓单帖：GET https://linux.do/t/<id>.json 官方 JSON 接口（JSON 文档在 Chrome 内直接渲染为文本）。
async function deepFetchTopic(host, id) {
  return readBodyText(host, 'https://linux.do/t/' + id + '.json')
}

/**
 * 抓取 linux.do 前沿快讯（news/34）分页，返回 posts。CDP 走 9222 登录态 Chrome。
 * 9/19 重构（L1/L3 根因修复——深抓先于过滤、16 次串行 CDP 只产 8 条）：
 *   ① 先只读列表页（1 次/页）收齐全部 topic（like_count/date/excerpt 都在列表字段里）；
 *   ② 噪声过滤（isNoise 回调，正则真源在 linuxdo-prefetch）→ 按 likeCount desc + date desc 排序；
 *   ③ 只对排序后前 deepFetch 条做深抓（单帖 .json 读正文 + 探测权威出链）——深抓花在入选帖上，
 *     不再是"每页前 3 条"的活跃序盲抓；深抓与列表读合计 ≤ maxPages + deepFetch 次。
 * @param {{cdpHost?:string, isNoise?:(t:object)=>boolean, deepFetch?:number}} opts
 *   cdpHost 为 127.0.0.1:9222 形式；缺省 → ok:false 不降级。isNoise 缺省不过滤；deepFetch 缺省 0。
 * @returns {{ok:boolean, degraded:boolean, reason:string, pages:number, topics:number, posts:Array}}
 *   posts = 过滤排序后的数组（深抓条目已富化 snippet），每项 { id, title, url, date, snippet, likeCount }
 * no_cdp_host → ok:false 不降级（调用方选择不启用，板不崩）；其余失败 → ok:false + degraded:true。
 */
export async function fetchLinuxDoNews34({ cdpHost, isNoise, deepFetch = 0 } = {}) {
  const out = { ok: true, degraded: false, reason: '', pages: 0, topics: 0, posts: [] }
  if (!cdpHost) { out.ok = false; out.reason = 'no_cdp_host'; return out }
  try {
    const all = []
    for (let page = 1; page <= CDP_DEFAULTS.maxPages; page++) {
      const raw = await readBodyText(cdpHost, 'https://linux.do/c/news/34.json?page=' + page)
      const topics = extractTopicsFromJson(raw)
      if (!topics || !topics.length) break   // 空页即到底，不再翻
      out.pages++; out.topics += topics.length
      all.push(...topics)
    }
    if (out.topics === 0) { out.ok = false; out.degraded = true; out.reason = 'empty_pages'; return out }
    // 噪声过滤（回调注入，保持本模块与正则真源解耦）→ 质量排序（赞数优先、新帖次优先）。
    const kept = typeof isNoise === 'function' ? all.filter(t => !isNoise(t)) : all
    kept.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0) || String(b.date || '').localeCompare(String(a.date || '')))
    // 深抓后置：只富化排序后前 deepFetch 条（正文片段 + 权威出链探测）。
    for (const t of kept.slice(0, Math.max(0, deepFetch))) {
      const deep = await deepFetchTopic(cdpHost, t.id)
      const postText = extractPostTextFromJson(deep)
      if (postText) t.snippet = postText.slice(0, 2400)
    }
    out.posts = kept
  } catch (e) {
    out.ok = false; out.degraded = true; out.reason = String(e && e.message || e).slice(0, 120)
  }
  return out
}

// --- 轻量解析：从 Discourse JSON 提取 { id, title, url, date, snippet, likes } ---
export function extractTopicsFromJson(raw) {
  if (!raw) return null
  let obj; try { obj = JSON.parse(String(raw).trim()) } catch { return null }
  if (!obj?.topic_list?.topics?.length) return null
  return obj.topic_list.topics.map(t => ({
    id: t.id, title: t.title, url: 'https://linux.do/t/' + t.id,
    date: t.created_at ? t.created_at.slice(0, 10) : '', snippet: t.excerpt || '', likeCount: t.like_count || 0,
  }))
}

// 权威外链域名表（9/19 L6 补齐：blog/research.google、ai.meta.com、hf.co、mistral/stability 等——
// 含这些出链的帖子在编排层转为真实 fetch 目标，域名表漏网 = 高价值帖降级为普通 forum 直铸）。
export const HIGH_VALUE_OUTLINK_RE =
  /https?:\/\/(?:www\.)?(?:github\.com\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*|arxiv\.org\/(?:abs|pdf)\/[0-9.]+|huggingface\.co\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*|hf\.co\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*|ai\.meta\.com\/[^\s)\]"']+|research\.google\/[^\s)\]"']+|blog\.google\/[^\s)\]"']+|deepmind\.google\/[^\s)\]"']+|(?:[a-zA-Z0-9-]+\.)?google\.com\/[^\s)\]"']+|(?:[a-zA-Z0-9-]+\.)?(?:openai|anthropic|nvidia|techcrunch|theverge|reuters|36kr|qbitai)\.com\/[^\s)\]"']+|(?:[a-zA-Z0-9-]+\.)?(?:mistral|stability)\.ai\/[^\s)\]"']+)/i

export function extractPostTextFromJson(raw) {
  if (!raw) return null
  let obj; try { obj = JSON.parse(String(raw).trim()) } catch { return null }
  const c = obj?.post_stream?.posts
  const cooked = c && c[0]?.cooked ? String(c[0].cooked) : ''
  if (!cooked) return null
  const m = cooked.match(HIGH_VALUE_OUTLINK_RE)
  const rawStr = cooked.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!rawStr) return null
  if (m && !rawStr.includes(m[0])) {
    return `${rawStr} [出链: ${m[0]}]`
  }
  return rawStr
}

// 9/19 F7 根因修复：mint 不再「提权」。旧版 snippet 含 GitHub/arXiv/官网外链就把 claim 标 primary、
// sourceUrl 指向外链页——但外链页正文从未被任何人抓取，verify 的「惊人声明需一手源」被假 primary
// 骗过、引用角标落在没人读过的页面（引用造假）。新语义：
//   - extractHighValueOutlink(post.snippet) 命中 → 编排层把**外链 URL**转为真实 fetch 目标（公开页，
//     9222/WebFetch 均可抓），claim 只能落在被真实读过的权威页上；
//   - 未命中 → mint forum 质量直铸（snippet 是真实读到的帖子文本，来源=帖子本页，语义诚实）。
export function extractHighValueOutlink(snippet) {
  const m = String(snippet || '').match(HIGH_VALUE_OUTLINK_RE)
  return m ? m[0] : null
}

// 直铸 forum 源：snippet 是登录态 CDP 实际读到的帖子文本 → claim/quote 同源、可核查。
// 出链帖不走本函数（编排层已转 fetch 目标）；空 snippet → null，调用方丢弃（不再喂给必 403 的 fetch）。
export function mintLinuxdoSource(post, date) {
  if (!post || typeof post !== 'object') return null
  const title = typeof post.title === 'string' ? post.title.trim() : ''
  const url = typeof post.url === 'string' ? post.url.trim() : ''
  const snippet = typeof post.snippet === 'string' ? post.snippet.trim() : ''
  if (!title || !url || !snippet) return null
  const d = (typeof post.date === 'string' && post.date.trim()) ? post.date.trim() : date
  const quote = snippet.slice(0, 220)
  return {
    url, title, found_via: 'linuxdo-cdp', sourceQuality: 'forum', board: 'linuxdo', date: d,
    claims: [{
      claim: title, quote, importance: 'supporting',
      sourceUrl: url, sourceTitle: title, sourceQuality: 'forum', date: d, board: 'linuxdo',
    }],
  }
}
