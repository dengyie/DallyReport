#!/usr/bin/env node
// ai-daily 进度条（宿主 Node CLI，只读，不 inline 进 workflow 产物）。
//
// 用途：headless `run-daily.sh` 跑批时在终端单行重绘实时进度。总票数开跑前未知
// （Discover 批次产出多少 URL 事先无人知晓），**不画假百分比**；诚实显示四样：
//   ① 墙钟 vs 30min 软目标   ② 五阶段推进（agent 转录首行标题分类）
//   ③ journal 代理计数（started/result）   ④ 编排器可见 524 + 阶梯换级
// 终态一行：rc + ARTIFACT 摘要 + WALLCLOCK（复用 run-daily.log 已有格式）。
//
// 数据源（全只读）：
//   - ~/.ai-daily/run-daily.log            启动时间戳 / done rc / ARTIFACT / WALLCLOCK / API Error 524 / LADDER-*
//   - ~/.claude/projects/-Users-mango-project-claude-project-obsidian/<session>/subagents/workflows/<wf>/journal.jsonl
//   - 同目录 agent-*.jsonl                  首行 user prompt → classifyPrompt 阶段归类
//
// 用法：node progress.mjs [--once] [--log <run-daily.log>] [--projects <dir>] [--soft-limit-s 1800]
// --once 打一行即退（供测试/cron）；默认 5s 重绘（ANSI \r 单行刷新）。
// exit：run 进行中 0；终态 rc=0 → 0；终态 rc≠0 → 对应 rc；未启动 → 2。

import fs from 'node:fs'
import path from 'node:path'
import { isCliMain } from './cli-main.mjs'

export const PHASES = ['harvest', 'discover', 'fetch', 'verify', 'synth']

// 进度格单字标：收(采集)/发(发现)/抓(抓取)/核(核查)/稿(成稿)。
const PHASE_CHARS = { harvest: '收', discover: '发', fetch: '抓', verify: '核', synth: '稿' }

// 五阶段锚点与 prompts.mjs / template 的 prompt 首行逐字对齐（改 prompt 标题必须同步这里，测试锁死）。
const ANCHORS = [
  ['## 共享源 Harvest', 'harvest'],
  ['## 板块发现代理', 'discover'],
  ['## Source Extractor', 'fetch'],
  ['## 对抗性核查票', 'verify'],
  ['## 日报终稿', 'synth'],
  ['仅回复 OK', 'probe'],
]

export const classifyPrompt = text => {
  for (const [needle, phase] of ANCHORS) {
    if (typeof text === 'string' && text.includes(needle)) return phase
  }
  return null
}

const START_RE = /^===== (\S+ \S+) CST start run-daily/
const DONE_RE = /^===== \S+ \S+ CST done rc=(\d+) =====/

// 日志时间戳是本地 CST 字面量（launchd 宿主写的），直接按本地时区解析。
const parseStamp = s => {
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/)
  if (!m) return null
  return new Date(m[1] + 'T' + m[2]).getTime()
}

// 只统计**最后一次** start 之后的内容——旧 run 的 524/降级不得串账进本次。
export const parseRunState = (logText, nowMs, softLimitS = 1800) => {
  const lines = logText.split('\n')
  let lastStart = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (START_RE.test(lines[i])) { lastStart = i; break }
  }
  if (lastStart < 0) return { started: false }
  const startStamp = parseStamp(START_RE.exec(lines[lastStart])[1])
  const seg = lines.slice(lastStart)
  const state = {
    started: true,
    terminal: false,
    rc: null,
    startStampMs: startStamp,
    elapsedS: startStamp && nowMs ? Math.max(0, Math.round((nowMs - startStamp) / 1000)) : 0,
    softLimitS,
    fives24: 0,
    ladderNext: 0,
    ladderOk: 0,
    ladderFail: 0,
    ladderBudget: 0,
    artifactLine: null,
    wallclockLine: null,
  }
  for (const line of seg) {
    if (line.includes('API Error: 524')) state.fives24++
    if (line.startsWith('LADDER-NEXT')) state.ladderNext++
    else if (line.startsWith('LADDER-OK')) state.ladderOk++
    else if (line.startsWith('LADDER-FAIL')) state.ladderFail++
    else if (line.startsWith('LADDER-BUDGET')) state.ladderBudget++
    const d = DONE_RE.exec(line)
    if (d) { state.terminal = true; state.rc = Number(d[1]) }
    if (line.startsWith('ARTIFACT-')) state.artifactLine = line.trim()
    if (line.startsWith('WALLCLOCK ')) state.wallclockLine = line.trim()
  }
  return state
}

