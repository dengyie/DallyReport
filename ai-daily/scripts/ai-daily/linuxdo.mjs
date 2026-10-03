// ai-daily linux.do 解析层（纯导出零调用、零副作用）——**可 inline 进 workflow realm**。
// 背景（已核实）：Cloudflare cf_clearance 绑定浏览器 TLS 指纹，裸 fetch 必 403，唯一可靠客户端是
// 9222 真 Chrome（登录态）。经 CDP 开启临时标签 → 等 .json 文档在 Chrome 内渲染为 body 文本 → 读回。
//
// 10/03 拆分（realm 死代码治理）：CDP 抓取（fetchLinuxDoNews34）依赖 cdp-core.mjs 的 fetch/WebSocket，
// workflow realm 无这些全局——旧版把整个文件（含 CDP 抓取）inline 进产物，连带 cdp-core 一起塞进 realm
// 死重（realm 永不执行，还让 build 护栏盯不住 process/fetch/WebSocket）。现拆为：
//   - 本文件：纯解析导出（Discourse JSON 解析 + snippet 直铸 + 出链探测），realm 唯一需要的部分；
//   - linuxdo-fetch.mjs：CDP 抓取（fetchLinuxDoNews34），宿主 Node 专用，不进 MODULES。
//
// build.mjs 只能把纯导出 inline 进产物（realm 自包含）；本文件满足约束：无 fs/require/process，
// 无 fetch/WebSocket/AbortSignal 引用。

// --- 轻量解析：从 Discourse JSON 提取 { id, title, url, date, snippet, likeCount, views, replies } ---
// 10/03 对齐参考日报：论坛硬指标（浏览/点赞/回复）随帖流动——mint 带进 claim.heat，report 素材行
// 可引用「社区热度」（措辞不带站名，正文纪律不变）。Discourse 列表字段：like_count/views/posts_count。
export function extractTopicsFromJson(raw) {
  if (!raw) return null
  let obj; try { obj = JSON.parse(String(raw).trim()) } catch { return null }
  if (!obj?.topic_list?.topics?.length) return null
  return obj.topic_list.topics.map(t => ({
    id: t.id, title: t.title, url: 'https://linux.do/t/' + t.id,
    date: t.created_at ? t.created_at.slice(0, 10) : '', snippet: t.excerpt || '', likeCount: t.like_count || 0,
    views: t.views || 0, replies: (t.posts_count || 0) > 0 ? t.posts_count - 1 : 0,
  }))
}

// 权威外链域名表（9/19 L6 补齐：blog/research.google、ai.meta.com、hf.co、mistral/stability 等——
// 含这些出链的帖子在编排层转为真实 fetch 目标，域名表漏网 = 高价值帖降级为普通 forum 直铸）。
export const HIGH_VALUE_OUTLINK_RE =
  /https?:\/\/(?:www\.)?(?:github\.com\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*|arxiv\.org\/(?:abs|pdf)\/[0-9.]+|huggingface\.co\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*|hf\.co\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*|ai\.meta\.com\/[^\s)\]"']+|research\.google\/[^\s)\]"']+|blog\.google\/[^\s)\]"']+|deepmind\.google\/[^\s)\]"']+|(?:[a-zA-Z0-9-]+\.)?google\.com\/[^\s)\]"']+|x\.com\/[^\s)\]"']+|twitter\.com\/[^\s)\]"']+|(?:[a-zA-Z0-9-]+\.)?(?:openai|anthropic|nvidia|techcrunch|theverge|reuters|36kr|qbitai)\.com\/[^\s)\]"']+|(?:[a-zA-Z0-9-]+\.)?(?:mistral|stability)\.ai\/[^\s)\]"']+)/i

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
// date 参数是显式回退值；调用方传 '' 表示「无日期就留空」（9/19 review：不再伪造调用日）。
export function mintLinuxdoSource(post, date) {
  if (!post || typeof post !== 'object') return null
  const title = typeof post.title === 'string' ? post.title.trim() : ''
  const url = typeof post.url === 'string' ? post.url.trim() : ''
  const snippet = typeof post.snippet === 'string' ? post.snippet.trim() : ''
  if (!title || !url || !snippet) return null
  const d = (typeof post.date === 'string' && post.date.trim()) ? post.date.trim() : date
  const quote = snippet.slice(0, 220)
  // 09-20：claim=title 只剩标题级新闻（ZCode .git 上传）。claim 取正文首句，quote 仍是可溯源 snippet。
  const firstSent = snippet.split(/[。！？\n]/)[0].replace(/\s+/g, ' ').trim()
  const fromBody = firstSent.slice(0, 80)
  const claim = fromBody.length >= 8 ? fromBody : title
  // 10/03 对齐参考日报：论坛硬指标（浏览/赞/回复）随 claim 流动 → report 素材行「社区热度」。
  // 全 0 的帖不产 heat（无热度信息不装作有）。
  const heat = (post.likeCount || post.views || post.replies)
    ? { likes: post.likeCount || 0, views: post.views || 0, replies: post.replies || 0 }
    : undefined
  return {
    url, title, found_via: 'linuxdo-cdp', sourceQuality: 'forum', board: 'linuxdo', date: d,
    claims: [{
      claim, quote, importance: 'supporting',
      sourceUrl: url, sourceTitle: title, sourceQuality: 'forum', date: d, board: 'linuxdo',
      ...(heat ? { heat } : {}),
    }],
  }
}
