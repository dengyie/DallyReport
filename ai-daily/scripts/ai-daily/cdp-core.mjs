// ai-daily CDP 核心层（9/13 从 linuxdo.mjs 抽出）——「经 9222 已运行 Chrome 开临时标签读正文」的唯一实现。
// 消费方：linuxdo.mjs（linux.do Discourse JSON 专用，JSON-only 过滤）与 cdp-fetch.mjs（宿主 CLI，
// fetch 子代理经 Bash 调用，通用文章页正文）。
//
// 纪律（8/26 起、不变）：
//   - 不启动任何浏览器进程；只对已运行在 127.0.0.1:9222 的现有 Chrome 发 CDP /json/new + /json/close。
//   - 只关本函数 json/new 自己开的 targetId（try/finally 收敛），绝不误关用户其它标签、绝不关浏览器本体。
//   - 两条读取路径：环境已有 WebSocket（Node v26）→ Runtime.evaluate 轮询 body.innerText；
//     无 WebSocket（workflow realm 保险路径）→ CDP HTTP-only polling。
//   - realm 可 inline（无 fs/require/process；fetch/AbortSignal/setTimeout/WebSocket 引用环境全局）。

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
// 无 WebSocket（workflow realm）：CDP HTTP-only polling——历史保险路径，现代 Chrome 的 target 元数据无
// innerText 字段、实际读不到正文（realm 已禁裸抓，勿依赖；详见 readBodyTextRaw 内注记）。
// 关闭 CDP 临时标签（浏览器 tab，非仅 debugger Socket）——WS 路径必须补这步，否则每个被抓 URL 都泄漏一个标签到用户 9222 Chrome。
// 9/19 C6：关失败不再全静默——stderr 一行诊断（不影响抓取结果与退出码），泄漏可查。
async function closeTab(host, targetId) {
  try {
    await fetch(`http://${host}/json/close/${targetId}`, { method: 'PUT', signal: AbortSignal.timeout(3000) })
  } catch (e) {
    if (typeof process !== 'undefined' && process.stderr && typeof process.stderr.write === 'function') {
      try { process.stderr.write('cdp-core: close-tab 失败 ' + targetId + ': ' + String(e && e.message || e).slice(0, 80) + '\n') } catch { /* 诊断本身失败则真吞 */ }
    }
  }
}

// 原始正文读取：返回页面 body.innerText（任意内容；空/失败 → null）。9/13 从 readBodyText 拆出——
// 旧版只接受 `{` 开头文本（Discourse .json 专用），通用文章页会被误判 null。
export async function readBodyTextRaw(host, url) {
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
      // 真 WebSocket：轮询内文。9/19 C1：open 等待加超时——旧版 onopen 无 timeout，Chrome 假死
      // （TCP 未断但永不回调）会让 readBodyTextRaw 永久挂起、锁被陈旧回收后并发超发。
      const ws = new WebSocket(wsUrl)
      await new Promise((ok, no) => {
        const to = setTimeout(() => { try { ws.close() } catch { /* already closing */ } no(new Error('ws open timeout')) }, CDP_DEFAULTS.requestTimeoutMs)
        ws.onopen = () => { clearTimeout(to); ok() }
        ws.onerror = () => { clearTimeout(to); try { ws.close() } catch { /* already closing */ } no(new Error('ws open')) }
      })
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
        if (v && String(v).trim()) { text = v; break }
        await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
      }
      ws.close()
    } else {
      // 无 WebSocket 全局（workflow realm）：CDP HTTP-only polling。
      // ⚠️ 历史保险路径（9/19 C5 注记）：现代 Chrome 的 /json/<targetId> target 元数据**没有** innerText
      // 字段——本路径实际读不到正文（j.innerText 恒 undefined）。realm 已被 build 护栏禁止裸抓 CDP
      // （build.mjs FORBIDDEN_INLINE），此分支仅余理论价值，勿依赖；如需恢复 realm 抓取必须重设计。
      await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
      for (let i = 0; i < Math.ceil(CDP_DEFAULTS.pollMaxMs / CDP_DEFAULTS.pollIntervalMs); i++) {
        try {
          const r2 = await fetch(`http://${host}/json/${targetId}`, { signal: AbortSignal.timeout(3000) })
          if (r2.ok) { const j = await r2.json(); if (j.innerText) { text = j.innerText; break } }
        } catch { /* poll */ }
        await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
      }
    }
    return text && String(text).trim() ? String(text) : null
  } finally {
    // 8/23 复核修复：唯一关闭点用 finally 收敛 —— WS open 失败 / 中途抛错 / send 挂起超时被
    // withDeadline 化前（workflow 召唤层）都能兜到底。只关本函数 json/new 自己开的 targetId，
    // 绝不误关用户其它标签；关失败 try/catch 吞掉（标签已读完，关不上不影响抓取结果）。
    await closeTab(host, targetId)
  }
}

// linux.do Discourse JSON 专用：只接受 `{` 开头文本（.json 端点在 Chrome 内渲染为纯 JSON 文本）。
export async function readBodyText(host, url) {
  const text = await readBodyTextRaw(host, url)
  return text && String(text).trimStart().startsWith('{') ? text : null
}
