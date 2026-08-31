#!/usr/bin/env node
// ai-daily 产物自检（宿主 Node CLI，不 inline 进 workflow 产物）。
//
// 8/31 P4 根因：launchd 上下文下 /bin/zsh **无 Full Disk Access**——`test -f` / `stat` 允许，
// 但对 `~/Library/Mobile Documents` 下文件的**读取**被拒（`wc -c`、`grep`、`ls` 全 operation not
// permitted，实测 18 次）。于是 run-daily.sh 的 `wc -c` + `grep meta.json` 自检拿到空值，
// 最近 6 次 run 全部打出空壳 `ARTIFACT-OK md_bytes= confirmed= degraded=`（自检等于没跑）。
// node（/opt/homebrew/bin/node）在同一 launchd 上下文实测可读（NODE_BYTES=5348 / 目录可列），
// 因此自检整体迁到本脚本执行。
//
// 用法：node artifact-check.mjs --date YYYY-MM-DD [--dir <DallyReport 根>]
// stdout：单行 `ARTIFACT-OK …` 或 `ARTIFACT-FAIL …`，供 run-daily.log 事后检查。
// exit：0 = 产物在场；1 = 报告缺失（调用方据此判 run 是否真出活）。

import fs from 'node:fs'
import path from 'node:path'
import { isCliMain } from './cli-main.mjs'

const DEFAULT_DIR = path.join(
  process.env.HOME || '',
  'Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport',
)

// 产物命名契约（与 template 落盘一致）：<date>-ai日报.md / <date>.meta.json
export const artifactPaths = (date, root) => ({
  report: path.join(root, date, date + '-ai日报.md'),
  meta: path.join(root, date, date + '.meta.json'),
})

// meta.json 的统计是**顶层字段**（非 stats 嵌套）——旧 shell 版 `grep '"confirmed": [0-9]*'`
// 恰好也命中顶层，语义一致；这里显式读顶层，避免再次靠 grep 形状巧合。
export const summarizeArtifacts = (date, root = DEFAULT_DIR, io = fs) => {
  const { report, meta } = artifactPaths(date, root)
  let bytes = null
  try {
    bytes = io.statSync(report).size
  } catch (e) {
    return { ok: false, line: 'ARTIFACT-FAIL report_missing err=' + (e.code || 'unknown') }
  }
  const parts = ['ARTIFACT-OK', 'md_bytes=' + bytes]
  let m = null
  try {
    m = JSON.parse(io.readFileSync(meta, 'utf8'))
  } catch (e) {
    parts.push('meta_unreadable=' + (e.code === 'ENOENT' ? 'missing' : (e.code || 'parse_error')))
    return { ok: true, line: parts.join(' ') }
  }
  parts.push('confirmed=' + (m.confirmed ?? '?'))
  parts.push('killed=' + (m.killed ?? '?'))
  parts.push('urls=' + (m.urls_fetched ?? '?') + '/' + (m.urls_discovered ?? '?'))
  // degraded 是数组：空数组要写成显式 `none`，否则「无降级」与「读不到」在日志里长得一样。
  const deg = Array.isArray(m.degraded) ? m.degraded : []
  parts.push('degraded=' + (deg.length ? '[' + deg.join(',') + ']' : 'none'))
  if (m.report_error) parts.push('report_error=' + JSON.stringify(String(m.report_error)))
  return { ok: true, line: parts.join(' ') }
}

export { isCliMain }
if (isCliMain(import.meta.url, process.argv[1])) {
  const argv = process.argv.slice(2)
  const flag = n => {
    const i = argv.indexOf(n)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  const date = flag('--date') || new Date().toISOString().slice(0, 10)
  const root = flag('--dir') || DEFAULT_DIR
  const { ok, line } = summarizeArtifacts(date, root)
  console.log(line)
  process.exit(ok ? 0 : 1)
}
