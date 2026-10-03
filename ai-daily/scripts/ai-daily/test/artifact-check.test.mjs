import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { artifactPaths, summarizeArtifacts, isCliMain } from '../artifact-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 8/31 P4：launchd 上下文 /bin/zsh 无 Full Disk Access，`wc -c`/`grep` 读 iCloud 产物被拒 →
// 自检连续 6 次 run 打空壳 `ARTIFACT-OK md_bytes= confirmed= degraded=`。自检迁到 node 后，
// 本段锁死「摘要必须携带实数、空降级显式 none、缺失产物退出非 0」三条契约。

// 内存 io 替身（不碰真实文件系统，测试无副作用）
const fakeIo = files => ({
  statSync: p => {
    if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return { size: Buffer.byteLength(files[p]) }
  },
  readFileSync: p => {
    if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return files[p]
  },
})

const ROOT = '/root'
const DATE = '2026-08-31'
const { report, meta } = artifactPaths(DATE, ROOT)

test('P4：产物命名契约 = <date>-ai日报.md / <date>.meta.json，落在 <root>/<date>/', () => {
  assert.equal(report, '/root/2026-08-31/2026-08-31-ai日报.md')
  assert.equal(meta, '/root/2026-08-31/2026-08-31.meta.json')
})

test('P4：摘要携带真实统计——md_bytes/confirmed/killed/urls/degraded 均非空（修空壳自检）', () => {
  // 8/31 真实 meta.json 形状：统计在**顶层**，非 stats 嵌套
  const m = {
    confirmed: 3, killed: 3, urls_fetched: 11, urls_discovered: 24,
    degraded: ['verify_agent_errors:2', 'fetch_budget_dropped:19', 'report_failed'],
    report_error: 'report agent failed; reverting to raw archive',
  }
  const { ok, line } = summarizeArtifacts(DATE, ROOT, fakeIo({ [report]: 'x'.repeat(2840), [meta]: JSON.stringify(m) }))
  assert.equal(ok, true)
  assert.ok(line.startsWith('ARTIFACT-OK '), '在场即 OK')
  assert.match(line, /md_bytes=2840/, 'md 字节数为实数（旧版此处为空）')
  assert.match(line, /confirmed=3/, 'confirmed 为实数（旧版为空）')
  assert.match(line, /killed=3/)
  assert.match(line, /urls=11\/24/)
  assert.match(line, /degraded=\[verify_agent_errors:2,fetch_budget_dropped:19,report_failed\]/, 'degraded 数组完整（旧版为空）')
  assert.match(line, /report_error="report agent failed; reverting to raw archive"/)
  // 关键回归：绝不允许再出现 `md_bytes=` / `confirmed=` / `degraded=` 后面直接跟空白或行尾
  assert.doesNotMatch(line, /=(\s|$)/, '任何字段都不得为空值（空壳自检回归）')
})

test('P4：空 degraded 写显式 none——「无降级」不得与「读不到」长得一样', () => {
  const { line } = summarizeArtifacts(DATE, ROOT, fakeIo({
    [report]: 'x'.repeat(11890), [meta]: JSON.stringify({ confirmed: 21, killed: 0, urls_fetched: 16, urls_discovered: 30, degraded: [] }),
  }))
  assert.match(line, /degraded=none/, '空数组 → none')
  assert.doesNotMatch(line, /report_error=/, '无 report_error 时不输出该字段')
})

test('P4：报告缺失 → ARTIFACT-FAIL 且 ok=false（调用方据此判 run 未出活）', () => {
  const { ok, line } = summarizeArtifacts(DATE, ROOT, fakeIo({}))
  assert.equal(ok, false)
  assert.match(line, /^ARTIFACT-FAIL report_missing err=ENOENT/)
})

