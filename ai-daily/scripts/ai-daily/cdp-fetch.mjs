// ai-daily 通用网页 CDP 抓取 CLI（9/13 新增，宿主 Node 运行，绝不 inline 进 workflow 产物）。
//
// 定位：fetch 阶段的 9222 通道。fetch 子代理（headless，run-daily.sh 传 webFetchViaCdp:true）经 Bash
// 调用本 CLI：对任意 URL 复用用户已开的 9222 登录态 Chrome 开临时标签 → 读 body.innerText → 关标签，
// 把正文以 JSON 打到 stdout。失败（9222 未开/超时/空页/锁超时）→ 非零退出 + stderr 诊断，
// **绝不把错误文本当成功 JSON**——代理按 ok:false 回落 WebFetch。
//
// 纪律（与 linuxdo 通道一致，不变）：只复用已运行的 9222 Chrome；只关自己开的临时标签
// （cdp-core readBodyTextRaw 的 finally 收敛）；绝不启动/关闭浏览器本体。
// 并发信号量：fetch 批 6 个代理并发，锁目录上限 LOCK_MAX 个临时标签同时在开（>LOCK_STALE_MS 陈旧锁
// 回收），避免同时刷用户 Chrome 开一排标签。
//
// 用法：node cdp-fetch.mjs '<url>' [--host 127.0.0.1:9222] [--max-chars 12000] [--lock-dir <dir>]
// 成功 stdout：{"ok":true,"url":...,"chars":N,"text":"..."}；失败：stderr 'cdp-fetch: 失败: <reason>'，exit 1。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readBodyTextRaw, CDP_DEFAULTS } from './cdp-core.mjs'
import { isCliMain } from './cli-main.mjs'

export const DEFAULT_MAX_CHARS = 12000
export const LOCK_MAX = 3
export const LOCK_STALE_MS = 60000
export const LOCK_POLL_MS = 400
// 持锁心跳间隔：每 10s touch 锁文件 mtime。陈旧回收（LOCK_STALE_MS=60s）据此只清「真死进程」——
// 持锁进程活着时 mtime 持续续期，绝不误回收活锁（9/19 C3：旧版 mtime 只在创建时写一次，
// 持锁 >60s 的慢页/挂起会被他人回收 → 同槽双进程超发）。
export const LOCK_HEARTBEAT_MS = 10000
// 必须盖住一次完整读页（开标签 requestTimeoutMs + 轮询 pollMaxMs + 关标签 3s + 调度余量）。
// 9/19 C2：旧值 = requestTimeoutMs + pollMaxMs（30s）< 单次最坏 33s——FETCH_BATCH=6、锁上限 3 时，
// 后 3 个代理在 30s 必然 lock_timeout 回落 WebFetch，高峰期 9222 通道命中率静默下降。
export const LOCK_TIMEOUT_MS = CDP_DEFAULTS.requestTimeoutMs + CDP_DEFAULTS.pollMaxMs + 5000

export const defaultLockDir = () => path.join(os.homedir(), '.ai-daily', 'cdp-locks')

// 陈旧锁回收 + 占位。返回锁文件路径；超时/不可用 → throw（调用方走 stderr 诊断）。
// io 可注入（测试用 tmpdir + 假时钟），默认真实 fs/Date。
export async function acquireLock(opts = {}) {
  const dir = opts.dir || defaultLockDir()
  const max = typeof opts.max === 'number' ? opts.max : LOCK_MAX
  const staleMs = typeof opts.staleMs === 'number' ? opts.staleMs : LOCK_STALE_MS
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : LOCK_TIMEOUT_MS
  const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : LOCK_POLL_MS
  const io = opts.io || fs
  const now = opts.now || (() => Date.now())
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)))
  const t0 = now()
  for (;;) {
    try { io.mkdirSync(dir, { recursive: true }) } catch (e) { throw new Error('lock mkdir: ' + (e && e.message)) }
    // 陈旧锁回收：mtime 超过 staleMs 的锁视同死进程残留，直接清掉。
    let locks = []
    try { locks = io.readdirSync(dir).filter(f => f.endsWith('.lock')) } catch { /* next loop */ }
    for (const f of locks) {
      const fp = path.join(dir, f)
      try {
        const st = io.statSync(fp)
        if (now() - st.mtimeMs > staleMs) { try { io.unlinkSync(fp) } catch { /* raced */ } }
      } catch { /* raced */ }
    }
    // 固定槽 lock-0.lock … lock-(max-1).lock + wx：随机文件名的 wx 挡不住
    // 「先数 live 再写新名」超发。槽位满则全部 EEXIST，进入等待。
    let got = null
    for (let i = 0; i < max; i++) {
      const fp = path.join(dir, 'lock-' + i + '.lock')
      try {
        io.writeFileSync(fp, String(now()), { flag: 'wx' })
        got = fp
        break
      } catch (e) {
        if (e && e.code === 'EEXIST') continue
        throw new Error('lock write: ' + (e && e.message))
      }
    }
    if (got) return got
    if (now() - t0 > timeoutMs) throw new Error('lock_timeout（并发临时标签已达上限 ' + max + '，等待 ' + Math.round(timeoutMs / 1000) + 's 未释放）')
    await sleep(pollMs)
  }
}

