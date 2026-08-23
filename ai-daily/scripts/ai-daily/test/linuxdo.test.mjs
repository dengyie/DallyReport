import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CDP_DEFAULTS, extractTopicsFromJson, extractPostTextFromJson, fetchLinuxDoNews34 } from '../linuxdo.mjs'

const newsJson = JSON.stringify({
  topic_list: { topics: [
    { id: 100001, title: 'DeepSeek V4-Pro 发布', created_at: '2026-08-23T04:12:00.000Z', excerpt: '官方正式版上线，Agent 能力增强。', like_count: 42 },
    { id: 100002, title: 'Gemini 新能力讨论', created_at: '2026-08-22T09:00:00.000Z', excerpt: '', like_count: 0 },
  ] },
})

test('extractTopicsFromJson：标准 Discourse 列表 → {id,title,url,date,snippet,likeCount}', () => {
  const ts = extractTopicsFromJson(newsJson)
  assert.equal(ts.length, 2)
  assert.deepEqual(ts[0], {
    id: 100001, title: 'DeepSeek V4-Pro 发布', url: 'https://linux.do/t/topic/100001',
    date: '2026-08-23', snippet: '官方正式版上线，Agent 能力增强。', likeCount: 42,
  })
  assert.equal(ts[1].likeCount, 0, '缺 like_count 默认 0')
  assert.equal(ts[1].snippet, '', '缺 excerpt 默认空')
})

test('extractTopicsFromJson：容错——非 JSON / 空结构 / null → null', () => {
  assert.equal(extractTopicsFromJson(null), null)
  assert.equal(extractTopicsFromJson(''), null)
  assert.equal(extractTopicsFromJson('<html>challenge page</html>'), null, 'Cloudflare challenge 不是 JSON → null')
  assert.equal(extractTopicsFromJson('{"topic_list":{}}'), null, '无 topics → null')
  assert.equal(extractTopicsFromJson('{"topic_list":{"topics":[]}}'), null, '空 topics → null')
})

test('extractPostTextFromJson：Discourse 帖子 → 去 HTML 后纯文本（剥离标签、压空白）', () => {
  const raw = JSON.stringify({ post_stream: { posts: [
    { cooked: '<p>DeepSeek V4-Pro 正式上线，<b>Agent 能力</b>增强，支持分时段定价。</p><p>第二段  </p>' },
    { cooked: '<p>第二楼的回复。</p>' },
  ] } })
  const text = extractPostTextFromJson(raw)
  assert.ok(text.includes('DeepSeek V4-Pro 正式上线'))
  assert.ok(text.includes('Agent 能力'), '保留内联文本')
  assert.ok(!text.includes('<'), 'HTML 标签被剥离')
  assert.ok(!text.includes('第二楼'), '只取首帖（post_stream.posts[0]）')
})

test('extractPostTextFromJson：容错——非 JSON / 无 cooked → null', () => {
  assert.equal(extractPostTextFromJson('not json'), null)
  assert.equal(extractPostTextFromJson('{"post_stream":{}}'), null)
  assert.equal(extractPostTextFromJson('{"post_stream":{"posts":[{"cooked":""}]}}'), null, '空 cooked → null')
})

test('fetchLinuxDoNews34：无 cdpHost → ok:false + reason no_cdp_host，不降级、零副作用', async () => {
  const out = await fetchLinuxDoNews34({ date: '2026-08-23', cdpHost: null })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no_cdp_host')
  assert.equal(out.degraded, false, '未启用不算通道失败（CLI/手动默认不启用时板不崩）')
  assert.equal(out.posts.length, 0)
  assert.equal(out.pages, 0)
  assert.equal(out.topics, 0)
})

test('CDP_DEFAULTS：默认值符合 spec（host/maxPages/perPageDeep/poll 参数）', () => {
  assert.equal(CDP_DEFAULTS.cdpHost, '127.0.0.1:9222')
  assert.equal(CDP_DEFAULTS.maxPages, 4)
  assert.equal(CDP_DEFAULTS.perPageDeep, 3)
  assert.equal(CDP_DEFAULTS.requestTimeoutMs, 15000)
  assert.equal(CDP_DEFAULTS.pollIntervalMs, 500)
  assert.equal(CDP_DEFAULTS.pollMaxMs, 15000)
})

