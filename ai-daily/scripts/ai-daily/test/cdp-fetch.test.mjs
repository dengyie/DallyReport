import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireLock, releaseLock, cdpFetch, parseArgs, LOCK_MAX } from '../cdp-fetch.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ARTICLE_TEXT = '谷歌发布 Gemini 3.8 Flash。六周内第三次迭代。\n价格与 3.7 Flash 持平。'

// 与 linuxdo.test.mjs 同款 mock 形态：替换 globalThis.fetch/WebSocket。
// 页面正文为非 JSON 文本（通用文章页）——readBodyTextRaw 的 9/13 新契约。
function installMockFetch({ bodyText = ARTICLE_TEXT, closeCount, openCount }) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/json/new?')) { if (openCount) openCount.n++; return { ok: true, status: 200, json: async () => ({ id: 'mock1', webSocketDebuggerUrl: 'ws://mock/mock1' }) } }
    if (u.includes('/json/close/')) { if (closeCount) closeCount.n++; return { ok: true, status: 200, json: async () => ({}) } }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  class MockWS {
    constructor() { this.onopen = null; this.onmessage = null; this.onerror = null; setTimeout(() => this.onopen && this.onopen(), 0) }
    close() {}
    send(data) {
      const v = JSON.parse(data)
      setTimeout(() => {
        // CDP 对每条消息都要回 id（Runtime.enable 亦然），否则 cdp-core 的 send 超时拒收。
        if (v.method === 'Runtime.evaluate') {
          this.onmessage && this.onmessage({ data: JSON.stringify({ id: v.id, result: { result: { value: bodyText } } }) })
        } else {
          this.onmessage && this.onmessage({ data: JSON.stringify({ id: v.id, result: {} }) })
        }
      }, 0)
    }
  }
  class MockWSOpenFail extends MockWS {
    constructor() { super(); setTimeout(() => this.onerror && this.onerror(new Error('ws open')), 0) }
  }
  globalThis.WebSocket = MockWS
  globalThis.WebSocketOpenFail = MockWSOpenFail
}

test('acquireLock：max 内发锁、释放后可再锁；陈旧锁回收；超上限超时 throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-lock-'))
  // 真实时钟 + 真 fs.statSync（mtime=建文件时刻）：短 timeoutMs 让「超上限」在数百 ms 内真实触发；
  // 陈旧场景用 utimesSync 把单个锁的 mtime 拨老（不波及其它锁——假时钟会把活锁一起「拨老」误清）。
  const lockOpts = { dir, max: 2, staleMs: 60_000, timeoutMs: 400, pollMs: 2 }
  const a = await acquireLock(lockOpts)
  const b = await acquireLock(lockOpts)
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.lock')).length, 2, '两把锁在场')
  await assert.rejects(() => acquireLock(lockOpts), /lock_timeout/, '超上限超时拒绝')
  // 陈旧锁回收：把 a 的 mtime 拨老 → 下一轮 acquire 清掉并占位成功
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(a, old, old)
  const c = await acquireLock(lockOpts)
  assert.ok(c, '陈旧锁回收后可获取')
  releaseLock(c)
  releaseLock(b)
  releaseLock(a)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('cdpFetch：mock CDP 成功 → ok:true + text 正文 + 标签开=关（纪律：只关自开标签）', async () => {
  installMockFetch({ bodyText: ARTICLE_TEXT, closeCount: (globalThis.__cc = { n: 0 }), openCount: (globalThis.__oc = { n: 0 }) })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-fetch-'))
  const r = await cdpFetch({ url: 'https://blog.example/gemini-38', lockDir: dir, maxChars: 2000 })
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://blog.example/gemini-38')
  assert.ok(r.text.includes('Gemini 3.8 Flash'), '正文在 text 字段')
  assert.equal(r.chars, r.text.length)
  assert.equal(globalThis.__oc.n, 1)
  assert.equal(globalThis.__cc.n, 1, '开 1 个标签必关 1 个（finally 收敛）')
  fs.rmSync(dir, { recursive: true, force: true })
  delete globalThis.fetch; delete globalThis.WebSocket; delete globalThis.WebSocketOpenFail
})

