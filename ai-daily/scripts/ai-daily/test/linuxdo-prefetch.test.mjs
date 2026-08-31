import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// ─── 8/27 Task 2：linux.do Node prefetch 隔离层聚焦测试。
// 验证：① 成功/失败形状可序列化；② CLI 参数错误/抓取失败 → 非零退出 + stdout/stderr 边界
// （绝不把错误文本当成功 JSON）；③ CLI 复用 fetchLinuxDoNews34（不另建 CDP transport）；④ 临时标签
// 开=关仍由 linuxdo.mjs readBodyText 的 finally 收敛（mock 环境断言开=关）。

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PREFETCH = 'file://' + path.join(HERE, '../linuxdo-prefetch.mjs')

// 成功 mock 时每条紧接页/深帖返回的 body。注意 linuxdo 分页会逐页 readBodyText，
// mock 不改页会全部返回同一 body，导致 topics 累积 = maxPages × 每页条数。
// 这里单页 1 条 → 全页累积 4 条（CDP_DEFAULTS.maxPages=4）。
const MOCK_BODY = JSON.stringify({ topic_list: { topics: [
  { id: 9, title: '成功帖', created_at: '2026-08-20T00:00:00.000Z', excerpt: 'x', like_count: 2 },
] } })

// ─── 子进程 CLI helper ───
// mockCdp=true：inline 注入可用 CDP 环境（复用 linuxdo.test.mjs 的 fetch/WebSocket mock 形态）；
// 成功后 stdout 打印 JSON、exit 0；失败/参数错 → stderr + exit 非 0。
function runCli(args, { mockCdp = false } = {}) {
  const argsJson = JSON.stringify(args)
  const mockSetup = mockCdp ? `
    const { CDP_DEFAULTS: LD } = await import('./scripts/ai-daily/linuxdo.mjs')
    LD.pollIntervalMs = 1
    LD.requestTimeoutMs = 500
    LD.pollMaxMs = 1000
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('/json/new?')) return { ok: true, status: 200, json: async () => ({ id: 'ok1', webSocketDebuggerUrl: 'ws://mock/ok' }) }
      if (u.includes('/json/close/')) return { ok: true, status: 200, json: async () => ({}) }
      if (u.includes('/json/ok')) return { ok: true, status: 200, json: async () => ({ innerText: ${JSON.stringify(MOCK_BODY)} }) }
      throw new Error('unexpected ' + u)
    }
    class WS {
      constructor () { this.onopen = null; this.onmessage = null; queueMicrotask(() => { this.onopen && this.onopen() }) }
      send (d) { const m = JSON.parse(d); const r = m.method === 'Runtime.evaluate' ? { result: { value: ${JSON.stringify(MOCK_BODY)} } } : {}; setTimeout(() => { this.onmessage && this.onmessage({ data: JSON.stringify({ id: m.id, result: r }) }) }, 0) }
      close () {}
    }
    globalThis.WebSocket = WS
  ` : ''
  const inline = `
    ${mockSetup}
    const { main } = await import('${PREFETCH}')
    await main(${argsJson})
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', inline], { encoding: 'utf8', timeout: 20000 })
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' }
}

// ── 单元：prefetchLinuxDo 成功/失败形态（进程内 mock CDP）──
test('prefetchLinuxDo：mock CDP 成功 → {ok:true, topics, posts 配额截断} 且可 JSON 序列化', async () => {
  const { prefetchLinuxDo } = await import('../linuxdo-prefetch.mjs')
  const { CDP_DEFAULTS } = await import('../linuxdo.mjs')
  const oldPoll = CDP_DEFAULTS.pollIntervalMs
  CDP_DEFAULTS.pollIntervalMs = 1
  const opened = []
  const closed = []
  const body = JSON.stringify({ topic_list: { topics: [
    { id: 1, title: '类目一', created_at: '2026-08-20T00:00:00.000Z', excerpt: 'x', like_count: 2 },
  ] } })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/json/new?')) { const id = 't' + (opened.length + 1); opened.push(id); return { ok: true, status: 200, json: async () => ({ id, webSocketDebuggerUrl: 'ws://mock/' + id }) } }
    if (u.includes('/json/close/')) { closed.push(u.split('/json/close/')[1]); return { ok: true, status: 200, json: async () => ({}) } }
    throw new Error('unexpected ' + u)
  }
  class WS {
    constructor () { this.onopen = null; this.onmessage = null; queueMicrotask(() => { this.onopen && this.onopen() }) }
    send (d) {
      const m = JSON.parse(d)
      const r = m.method === 'Runtime.evaluate' ? { result: { value: body } } : {}
      setTimeout(() => { this.onmessage && this.onmessage({ data: JSON.stringify({ id: m.id, result: r }) }) }, 0)
    }
    close () {}
  }
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  delete globalThis.WebSocket
  globalThis.WebSocket = WS
  const timer = setTimeout(() => { throw new Error('prefetch success hang') }, 5000)
  try {
    const out = await prefetchLinuxDo({ host: 'mock:9222', maxSources: 1 })
    assert.equal(out.ok, true)
    assert.ok(out.posts.length === 1, '配额截断为 maxSources=1，实际 ' + out.posts.length)
    assert.equal(out.posts[0].url, 'https://linux.do/t/1')
    assert.equal(out.posts[0].title, '类目一')
    const json = JSON.stringify(out)
    assert.ok(json.includes('"ok":true'))
    assert.ok(json.includes('"url":"https://linux.do/t/1"'))
    assert.equal(closed.length, opened.length, '开=关（临时标签由 linuxdo.mjs finally 收敛）')
  } finally {
    clearTimeout(timer)
    globalThis.fetch = realFetch
    if (desc) Object.defineProperty(globalThis, 'WebSocket', desc)
    CDP_DEFAULTS.pollIntervalMs = oldPoll
  }
})

test('prefetchLinuxDo：抓取失败（transport 抛错）→ throw，不带成功 JSON', async () => {
  const { prefetchLinuxDo } = await import('../linuxdo-prefetch.mjs')
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED') }
  try {
    await assert.rejects(() => prefetchLinuxDo({ host: '127.0.0.1:1', maxSources: 5 }), /未成功/)
  } finally {
    globalThis.fetch = oldFetch
  }
})

// ── 源码断言：复用 fetchLinuxDoNews34，不复制 CDP transport ──
test('源码：prefetch 调用 fetchLinuxDoNews34，不含 new WebSocket / /json/new / /json/close', () => {
  const code = fs.readFileSync(path.join(HERE, '../linuxdo-prefetch.mjs'), 'utf8')
  assert.ok(code.includes('fetchLinuxDoNews34({ cdpHost: host })'), '复用 linux.do.mjs 的 fetchLinuxDoNews34')
  assert.ok(!code.includes('new WebSocket('), '不得另建 WebSocket transport')
  assert.ok(!code.includes("'/json/new?'"), '不得复制 CDP /json/new transport')
  assert.ok(!code.includes("'/json/close/'"), '不得复制 tab 关闭逻辑（由 linux.do.mjs finally 收敛）')
})

// ── CLI 子进程边界 ──
test('CLI：成功（mock CDP）→ exit 0，stdout 可解析 JSON 且 posts 有内容', () => {
  const res = runCli(['--host', '127.0.0.1:9222', '--max-sources', '10'], { mockCdp: true })
  assert.equal(res.code, 0, 'CLI 成功应 exit 0')
  assert.equal(res.stderr, '', '成功不写 stderr')
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(res.stdout) }, 'stdout 必须为合法 JSON')
  assert.equal(parsed.ok, true)
  assert.ok(parsed.posts && parsed.posts.length >= 1, 'posts 非空')
  assert.equal(parsed.posts[0].title, '成功帖')
})

test('CLI：抓取失败（mock transport 抛错）→ 非零退出，stdout 空，stderr 有诊断', () => {
  const res = runCli(['--host', '127.0.0.1:1', '--max-sources', '5'])
  assert.notEqual(res.code, 0, '抓取失败必须非零退出')
  assert.equal(res.stdout, '', '失败不得把错误文本当成功 JSON 写 stdout')
  assert.match(res.stderr, /linuxdo-prefetch:/, 'stderr 带诊断前缀')
})

test('CLI：非法参数 → 非零退出 + stderr 参数错误，stdout 空', () => {
  const bad = runCli(['--max-sources', 'abc'])
  assert.notEqual(bad.code, 0, '非法 --max-sources 非零')
  assert.equal(bad.stdout, '', '参数错误不写成功 JSON')
  assert.match(bad.stderr, /参数错误/, 'stderr 有参数错误诊断')

  const unknown = runCli(['--bogus'])
  assert.notEqual(unknown.code, 0, '未知参数非零')
  assert.match(unknown.stderr, /未知参数/, '未知参数诊断')
})

test('CLI：--help → exit 0，stdout 为用法说明', () => {
  const res = runCli(['--help'])
  assert.equal(res.code, 0, 'help 应 exit 0')
  assert.match(res.stdout, /用法: node linuxdo-prefetch/, 'help 内容在 stdout')
})