// 8/23 复核实证修复：WS 路径（Node 有 globalThis.WebSocket）此前只 ws.close() 不关 CDP 标签，
// 每抓一页/一帖泄漏一个 tab 到用户 9222 Chrome（实证 2 页 run 泄漏 9 tab）。修复后两条路径都必须
// 对每个开的标签发 PUT /json/close/<id>。此测试用 mock fetch + mock WebSocket 断言「开=关」。
test('fetchLinuxDoNews34：WS 路径对每个开的标签都关（json/close 命中=开的标签数）', async () => {
  const opened = []
  const closed = []
  const mkBody = () => JSON.stringify({ topic_list: { topics: [
    { id: 100001, title: 'DeepSeek V4-Pro 发布', created_at: '2026-08-23T04:12:00.000Z', excerpt: '官方正式版上线。', like_count: 42 },
  ] } })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/json/new?')) {
      const id = 'tab' + (opened.length + 1)
      opened.push(id)
      return { ok: true, status: 200, json: async () => ({ id, webSocketDebuggerUrl: 'ws://mock/' + id }) }
    }
    if (u.includes('/json/close/')) {
      const id = u.split('/json/close/')[1]
      closed.push(id)
      return { ok: true, status: 200, json: async () => ({}) }
    }
    throw new Error('unexpected fetch: ' + u)
  }
  // 功能假 WebSocket：构造后下一微任务触发 onopen（模块 await 它）；send 立即回 Runtime.enable / Runtime.evaluate（含 JSON body）
  class MockWS {
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this._n = 0; queueMicrotask(() => { this.onopen && this.onopen() }) }
    send(data) {
      const msg = JSON.parse(data)
      this._n++
      const result = msg.method === 'Runtime.evaluate' ? { result: { value: mkBody() } } : {}
      setTimeout(() => { this.onmessage && this.onmessage({ data: JSON.stringify({ id: msg.id, result }) }) }, 0)
    }
    close() {}
  }
  const realWS = globalThis.WebSocket
  globalThis.WebSocket = MockWS
  const timer = setTimeout(() => { throw new Error('test hang') }, 5000)
  try {
    const out = await fetchLinuxDoNews34({ date: '2026-08-23', cdpHost: 'mock:9222' })
    clearTimeout(timer)
    assert.ok(out.ok, 'mock 环境应成功')
    assert.ok(opened.length >= 4, '应开过至少 4 个标签（news 页 + deep 帖），实际 ' + opened.length)
    assert.equal(closed.length, opened.length, '关闭数必须等于开启数（无泄漏）')
    assert.ok(closed.every(id => opened.includes(id)), '每个关闭的标签都是开过的')
  } finally {
    clearTimeout(timer)
    globalThis.fetch = realFetch
    globalThis.WebSocket = realWS
  }
})

// 8/23 复核修复：WS open 失败（onerror 早退 throw）路径也必须关掉已开的标签——修复前的
// readBodyText 只在函数末尾关、非 finally，onerror reject 会让 closeTab 永不执行，标签泄漏。
// 此用例驱动 mock WS onerror 早退，断言早退后仍发 PUT /json/close/<id>（开=关），锁定 try/finally。
test('fetchLinuxDoNews34：WS onerror 早退后仍关掉已开的标签（finally 收敛）', async () => {
  const opened = []
  const closed = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/json/new?')) {
      const id = 'tab-onerr-' + (opened.length + 1)
      opened.push(id)
      return { ok: true, status: 200, json: async () => ({ id, webSocketDebuggerUrl: 'ws://mock/' + id }) }
    }
    if (u.includes('/json/close/')) {
      closed.push(u.split('/json/close/')[1])
      return { ok: true, status: 200, json: async () => ({}) }
    }
    throw new Error('unexpected fetch: ' + u)
  }
  // 假 WebSocket：构造后下一微任务触发 onerror（reject），从而 mock onopen 永不触发 → WS 路径早退 throw。
  class WSFail {
    constructor() { this.onopen = null; this.onmessage = null; queueMicrotask(() => { this.onerror && this.onerror() }) }
    send() {}
    close() {}
  }
  const realWS = globalThis.WebSocket
  globalThis.WebSocket = WSFail
  const timer = setTimeout(() => { throw new Error('test hang') }, 5000)
  try {
    const out = await fetchLinuxDoNews34({ date: '2026-08-23', cdpHost: 'mock:9222' })
    clearTimeout(timer)
    // 整个抓取失败（data-independent，走 no_cdp 之外的真实失败），每一页开的标签都必须最后被关掉：
    // fetchLinuxDoNews34 顶层 catch 兜底 out.ok=false degraded，但每个 readBodyText 内的 finally 仍须 closeTab。
    assert.equal(out.ok, false)
    assert.equal(closed.length, opened.length, 'WS 早退后仍须开=关（finally 收敛），实际开 ' + opened.length + ' 关 ' + closed.length)
  } finally {
    clearTimeout(timer)
    globalThis.fetch = realFetch
    globalThis.WebSocket = realWS
  }
})

