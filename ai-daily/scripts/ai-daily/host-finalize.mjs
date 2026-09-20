#!/usr/bin/env node
// host-finalize — 编排器死后从 completed workflow json 确定性落盘（不 inline 进产物）。
//
// 09-20 夜烟测 wf_812478c6-a01：realm status=completed、payloads 齐全，编排器 422
// 「No upstream target could preserve or convert the request」死在 Write 前 → out/ 空。
// 生产 run-daily.sh 只跑 artifact-check → ARTIFACT-FAIL。根因：落盘仍 LLM-mediated。
//
// 本 CLI 扫 ~/.claude/projects/<session>/workflows/wf_*.json（父 json，不是 journal），
// 按 date + outDir 精确匹配最新 completed 且 payloads 四字段齐全的一份，再 spawn
// finalize.mjs 落盘。烟测 /tmp json 对不上生产 outDir，不会误收。
//
// 用法：
//   node scripts/ai-daily/host-finalize.mjs --date YYYY-MM-DD --out <outDir>
//     [--projects <dir>] [--since-epoch <unix seconds>]
// exit：0 = 已落盘或报告已在盘上；1 = 无匹配 / finalize 失败。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isCliMain } from './cli-main.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FINALIZE = path.join(HERE, 'finalize.mjs')
const UUID_RE = /^[0-9a-f-]{36}$/

const DEFAULT_PROJECTS = path.join(
  process.env.HOME || '',
  '.claude', 'projects', '-Users-mango-project-claude-project-obsidian',
)

const payloadsComplete = p => {
  if (!p || typeof p !== 'object') return false
  return ['claims', 'sources', 'meta', 'md'].every(k => typeof p[k] === 'string' && p[k].length > 0)
}

const outDirEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  return path.resolve(a) === path.resolve(b)
}

/**
 * 在 projectsDir 下找本次 run 匹配的最新 completed workflow json。
 * @returns {{ok:true, path:string, mtimeMs:number} | {ok:false, reason:string}}
 */
export const findLatestCompletedWorkflow = ({
  projectsDir,
  date,
  outDir,
  sinceMs = 0,
  io = fs,
}) => {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'bad_date' }
  if (!outDir || typeof outDir !== 'string') return { ok: false, reason: 'bad_outDir' }
  let sessions
  try {
    sessions = io.readdirSync(projectsDir).filter(n => UUID_RE.test(n))
  } catch {
    return { ok: false, reason: 'no_matching_workflow' }
  }
  let best = null
  let bestM = -1
  for (const s of sessions) {
    const wfDir = path.join(projectsDir, s, 'workflows')
    let names
    try { names = io.readdirSync(wfDir).filter(n => n.startsWith('wf_') && n.endsWith('.json')) }
    catch { continue }
    for (const n of names) {
      const fp = path.join(wfDir, n)
      let st
      try { st = io.statSync(fp) } catch { continue }
      if (st.mtimeMs < sinceMs) continue
      let obj
      try { obj = JSON.parse(io.readFileSync(fp, 'utf8')) } catch { continue }
      if (!obj || obj.status !== 'completed') continue
      const r = (obj.result && typeof obj.result === 'object') ? obj.result : obj
      if (r.date !== date) continue
      if (!outDirEqual(r.outDir, outDir)) continue
      if (!payloadsComplete(r.payloads)) continue
      if (st.mtimeMs >= bestM) {
        bestM = st.mtimeMs
        best = fp
      }
    }
  }
  if (!best) return { ok: false, reason: 'no_matching_workflow' }
  return { ok: true, path: best, mtimeMs: bestM }
}

const reportPath = (outDir, date) => path.join(outDir, date + '-ai日报.md')

export { isCliMain }

if (isCliMain(import.meta.url, process.argv[1])) {
  const argv = process.argv.slice(2)
  const flag = n => {
    const i = argv.indexOf(n)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  const date = flag('--date')
  const outDir = flag('--out')
  const projectsDir = flag('--projects') || DEFAULT_PROJECTS
  const sinceEpoch = flag('--since-epoch')
  const sinceMs = sinceEpoch != null && sinceEpoch !== '' ? Number(sinceEpoch) * 1000 : 0

  if (!date || !outDir) {
    console.error('HOST-FINALIZE-FAIL usage: --date YYYY-MM-DD --out <dir>')
    process.exit(1)
  }

  if (fs.existsSync(reportPath(outDir, date))) {
    console.log('HOST-FINALIZE-SKIP report_exists')
    process.exit(0)
  }

  const found = findLatestCompletedWorkflow({ projectsDir, date, outDir, sinceMs })
  if (!found.ok) {
    console.error('HOST-FINALIZE-FAIL ' + found.reason)
    process.exit(1)
  }

  const res = spawnSync(process.execPath, [FINALIZE, found.path, '--out', outDir], { encoding: 'utf8' })
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  if (res.status !== 0) {
    console.error('HOST-FINALIZE-FAIL finalize_rc=' + res.status + ' path=' + found.path)
    process.exit(res.status == null ? 1 : res.status)
  }
  console.log('HOST-FINALIZE-OK path=' + found.path)
  process.exit(0)
}
