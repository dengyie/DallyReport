// ai-daily linux.do 登录态 CDP 抓取（宿主 Node 专用，2026-10-03 从 linuxdo.mjs 拆出）。
//
// 为什么拆：fetchLinuxDoNews34 依赖 CDP 传输层（cdp-core.mjs 的 readBodyText → fetch/WebSocket），
// 而 workflow realm 无 fetch/WebSocket/process 全局。旧版把整个 linuxdo.mjs（含本函数）inline 进产物，
// 连带 cdp-core.mjs 一起 inline——产物里塞进 realm 永远不会执行的 CDP 代码（死重 + 护栏盲区）。
// 拆分后：realm 只需 linuxdo.mjs 的纯解析导出（extractTopicsFromJson/extractPostTextFromJson/
// extractHighValueOutlink/mintLinuxdoSource/HIGH_VALUE_OUTLINK_RE），CDP 传输层（本文件 + cdp-core.mjs）
// 只活在宿主 Node（linuxdo-prefetch.mjs 预抓 CLI 消费）。
//
// 纪律（8/26 起、不变）：不启动任何浏览器进程；只对已运行在 127.0.0.1:9222 的现有 Chrome 发 CDP。
// 本文件不加入 build.mjs MODULES。

import { CDP_DEFAULTS, readBodyText } from './cdp-core.mjs'
import { extractTopicsFromJson, extractPostTextFromJson } from './linuxdo.mjs'

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