// 8/24 补 HTTP 兜底路径（workflow realm 生产路径）零测试覆盖：删除 globalThis.WebSocket 模拟
// 无 WebSocket 全局 → hasW()=false → 走 CDP HTTP-only polling（/json/new + /json/<targetId> innerText +
// /json/close）。断言 HTTP polling 能读回 JSON body，且开=关（无标签泄漏）。finally 恢复全局。
test('fetchLinuxDoNews34：HTTP 兜底路径（无 WebSocket 全局）读回 body 且开=关', async () => {
  const opened = []
  const closed = []
  const mkBody = () => JSON.stringify({ topic_list: { topics: [
    { id: 100001, title: 'DeepSeek V4-Pro 发布', created_at: '2026-08-23T04:12:00.000Z', excerpt: 'HTTP 兜底路径读回。', like_count: 7 },
  ] } })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/json/new?')) {
      const id = 'tab-http-' + (opened.length + 1)
      opened.push(id)
      return { ok: true, status: 200, json: async () => ({ id, webSocketDebuggerUrl: 'ws://mock/' + id }) }
    }
    if (u.includes('/json/close/')) {
      closed.push(u.split('/json/close/')[1])
      return { ok: true, status: 200, json: async () => ({}) }
    }
    const pm = u.match(/\/json\/(tab-http-\d+)$/)
    if (pm) return { ok: true, status: 200, json: async () => ({ innerText: mkBody() }) }
    throw new Error('unexpected fetch: ' + u)
  }
  // 无 WebSocket 全局 = workflow realm（HTTP-only polling 兜底路径）。删属性而非置 null，
  // 因 hasW() 用 `in` 探测属性存在性；finally 里用原 descriptor 恢复。
  const realWSDesc = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  delete globalThis.WebSocket
  // 加速 HTTP 轮询（默认 500ms/片会让 4 页 + deep 合计约 4s+），from spec 轮询节奏非本用例验证目标
  const realPoll = CDP_DEFAULTS.pollIntervalMs
  CDP_DEFAULTS.pollIntervalMs = 1
  const timer = setTimeout(() => { throw new Error('test hang') }, 5000)
  try {
    const out = await fetchLinuxDoNews34({ date: '2026-08-23', cdpHost: 'mock:9222' })
    clearTimeout(timer)
    assert.ok(out.ok, 'HTTP 兜底路径应成功读到 body')
    assert.equal(out.topics, 4, '4 页 × 1 帖全部经 HTTP polling 读回，实际 ' + out.topics)
    assert.equal(out.posts[0].snippet, 'HTTP 兜底路径读回。', 'body 应来自 /json/<targetId> 的 innerText')
    assert.ok(out.posts[0].likeCount === 7, 'JSON 内容正常解析')
    assert.ok(opened.length >= 4, '应开过至少 4 个标签（news 页 + deep 帖），实际 ' + opened.length)
    assert.equal(closed.length, opened.length, '关闭数必须等于开启数（无泄漏）')
    assert.ok(closed.every(id => opened.includes(id)), '每个关闭的标签都是开过的')
  } finally {
    clearTimeout(timer)
    globalThis.fetch = realFetch
    if (realWSDesc) Object.defineProperty(globalThis, 'WebSocket', realWSDesc)
    CDP_DEFAULTS.pollIntervalMs = realPoll
  }
})