test('cdpFetch：空正文 → throw empty_body；非 http(s) URL → throw；锁目录用 tmp 隔离', async () => {
  installMockFetch({ bodyText: '   ' })
  const { CDP_DEFAULTS } = await import('../cdp-core.mjs')
  const oldPoll = CDP_DEFAULTS.pollIntervalMs, oldMax = CDP_DEFAULTS.pollMaxMs
  CDP_DEFAULTS.pollIntervalMs = 1; CDP_DEFAULTS.pollMaxMs = 20  // 空白正文会轮询到底，缩短免测 15s 真等
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-fetch-'))
  try {
    await assert.rejects(() => cdpFetch({ url: 'https://x.example/empty', lockDir: dir }), /empty_body/)
    await assert.rejects(() => cdpFetch({ url: 'ftp://x/y', lockDir: dir }), /http\(s\)/)
    await assert.rejects(() => cdpFetch({ url: '', lockDir: dir }), /http\(s\)/)
  } finally {
    CDP_DEFAULTS.pollIntervalMs = oldPoll; CDP_DEFAULTS.pollMaxMs = oldMax
    fs.rmSync(dir, { recursive: true, force: true })
    delete globalThis.fetch; delete globalThis.WebSocket; delete globalThis.WebSocketOpenFail
  }
})

test('parseArgs：位置参数=URL、--host/--max-chars/--lock-dir、未知参数报错', () => {
  const p = parseArgs(['https://a.example/x', '--host', '127.0.0.1:9222', '--max-chars', '5000', '--lock-dir', '/tmp/l'])
  assert.equal(p.url, 'https://a.example/x')
  assert.equal(p.maxChars, 5000)
  assert.equal(p.lockDir, '/tmp/l')
  assert.throws(() => parseArgs(['--bogus']), /未知参数/)
  assert.throws(() => parseArgs(['--max-chars', 'abc']), /正整数/)
  assert.equal(LOCK_MAX, 3, '并发上限 3（6 代理批内不同时刷用户 Chrome）')
})

// ─── CLI 子进程边界（成功 JSON / 失败非零 / 参数错 / help）───
function runCli(args, { mockCdp = false, bodyText = ARTICLE_TEXT } = {}) {
  const argsJson = JSON.stringify(args)
  const mockSetup = mockCdp ? `
    const { CDP_DEFAULTS: CD } = await import('${HERE}/../cdp-core.mjs')
    CD.pollIntervalMs = 1
    CD.requestTimeoutMs = 500
    CD.pollMaxMs = 1000
    const BODY = ${JSON.stringify(bodyText)}
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('/json/new?')) return { ok: true, status: 200, json: async () => ({ id: 'mock1', webSocketDebuggerUrl: 'ws://mock/mock1' }) }
      if (u.includes('/json/close/')) return { ok: true, status: 200, json: async () => ({}) }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    globalThis.WebSocket = class {
      constructor() { this.onopen = null; this.onmessage = null; this.onerror = null; setTimeout(() => this.onopen && this.onopen(), 0) }
      close() {}
      send(data) {
        const v = JSON.parse(data)
        setTimeout(() => {
          // CDP 每条消息都要回 id（Runtime.enable 亦然），否则 cdp-core send 超时。
          if (v.method === 'Runtime.evaluate') this.onmessage && this.onmessage({ data: JSON.stringify({ id: v.id, result: { result: { value: BODY } } }) })
          else this.onmessage && this.onmessage({ data: JSON.stringify({ id: v.id, result: {} }) })
        }, 0)
      }
    }
  ` : ''
  const inline = `
    ${mockSetup}
    const { main } = await import('${HERE}/../cdp-fetch.mjs')
    await main(JSON.parse('${argsJson.replace(/'/g, "\\'")}'))
  `
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', inline], { cwd: HERE, stdio: 'pipe', timeout: 30_000 })
    return { code: 0, stdout: out.toString(), stderr: '' }
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
  }
}

test('CLI：mock CDP 成功 → exit 0，stdout 单个 JSON {ok:true,url,chars,text}', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-cli-'))
  const res = runCli(['https://blog.example/gemini-38', '--lock-dir', dir], { mockCdp: true })
  assert.equal(res.code, 0, `CLI 成功应 exit 0（stderr: ${res.stderr}）`)
  assert.equal(res.stderr, '', '成功不写 stderr')
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(res.stdout) }, 'stdout 必须为合法 JSON')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.url, 'https://blog.example/gemini-38')
  assert.ok(parsed.text.includes('Gemini 3.8 Flash'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('CLI：mock CDP 空正文 → 非零退出，stdout 不含成功 JSON，stderr 有诊断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-cli-'))
  const res = runCli(['https://x.example/empty', '--lock-dir', dir], { mockCdp: true, bodyText: '' })
  assert.notEqual(res.code, 0)
  assert.ok(!res.stdout.includes('"ok":true'), '失败不得把错误当成功 JSON')
  assert.match(res.stderr, /cdp-fetch: 失败:/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('CLI：非 http URL → 非零退出 + 参数级诊断；--help → exit 0 用法说明', () => {
  const bad = runCli(['not-a-url'])
  assert.notEqual(bad.code, 0)
  assert.match(bad.stderr, /cdp-fetch: 失败:/)
  const help = runCli(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /用法: node cdp-fetch/)
})