export function releaseLock(fp, io = fs) {
  try { io.unlinkSync(fp) } catch { /* already gone */ }
}

/**
 * 抓取单 URL 正文（9222 登录态 Chrome 临时标签）。失败 throw（携带 reason 文本）。
 * @returns {Promise<{ok:true, url:string, host:string, chars:number, text:string}>}
 */
export async function cdpFetch(opts = {}) {
  const url = String(opts.url || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http(s) 完整地址: ' + (url || '(空)'))
  const host = opts.host || CDP_DEFAULTS.cdpHost
  const maxChars = typeof opts.maxChars === 'number' && opts.maxChars > 0 ? opts.maxChars : DEFAULT_MAX_CHARS
  const lockDir = opts.lockDir
  const lockIo = opts.lockIo || fs
  const lock = await acquireLock(lockDir ? { dir: lockDir, ...(opts.lockOpts || {}) } : (opts.lockOpts || {}))
  // 持锁心跳（9/19 C3）：定期 touch 锁文件 mtime，陈旧回收只清真死进程。unref 不阻塞进程退出。
  const hbMs = opts.heartbeatMs === 0 ? 0 : (typeof opts.heartbeatMs === 'number' ? opts.heartbeatMs : LOCK_HEARTBEAT_MS)
  const hb = hbMs > 0 ? setInterval(() => { try { lockIo.writeFileSync(lock, String(Date.now())) } catch { /* raced */ } }, hbMs) : null
  if (hb && typeof hb.unref === 'function') hb.unref()
  const retryDelayMs = typeof opts.retryDelayMs === 'number' && opts.retryDelayMs >= 0 ? opts.retryDelayMs : 1000
  try {
    let text = await readBodyTextRaw(host, url)
    if (!text || !String(text).trim()) {
      // 9/19 C4：慢渲染页一次重开重试（仍持同一把锁）——15s poll 上限对重 JS 页可能不够，
      // 一次性的渲染慢不该直接放弃登录态通道回落匿名 WebFetch。
      if (retryDelayMs > 0) await new Promise(r => setTimeout(r, retryDelayMs))
      text = await readBodyTextRaw(host, url)
    }
    if (!text || !String(text).trim()) throw new Error('empty_body（标签正文为空——页面未渲染/被拦/非文档页）')
    const clipped = String(text).slice(0, maxChars)
    return { ok: true, url, host, chars: clipped.length, text: clipped }
  } finally {
    if (hb) clearInterval(hb)
    releaseLock(lock, lockIo)
  }
}

export function parseArgs(argv) {
  const out = { host: CDP_DEFAULTS.cdpHost, maxChars: DEFAULT_MAX_CHARS, url: null, lockDir: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host') { if (i + 1 >= argv.length) throw new Error('--host 缺参数值'); out.host = argv[++i] }
    else if (a === '--max-chars') { if (i + 1 >= argv.length) throw new Error('--max-chars 缺参数值'); const n = Number(argv[++i]); if (!Number.isInteger(n) || n <= 0) throw new Error('--max-chars 必须为正整数'); out.maxChars = n }
    else if (a === '--lock-dir') { if (i + 1 >= argv.length) throw new Error('--lock-dir 缺参数值'); out.lockDir = argv[++i] }
    else if (a === '--help' || a === '-h') out.help = true
    else if (a.startsWith('--')) throw new Error('未知参数 ' + a)
    else {
      if (out.url !== null) throw new Error('未知参数 ' + a)
      out.url = a
    }
  }
  return out
}

/** CLI 入口：成功 → stdout 单个 JSON；失败 → stderr 诊断 + 非零退出。绝不把错误文本当成功 JSON。 */
export async function main(argv) {
  let parsed
  try { parsed = parseArgs(argv) } catch (e) {
    process.stderr.write('cdp-fetch: 参数错误: ' + e.message + '\n')
    process.exit(1)
  }
  if (parsed.help) {
    process.stdout.write('cdp-fetch: 经 9222 登录态 Chrome 临时标签抓取任意 URL 正文。\n用法: node cdp-fetch.mjs \'<url>\' [--host 127.0.0.1:9222] [--max-chars 12000] [--lock-dir <dir>]\n成功输出 JSON {ok:true,url,chars,text}；失败非零退出（fetch 代理按 ok:false 回落 WebFetch）。\n')
    return
  }
  try {
    const result = await cdpFetch(parsed)
    process.stdout.write(JSON.stringify(result, null, 1))
  } catch (e) {
    process.stderr.write('cdp-fetch: 失败: ' + String(e && e.message || e).slice(0, 200) + '\n')
    process.exit(1)
  }
}

// 仅在作为脚本直接执行时运行 main（被 import 时不跑，测试可 import 接口）——与 cli-main 对齐。
if (isCliMain(import.meta.url, process.argv[1])) { main(process.argv.slice(2)) }
