// ai-daily linux.do 登录态抓取（2026-08-23 第二十一项 §A）——纯导出零调用模块，自身零副作用。
// 背景（已核实）：Cloudflare cf_clearance 绑定浏览器 TLS 指纹，裸 fetch 必 403，唯一可靠客户端是
// 9222 真 Chrome（登录态）。经 CDP 开启临时标签 → 等 .json 文档在 Chrome 内渲染为 body 文本 → 读回。
// 两条路径都覆盖：环境已有 globalThis.WebSocket（Node v26 是 function）→ 真 WebSocket 走
// Runtime.evaluate 轮询 body.innerText；无 WebSocket 全局（workflow realm 降级保险）→ CDP HTTP-only
// polling（每片轮询等价于"关旧标签+开新标签+读 body"的幂等快照）。
// 不启动任何进程；fetch/AbortSignal/setTimeout/WebSocket 都是环境已有全局，直接引用。
// build.mjs 只能把纯 float/纯导出 inline 进产物（workflow realm 自包含），本文件满足该约束。

export const CDP_DEFAULTS = {
  cdpHost: '127.0.0.1:9222',
  maxPages: 4,          // news/34.json 分页安全上限（多为 1-3 页）
  perPageDeep: 3,       // 每页首页 JSON 字段已带 1 段文本摘要，topic 深抓仅少量(3)
  requestTimeoutMs: 15000,
  pollIntervalMs: 500,
  pollMaxMs: 15000,
}

// 判断当前环境是否有真 WebSocket（Node v26 全局即 function；workflow realm 无 → HTTP polling 保险路径）。
const hasW = () => (typeof globalThis !== 'undefined' && 'WebSocket' in globalThis) || typeof WebSocket === 'function'

// CDP HTTP：开标签 → 读 body 文本 → 关标签。
// 真 WebSocket：Runtime.evaluate 轮询 body.innerText（复用用户另一生成器的 polling 形态）。
// 无 WebSocket（workflow realm）：CDP HTTP-only polling——每片轮询都等价于"关旧标签+开新标签+读 body"的幂等快照。
// 关闭 CDP 临时标签（浏览器 tab，非仅 debugger Socket）——WS 路径必须补这步，否则每个被抓 URL 都泄漏一个标签到用户 9222 Chrome。
async function closeTab(host, targetId) {
  try { await fetch(`http://${host}/json/close/${targetId}`, { method: 'PUT', signal: AbortSignal.timeout(3000) }) } catch {}
}

async function readBodyText(host, url) {
  const res = await fetch(`http://${host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(CDP_DEFAULTS.requestTimeoutMs) })
  // 8/23 复核修复：/json/new 非 2xx 时 target 未建立、无标签可关，直接 throw（无泄漏，无需 closeTab）。
  if (!res.ok) throw new Error('open-tab HTTP ' + res.status)
  // 8/23 复核边界说明（pre-existing 不可达路径，非本修复缺口）：CDP 对 200 必回含 id 的 target JSON，
  // 故 target.id 解析失败/缺失只存在于理论中——若真发生，该 tab 将无法定位关闭（拿不到 id 就关不掉）。
  // 同理 json/new 请求被 AbortSignal 中断时服务端可能已建 tab 而客户端拿不到 targetId。两者均被
  // try 前抛错/退出路径挡在"已建 tab 且拿得到 id"之外，其余任何路径下方的 finally 一概兜住。
  const target = await res.json()
  const targetId = target.id
  try {
    const wsUrl = target.webSocketDebuggerUrl
    let text = null
    if (hasW()) {
      // 真 WebSocket：轮询内文取 JSON。
      const ws = new WebSocket(wsUrl)
      await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => { ws.close(); no(new Error('ws open')) } })
      let n = 0; const pend = new Map()
      ws.onmessage = e => { const v = JSON.parse(e.data); if (v.id && pend.has(v.id)) { pend.get(v.id)(v); pend.delete(v.id) } }
      const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++n
        pend.set(id, res)
        ws.send(JSON.stringify({ id, method, params }))
        // 超时防挂起：CDP 不回匹配 id 的消息时 reject + 清理 pend（挂起会卡住 readBodyText、finally 不触发）
        setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('cdp send timeout: ' + method)) } }, CDP_DEFAULTS.requestTimeoutMs)
      })
      await send('Runtime.enable')
      for (let i = 0; i < Math.ceil(CDP_DEFAULTS.pollMaxMs / CDP_DEFAULTS.pollIntervalMs); i++) {
        const { result } = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : null', returnByValue: true })
        const v = result?.result?.value
        if (v && String(v).trimStart().startsWith('{')) { text = v; break }
        await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
      }
      ws.close()
    } else {
      // 无 WebSocket 全局（workflow realm）：CDP HTTP-only polling — 每片轮询都等价于
      // "关旧标签+开新标签+读 body"的幂等快照。
      await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
      for (let i = 0; i < Math.ceil(CDP_DEFAULTS.pollMaxMs / CDP_DEFAULTS.pollIntervalMs); i++) {
        try {
          const r2 = await fetch(`http://${host}/json/${targetId}`, { signal: AbortSignal.timeout(3000) })
          if (r2.ok) { const j = await r2.json(); if (j.innerText) { text = j.innerText; break } }
        } catch { /* poll */ }
        await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
      }
    }
    return text && String(text).trimStart().startsWith('{') ? text : null
  } finally {
    // 8/23 复核修复：唯一关闭点用 finally 收敛 —— WS open 失败 / 中途抛错 / send 挂起超时被
    // withDeadline 化前（workflow 召唤层）都能兜到底。只关本函数 json/new 自己开的 targetId，
    // 绝不误关用户其它标签；关失败 try/catch 吞掉（标签已读完，关不上不影响抓取结果）。
    await closeTab(host, targetId)
  }
}

// 深抓单帖：GET https://linux.do/t/<id>.json 官方 JSON 接口（JSON 文档在 Chrome 内直接渲染为文本）。
async function deepFetchTopic(host, id) {
  return readBodyText(host, 'https://linux.do/t/' + id + '.json')
}

/**
 * 抓取 linux.do 前沿快讯（news/34）分页，返回 posts。CDP 走 9222 登录态 Chrome。
 * @param {{date?:string, cdpHost?:string}} opts date 为可空方言（抓取本身不强依赖日期窗口，只取最新分页）
 * @returns {{ok:boolean, degraded:boolean, reason:string, pages:number, topics:number, posts:Array}}
 *   posts 每项 { id, title, url, date, snippet, likeCount }
 * no_cdp_host → ok:false 不降级（调用方选择不启用，板不崩）；其余失败 → ok:false + degraded:true。
 */
export async function fetchLinuxDoNews34({ date, cdpHost }) {
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
    id: t.id, title: t.title, url: 'https://linux.do/t/topic/' + t.id,
    date: t.created_at ? t.created_at.slice(0, 10) : '', snippet: t.excerpt || '', likeCount: t.like_count || 0,
  }))
}

export function extractPostTextFromJson(raw) {
  if (!raw) return null
  let obj; try { obj = JSON.parse(String(raw).trim()) } catch { return null }
  const c = obj?.post_stream?.posts
  const rawStr = c && c[0]?.cooked ? String(c[0].cooked).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return rawStr || null
}
