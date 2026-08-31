// finalize 落盘回归 —— 确定性 4 产物写入，锁死「workflow 只返回 payloads、落盘须确定性命令」契约。
//
// 背景（8/22 第十九项）：8/21 直跑 Workflow 工具时 workflow 只 return payloads、不写盘，
//   SKILL 第 5 步所需的主会话手工 Write 被跳过 → docs/daily 缺失。修复：finalize.mjs 把落盘
//   提升为确定性 Node 命令（CLI + 可 import 函数），本测试锁死其保真与错误路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractPayloads, finalizePayloads, expand } from '../finalize.mjs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-daily-finalize-'))

const sample = () => ({
  date: '2026-08-21',
  outDir: tmpDir,
  payloads: {
    claims: JSON.stringify({ date: '2026-08-21', confirmed: [{ claim: 'A' }] }),
    sources: JSON.stringify({ date: '2026-08-21', sources: [{ url: 'https://x' }] }),
    meta: JSON.stringify({ date: '2026-08-21', degraded: [] }),
    md: '# 🤖 AI 日报 · 2026-08-21\n\n覆盖自检\n',
  },
})

// 清理 tmp 目录（幂等，防残留）
process.on('exit', () => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

test('extractPayloads：workflow 顶层 result 包装解包', () => {
  const spec = extractPayloads(sample())
  assert.equal(spec.outDir, tmpDir)
  assert.equal(spec.date, '2026-08-21')
  assert.equal(spec.payloads.claims, sample().payloads.claims)
})

test('extractPayloads：缺 outDir 无论 wrap 与否均抛错；缺 payloads 亦抛错', () => {
  // 裸 { payloads } 无 outDir
  assert.throws(() => extractPayloads({ payloads: sample().payloads }), /missing result\.outDir/)
  // 顶层 { result, outDir } 包装下有 outDir 但缺 payloads
  assert.throws(() => extractPayloads({ result: {}, outDir: tmpDir }), /missing payloads/)
  // 顶层 { result, outDir } 包装下有 payloads → OK
  const wrapped = { result: { ...sample(), outDir: tmpDir } }
  assert.equal(extractPayloads(wrapped).outDir, tmpDir)
})

test('extractPayloads：缺任一 payload 字符串字段抛错', () => {
  const { payloads, ...rest } = sample()
  const bad = { ...rest, payloads: { ...payloads, claims: undefined } }
  assert.throws(() => extractPayloads(bad), /payloads\.claims must be a string/)
})

test('extractPayloads：缺 date 抛错（与 outDir/payloads 同等严格）', () => {
  const { date, ...rest } = sample()
  assert.throws(() => extractPayloads({ ...rest, date: null }), /missing result\.date/)
  assert.throws(() => extractPayloads({ ...rest, date: '' }), /missing result\.date/)
  assert.throws(() => extractPayloads({ ...rest, date: undefined }), /missing result\.date/)
})

test('finalizePayloads：4 文件逐字节落盘且内容==源 payload', () => {
  const written = finalizePayloads(sample())
  assert.equal(written.length, 4, '写 4 个文件')
  const expectName = {
    '2026-08-21.verified-claims.json': sample().payloads.claims,
    '2026-08-21.sources.json': sample().payloads.sources,
    '2026-08-21.meta.json': sample().payloads.meta,
    '2026-08-21-ai日报.md': sample().payloads.md,
  }
  for (const fp of written) {
    const name = path.basename(fp)
    assert.ok(expectName[name], `写文件 ${name}`)
    assert.equal(fs.readFileSync(fp, 'utf8'), expectName[name], `${name} 内容逐字节==源 payload`)
  }
})

test('finalizePayloads：目录自动创建 + 幂等重跑（重跑覆写同路径）', () => {
  const nested = path.join(tmpDir, 'nested', 'daily')
  finalizePayloads({ ...sample(), outDir: nested })
  const again = finalizePayloads({ ...sample(), outDir: nested })
  assert.equal(again.length, 4)
  for (const fp of again) assert.ok(fs.existsSync(fp), `${fp} 重跑可覆盖`)
})

test('expand：`~`/`~/...` 展开为用户 home，普通路径原样（8/25 修复）', () => {
  const home = os.homedir()
  assert.equal(expand('~'), home)
  assert.equal(expand('~/Library'), path.join(home, 'Library'))
  assert.equal(expand(`${home}/x`), `${home}/x`)
  assert.equal(expand('relative/path'), 'relative/path')
  assert.equal(expand(null), null)
})

test('extractPayloads：outDir 含 `~` 前缀自动展开（不再写坏 `~` 字面目录）', () => {
  // 展开下沉到 finalizePayloads（写入边界）后，extractPayloads 保留原样路径（不展开）。
  const spec = extractPayloads({ ...sample(), outDir: '~/ai-daily-tilde-test' })
  assert.equal(spec.outDir, '~/ai-daily-tilde-test', 'extract 不再展开（展开在写边界）')
})

test('finalizePayloads：`~` outDir 直接调用也展开（import/CLI 直达入口都防写坏字面目录）', () => {
  const written = finalizePayloads({ ...sample(), outDir: '~/ai-daily-tilde-test' })
  assert.equal(written.length, 4)
  for (const fp of written) {
    assert.ok(fp.startsWith(os.homedir()), `写到 home 下：${fp}`)
    assert.ok(!fp.startsWith('~/'), `不含字面 ~/：${fp}`)
    assert.ok(fs.existsSync(fp), `${fp} 已写`)
  }
  fs.rmSync(path.join(os.homedir(), 'ai-daily-tilde-test'), { recursive: true, force: true })
})

// 8/26：CLI --out 覆盖分支此前绕过 expand（finalize.mjs 径写 `~/foo` 字面目录）。此端到端测试以真实
// spawn node 进程跑 CLI + `--out "~/..."`，断言不创建字面 `~/` 目录、产物写到 home 展开路径。
test('CLI：--out "~/..." 展开为 home，不创建字面 ~ 目录（端到端）', () => {
  const proj = path.join(HERE, '..') // scripts/ai-daily
  const resultJson = path.join(tmpDir, 'cli-result.json')
  fs.writeFileSync(resultJson, JSON.stringify(sample()))
  const home = os.homedir()
  const target = 'ai-daily-cli-tilde-test'
  const before = fs.existsSync(path.join(home, target)) ? fs.readdirSync(path.join(home, target)) : null
  const res = spawnSync(process.execPath, [path.join(proj, 'finalize.mjs'), resultJson, '--out', `~/${target}`], { encoding: 'utf8' })
  assert.equal(res.status, 0, `CLI 退出码 0；stderr=${res.stderr}`)
  const literal = path.resolve(proj, '~/ai-daily-cli-tilde-test')
  assert.ok(!fs.existsSync(literal), '未创建字面 ~ 目录')
  const homeDir = path.join(home, target)
  assert.ok(fs.existsSync(homeDir), 'home 下目录已建')
  const files = fs.readdirSync(homeDir)
  assert.equal(files.length, 4, 'home 下写 4 产物')
  fs.rmSync(homeDir, { recursive: true, force: true })
  if (before) fs.writeFileSync(path.join(home, target, '.keep'), '')
})