// journal.jsonl 每行一个 JSON 事件（type: started | result）。
export const countJournal = journalText => {
  let started = 0
  let results = 0
  for (const line of journalText.split('\n')) {
    try {
      const t = JSON.parse(line).type
      if (t === 'started') started++
      else if (t === 'result') results++
    } catch { /* 半行/空行跳过 */ }
  }
  return { started, results }
}

export const furthestPhase = labels => {
  let best = null
  for (const l of labels) {
    const i = PHASES.indexOf(l)
    if (i >= 0 && (best === null || i > best)) best = i
  }
  return best === null ? null : PHASES[best]
}

// 扫 projects 根下所有 session 的 subagents/workflows/wf_*/journal.jsonl，取 mtime 最新且 ≥ sinceMs。
export const findLatestJournal = (projectsDir, sinceMs, io = fs) => {
  let best = null
  let bestM = -1
  let sess
  try {
    sess = io.readdirSync(projectsDir).filter(n => /^[0-9a-f-]{36}$/.test(n))
  } catch { return null }
  for (const s of sess) {
    const wfDir = path.join(projectsDir, s, 'subagents', 'workflows')
    let wfs
    try { wfs = io.readdirSync(wfDir).filter(n => n.startsWith('wf_')) } catch { continue }
    for (const w of wfs) {
      const j = path.join(wfDir, w, 'journal.jsonl')
      let m
      try { m = io.statSync(j).mtimeMs } catch { continue }
      if (m > bestM && m >= sinceMs) { bestM = m; best = j }
    }
  }
  return best
}

// 阶段计数（诚实版）：journal 事件带 agentId，agent-<id>.jsonl 转录首行可归类阶段。
// per-phase：done = 有 result 事件的 agent 数；inflight = started 未归（转录在场但无 result）。
// 注意转录文件**持久存在**，不能拿「文件存在」当在飞——必须以 journal result 归账。
const phaseCounts = (wfDir, io) => {
  const counts = {}
  for (const p of PHASES) counts[p] = { done: 0, inflight: 0 }
  const phaseOf = {} // agentId → phase
  let files = []
  try { files = io.readdirSync(wfDir).filter(n => /^agent-.+\.jsonl$/.test(n)) } catch { return { counts, probed: 0 } }
  for (const f of files) {
    const id = f.slice('agent-'.length, -'.jsonl'.length)
    let first = ''
    try {
      const fd = io.readFileSync(path.join(wfDir, f), 'utf8')
      const nl = fd.indexOf('\n')
      first = nl >= 0 ? fd.slice(0, nl) : fd
    } catch { continue }
    let text = ''
    try {
      const o = JSON.parse(first)
      const c = o.message && o.message.content
      text = typeof c === 'string' ? c : ''
    } catch { continue }
    const ph = classifyPrompt(text)
    if (ph && ph !== 'probe') phaseOf[id] = ph
  }
  let probed = 0
  for (const line of (io.readFileSync(path.join(wfDir, 'journal.jsonl'), 'utf8')).split('\n')) {
    try {
      const o = JSON.parse(line)
      if (o.type === 'started' && o.agentId && !phaseOf[o.agentId]) probed++
      if (o.type === 'result' && o.agentId && phaseOf[o.agentId]) counts[phaseOf[o.agentId]].done++
    } catch { /* 半行/空行跳过 */ }
  }
  for (const id of Object.keys(phaseOf)) counts[phaseOf[id]].inflight++
  // started 未归 = 转录在场 - 已归账
  for (const p of PHASES) counts[p].inflight -= counts[p].done
  return { counts, probed }
}

const fmtDur = s => {
  const m = Math.floor(s / 60)
  const ss = s % 60
  return m + 'm' + String(ss).padStart(2, '0') + 's'
}