test('P4：meta 缺失/损坏不掩盖报告在场——仍 OK 但标 meta_unreadable', () => {
  const missing = summarizeArtifacts(DATE, ROOT, fakeIo({ [report]: 'x'.repeat(100) }))
  assert.equal(missing.ok, true, '报告在场即 OK（meta 只是摘要增强）')
  assert.match(missing.line, /md_bytes=100 meta_unreadable=missing/)
  const broken = summarizeArtifacts(DATE, ROOT, fakeIo({ [report]: 'x'.repeat(100), [meta]: '{not json' }))
  assert.equal(broken.ok, true)
  assert.match(broken.line, /meta_unreadable=parse_error/)
})

test('P4：meta 字段缺失时降级为 ?，不得静默丢字段', () => {
  const { line } = summarizeArtifacts(DATE, ROOT, fakeIo({ [report]: 'x', [meta]: '{}' }))
  assert.match(line, /confirmed=\?/)
  assert.match(line, /killed=\?/)
  assert.match(line, /urls=\?\/\?/)
  assert.match(line, /degraded=none/)
})

test('P4：isCliMain 相对 argv[1] 经 path.resolve 对齐，不得因相对路径静默不当 CLI', () => {
  const abs = fileURLToPath(import.meta.url)
  assert.equal(isCliMain(import.meta.url, abs), true, '绝对路径命中')
  const rel = path.relative(process.cwd(), abs) || abs
  assert.equal(isCliMain(import.meta.url, rel), true, '相对路径经 resolve 后命中')
  assert.equal(isCliMain(import.meta.url, undefined), false)
  assert.equal(isCliMain(import.meta.url, '/tmp/not-this-file.mjs'), false)
})

test('P4：artifact-check 复用宿主共享 isCliMain，不得各写一份', () => {
  const src = fs.readFileSync(new URL('../artifact-check.mjs', import.meta.url), 'utf8')
  assert.match(src, /from '\.\/cli-main\.mjs'/, '从 cli-main.mjs 导入，禁止本地再实现一份')
  assert.doesNotMatch(src, /export const isCliMain =/, '不得在本文件再定义 isCliMain')
})

// F2（10-04 review 根因回归）：默认目录三级解析（env > win32 生产根 > Darwin iCloud）。
// 旧版只有 Mac iCloud 前缀——Windows 无 --dir 调用会 ARTIFACT-FAIL report_missing 假失败。
// 环境变量覆盖经 CLI spawn 验证（三级解析在 host-paths.prodDallyReportRoot()，调用点惰性求值）。
test('F2：AI_DAILY_REPORT_DIR env 覆盖默认目录——无 --dir 调用也能命中生产根', () => {
  const proj = path.join(HERE, '..') // scripts/ai-daily
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-env-'))
  const date = '2026-10-04'
  try {
    fs.mkdirSync(path.join(root, date), { recursive: true })
    fs.writeFileSync(path.join(root, date, `${date}-ai日报.md`), 'x'.repeat(2840))
    fs.writeFileSync(path.join(root, date, `${date}.meta.json`), JSON.stringify({ confirmed: 8, degraded: [] }))
    const res = spawnSync(process.execPath, [path.join(proj, 'artifact-check.mjs'), '--date', date], {
      encoding: 'utf8',
      env: { ...process.env, AI_DAILY_REPORT_DIR: root },
    })
    assert.equal(res.status, 0, `无 --dir 时读到 env 指定根：${res.stdout}${res.stderr}`)
    assert.match(res.stdout, /^ARTIFACT-OK md_bytes=2840/, 'env 根下命中真实产物')
    // F-1 单一真源锁定：本文件只准引用 host-paths.prodDallyReportRoot，不得再持生产根字面量
    const src = fs.readFileSync(path.join(proj, 'artifact-check.mjs'), 'utf8')
    assert.match(src, /prodDallyReportRoot/, '默认目录走 host-paths 单一真源')
    assert.doesNotMatch(src, /E:\/profile\/note\/note/, '本文件不得再持有生产根字面量（防多点漂移）')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
