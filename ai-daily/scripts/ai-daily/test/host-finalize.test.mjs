import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findLatestCompletedWorkflow } from '../host-finalize.mjs'

// 09-20 夜烟测 wf_812478c6-a01：realm completed + payloads 齐全，编排器 422 死在 Write 前。
// 宿主必须从 ~/.claude/projects/<session>/workflows/wf_*.json 找回 payloads 并 finalize。
// 本文件锁死：日期/outDir 精确匹配、拒绝 /tmp 烟测 json 写入生产、缺 payload 拒绝、sinceMs 过滤。

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UUID = 'b159cd32-4b8e-4594-848f-1253c079ba69'
const DATE = '2026-09-20'
const PROD_OUT = '/Users/mango/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport/2026-09-20'
const TMP_OUT = '/tmp/ai-daily-smoke-20260920.0gnh/out'

const samplePayloads = () => ({
  claims: JSON.stringify({ date: DATE, confirmed: [{ claim: 'A', source: 'https://example.com/a' }] }),
  sources: JSON.stringify({ date: DATE, sources: [{ url: 'https://example.com/a' }] }),
  meta: JSON.stringify({ date: DATE, degraded: [], confirmed: 1 }),
  md: '# 🤖 AI 日报 · 2026-09-20\n\n覆盖自检\n',
})

const wfJson = (over = {}) => ({
  status: 'completed',
  runId: 'wf_812478c6-a01',
  durationMs: 1502545,
  logs: ['VERIFY-SALVAGE'],
  result: {
    date: DATE,
    outDir: PROD_OUT,
    payloads: samplePayloads(),
    ...over.result,
  },
  ...over,
})

const memIo = (files, dirs) => ({
  readdirSync: p => {
    if (!(p in dirs)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return dirs[p].slice()
  },
  statSync: p => {
    if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return { mtimeMs: files[p].mtimeMs, size: files[p].body.length }
  },
  readFileSync: p => {
    if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return files[p].body
  },
})

const layout = (entries) => {
  // entries: [{ session, name, mtimeMs, obj }]
  const projects = '/projects'
  const dirs = { [projects]: [] }
  const files = {}
  for (const e of entries) {
    if (!dirs[projects].includes(e.session)) dirs[projects].push(e.session)
    const wfDir = path.join(projects, e.session, 'workflows')
    if (!(wfDir in dirs)) dirs[wfDir] = []
    dirs[wfDir].push(e.name)
    files[path.join(wfDir, e.name)] = { mtimeMs: e.mtimeMs, body: JSON.stringify(e.obj) }
  }
  return { projects, files, dirs }
}

test('findLatestCompletedWorkflow：日期+outDir 命中最新 completed json', () => {
  const { projects, files, dirs } = layout([
    { session: UUID, name: 'wf_old.json', mtimeMs: 100, obj: wfJson() },
    { session: UUID, name: 'wf_new.json', mtimeMs: 200, obj: wfJson({ runId: 'wf_new' }) },
  ])
  const r = findLatestCompletedWorkflow({ projectsDir: projects, date: DATE, outDir: PROD_OUT, io: memIo(files, dirs) })
  assert.equal(r.ok, true)
  assert.ok(r.path.endsWith('wf_new.json'), '取 mtime 最新的匹配项')
})

test('findLatestCompletedWorkflow：/tmp 烟测 json 不得匹配生产 outDir（09-20 LEDGER-SKIP 隔离）', () => {
  const { projects, files, dirs } = layout([
    { session: UUID, name: 'wf_smoke.json', mtimeMs: 300, obj: wfJson({ result: { date: DATE, outDir: TMP_OUT, payloads: samplePayloads() } }) },
  ])
  const r = findLatestCompletedWorkflow({ projectsDir: projects, date: DATE, outDir: PROD_OUT, io: memIo(files, dirs) })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no_matching_workflow')
})

test('findLatestCompletedWorkflow：缺 payloads / 非 completed / 错日期 / sinceMs 均拒绝', () => {
  const cases = [
    { name: 'wf_incomplete.json', obj: { status: 'completed', result: { date: DATE, outDir: PROD_OUT, payloads: { claims: 'x' } } } },
    { name: 'wf_running.json', obj: wfJson({ status: 'running' }) },
    { name: 'wf_yday.json', obj: wfJson({ result: { date: '2026-09-19', outDir: PROD_OUT, payloads: samplePayloads() } }) },
  ]
  for (const c of cases) {
    const { projects, files, dirs } = layout([{ session: UUID, name: c.name, mtimeMs: 400, obj: c.obj }])
    const r = findLatestCompletedWorkflow({ projectsDir: projects, date: DATE, outDir: PROD_OUT, io: memIo(files, dirs) })
    assert.equal(r.ok, false, c.name + ' 必须拒绝')
  }
  const { projects, files, dirs } = layout([{ session: UUID, name: 'wf_old.json', mtimeMs: 50, obj: wfJson() }])
  const r = findLatestCompletedWorkflow({
    projectsDir: projects, date: DATE, outDir: PROD_OUT, sinceMs: 100, io: memIo(files, dirs),
  })
  assert.equal(r.ok, false, 'mtime < sinceMs 必须拒绝（不得误收上次 run）')
})

test('CLI：匹配 workflow json → 调用 finalize 写 4 产物；生产前缀外 LEDGER-SKIP', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-daily-host-finalize-'))
  const projects = path.join(tmp, 'projects')
  const session = path.join(projects, UUID, 'workflows')
  const outDir = path.join(tmp, 'out')
  fs.mkdirSync(session, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })
  const wfPath = path.join(session, 'wf_cli.json')
  fs.writeFileSync(wfPath, JSON.stringify(wfJson({ result: { date: DATE, outDir, payloads: samplePayloads() } })))
  try {
    const res = spawnSync(process.execPath, [
      path.join(HERE, '..', 'host-finalize.mjs'),
      '--date', DATE,
      '--out', outDir,
      '--projects', projects,
      '--since-epoch', '0',
    ], { encoding: 'utf8' })
    assert.equal(res.status, 0, `CLI 须成功 stderr=${res.stderr} stdout=${res.stdout}`)
    assert.match(res.stdout, /HOST-FINALIZE-OK/, '须打 HOST-FINALIZE-OK')
    assert.match(res.stdout, /LEDGER-SKIP/, '/tmp 烟测不得记账')
    const md = path.join(outDir, DATE + '-ai日报.md')
    assert.ok(fs.existsSync(md), 'md 必须落盘')
    assert.equal(fs.readFileSync(md, 'utf8'), samplePayloads().md)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('CLI：报告已在盘上 → HOST-FINALIZE-SKIP 且不覆写', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-daily-host-finalize-skip-'))
  const outDir = path.join(tmp, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const md = path.join(outDir, DATE + '-ai日报.md')
  fs.writeFileSync(md, 'ALREADY')
  try {
    const res = spawnSync(process.execPath, [
      path.join(HERE, '..', 'host-finalize.mjs'),
      '--date', DATE,
      '--out', outDir,
      '--projects', path.join(tmp, 'projects-empty'),
      '--since-epoch', '0',
    ], { encoding: 'utf8' })
    assert.equal(res.status, 0)
    assert.match(res.stdout, /HOST-FINALIZE-SKIP report_exists/)
    assert.equal(fs.readFileSync(md, 'utf8'), 'ALREADY', '已有报告不得覆写')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