export const renderLine = s => {
  // 终态
  if (s.terminal) {
    const head = (s.rc === 0 ? '✓' : '✗') + ' ai-daily ' + s.date + ' rc=' + s.rc
    const parts = [head]
    if (s.wallclockLine) {
      const m = /real=(\d+m\d+s)/.exec(s.wallclockLine)
      if (m) parts.push('⏱' + m[1])
    }
    if (s.artifactLine) {
      // 摘要化 degraded 数组（全文在 run-daily.log），保单行可读。
      parts.push(s.artifactLine.replace(/ degraded=\[([^\]]*)\]/, (_, inner) =>
        inner === 'none' ? ' degraded=none' : ' degraded=' + inner.split(',').filter(Boolean).length + '项'))
    }
    if (s.fives24) parts.push('524×' + s.fives24)
    if (s.ladderOk) parts.push('换级救回' + s.ladderOk)
    if (s.ladderFail) parts.push('阶梯全废×' + s.ladderFail)
    return parts.join(' | ')
  }
  // 未启动
  if (!s.started) return '○ ai-daily：run-daily.log 无本次 start 标记'
  // 运行中
  const soft = s.softLimitS || 1800
  const parts = ['ai-daily ' + s.date]
  parts.push((s.elapsedS > soft ? '⚠' : '⏱') + fmtDur(s.elapsedS) + '/' + Math.round(soft / 60) + 'm')
  if (s.phases) {
    // 五阶段推进（单字标）：在飞 ●N / 完成 ✓ / 未动 ·；代理计数由各阶段 done/inflight 求和。
    const cell = p => {
      const c = s.phases[p] || { done: 0, inflight: 0 }
      if (c.inflight > 0) return PHASE_CHARS[p] + '●' + c.inflight
      if (c.done > 0) return PHASE_CHARS[p] + '✓'
      return PHASE_CHARS[p] + '·'
    }
    const sum = k => PHASES.reduce((n, p) => n + (s.phases[p] || { done: 0, inflight: 0 })[k], 0)
    parts.push(PHASES.map(cell).join(' ') + ' | 代理 ' + sum('done') + '✓ ' + sum('inflight') + '飞')
  } else if (s.journal) {
    const inflight = Math.max(0, s.journal.started - s.journal.results)
    parts.push('代理 ' + s.journal.results + '✓ ' + inflight + '飞（阶段归类不可用）')
  } else {
    parts.push('编排器阶段（workflow 未起）')
  }
  parts.push('524×' + s.fives24)
  if (s.ladderNext) parts.push('换级' + s.ladderNext)
  if (s.ladderOk) parts.push('救回' + s.ladderOk)
  if (s.ladderFail) parts.push('阶梯全废×' + s.ladderFail)
  if (s.ladderBudget) parts.push('预算停×' + s.ladderBudget)
  return parts.join(' | ')
}

const main = () => {
  const argv = process.argv.slice(2)
  const flag = n => {
    const i = argv.indexOf(n)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  const once = argv.includes('--once')
  const logPath = flag('--log') || path.join(process.env.HOME || '', '.ai-daily', 'run-daily.log')
  const projectsDir = flag('--projects') ||
    path.join(process.env.HOME || '', '.claude', 'projects', '-Users-mango-project-claude-project-obsidian')
  const softLimitS = Number(flag('--soft-limit-s')) || 1800
  const date = new Date().toISOString().slice(0, 10)

  const tick = () => {
    const nowMs = Date.now()
    let text = ''
    try { text = fs.readFileSync(logPath, 'utf8') } catch { /* 无日志当未启动 */ }
    const s = parseRunState(text, nowMs, softLimitS)
    s.date = date
    if (s.started && !s.terminal && s.startStampMs) {
      const j = findLatestJournal(projectsDir, s.startStampMs, fs)
      if (j) {
        const wfDir = path.dirname(j)
        s.journal = countJournal(fs.readFileSync(j, 'utf8'))
        s.phases = phaseCounts(wfDir, fs).counts
      }
    }
    const line = renderLine(s)
    if (once) {
      console.log(line)
    } else {
      process.stdout.write('\r\x1b[2K' + line)
    }
    return s
  }

  const first = tick()
  if (once) {
    process.exit(first.terminal ? (first.rc || 0) : (first.started ? 0 : 2))
  }
  const timer = setInterval(() => {
    const s = tick()
    if (s.terminal) {
      process.stdout.write('\n')
      clearInterval(timer)
      process.exit(s.rc || 0)
    }
  }, 5000)
}

export { isCliMain }
if (isCliMain(import.meta.url, process.argv[1])) main()
