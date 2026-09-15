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
 * @param {{cdpHost?:string}} opts cdpHost 为 127.0.0.1:9222 形式；缺省 → ok:false 不降级
 * @returns {{ok:boolean, degraded:boolean, reason:string, pages:number, topics:number, posts:Array}}
 *   posts 每项 { id, title, url, date, snippet, likeCount }
 * no_cdp_host → ok:false 不降级（调用方选择不启用，板不崩）；其余失败 → ok:false + degraded:true。
 */
export async function fetchLinuxDoNews34({ cdpHost } = {}) {
  const out = { ok: true, degraded: false, reason: '', pages: 0, topics: 0, posts: [] }
  if (!cdpHost) { out.ok = false; out.reason = 'no_cdp_host'; return out }
  try {
    for (let page = 1; page <= CDP_DEFAULTS.maxPages; page++) {
      const raw = await readBodyText(cdpHost, 'https://linux.do/c/news/34.json?page=' + page)
      const topics = extractTopicsFromJson(raw)
      if (!topics || !topics.length) break   // 空页即到底，不再翻
      out.pages++; out.topics += topics.length
      // 首页字段已带 topic excerpt（<200 字）→ 不算深抓；只对最前 perPageDeep 条补深抓正文片段。
      for (const t of topics.slice(0, CDP_DEFAULTS.perPageDeep)) {
        const deep = await deepFetchTopic(cdpHost, t.id)
        const postText = extractPostTextFromJson(deep)
        if (postText) t.snippet = postText.slice(0, 2400)
      }
      out.posts.push(...topics)
    }
    if (out.topics === 0) { out.ok = false; out.degraded = true; out.reason = 'empty_pages' }
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

export const HIGH_VALUE_OUTLINK_RE =
  /https?:\/\/(?:www\.)?(?:github\.com\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*|arxiv\.org\/(?:abs|pdf)\/[0-9.]+|huggingface\.co\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*|(?:[a-zA-Z0-9-]+\.)?(?:openai|anthropic|nvidia|deepmind\.google|techcrunch|theverge|reuters|36kr|qbitai)\.com\/[^\s)\]"']+)/i

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

// 9/01 覆盖韧性：prefetch 已带 snippet，再走 fetch 代理砸 linux.do 是 403/524 弱路径。
// 有非空 snippet 才铸一条对齐 Fetch 产出的 source。
// 若 snippet 中含有 GitHub/arXiv/官网 等权威外链，则自动提权将 claim 挂载至真实外链（sourceUrl / primary）。
// 空 snippet → null，调用方仍把该项交给 fetch 代理（诚实失败，不造空 claim）。
export function mintLinuxdoSource(post, date) {
  if (!post || typeof post !== 'object') return null
  const title = typeof post.title === 'string' ? post.title.trim() : ''
  const url = typeof post.url === 'string' ? post.url.trim() : ''
  const snippet = typeof post.snippet === 'string' ? post.snippet.trim() : ''
  if (!title || !url || !snippet) return null
  const d = (typeof post.date === 'string' && post.date.trim()) ? post.date.trim() : date
  const outlinkMatch = snippet.match(HIGH_VALUE_OUTLINK_RE)
  const targetUrl = outlinkMatch ? outlinkMatch[0] : url
  const quality = outlinkMatch ? 'primary' : 'forum'
  // 提权时 quote 落在权威外链页语义下：剥掉机器追加的「[出链: URL]」后缀（原文已有该 URL 则保留）。
  const quoteBase = outlinkMatch ? snippet.replace(/\s*\[出链:\s*\S+\]\s*$/, '') : snippet
  const quote = quoteBase.slice(0, 220)
  return {
    url, title, found_via: 'linuxdo-cdp', sourceQuality: quality, board: 'linuxdo', date: d,
    claims: [{
      claim: title, quote, importance: 'supporting',
      sourceUrl: targetUrl, sourceTitle: title, sourceQuality: quality, date: d, board: 'linuxdo',
    }],
  }
}
