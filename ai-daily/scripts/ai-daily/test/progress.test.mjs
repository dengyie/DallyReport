import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PHASES,
  classifyPrompt,
  parseRunState,
  countJournal,
  furthestPhase,
  findLatestJournal,
  renderLine,
} from '../progress.mjs'

// progress.mjs：headless 跑的只读进度条（宿主 CLI，不 inline 进 workflow 产物）。
// 总票数开跑前未知 → 不画假百分比；诚实显示：墙钟 vs 30m 软目标、五阶段推进、
// journal started/result 计数、编排器可见 524、终态（rc + ARTIFACT + WALLCLOCK）。
// 约束与 artifact-check.mjs 同款：isCliMain 入口、测试全用注入 io、不碰真实文件系统。

const START = '===== 2026-09-02 18:41:59 CST start run-daily（CEILING_MS=0）====='
const DONE0 = '===== 2026-09-02 19:18:20 CST done rc=0 ====='
const DONE1 = '===== 2026-09-02 18:43:01 CST done rc=1 ====='

test('parseRunState：运行中——只统计最后一次 start 之后的内容（旧 run 的 524 不串账）', () => {
  const log = [
    '===== 2026-09-02 08:40:05 CST start run-daily（CEILING_MS=0）=====',
    'API Error: 524 {"status":524} ray=old-run',
    DONE1,
    'ARTIFACT-FAIL report_missing err=ENOENT',
    '',
    START,
    'LINUXDO-PREFETCH-OK json_bytes=8596 → 落盘',
    'API Error: 524 {"status":524} ray=new-run',
  ].join('\n')
  // 与 parseStamp 同法解析（本地时区字面量），避免手写 UTC 算术的时区/进位错。
  const nowMs = new Date('2026-09-02T18:41:59').getTime() + 25 * 60 * 1000 + 12 * 1000
  const s = parseRunState(log, nowMs)
  assert.equal(s.started, true)
  assert.equal(s.terminal, false)
  assert.equal(s.elapsedS, 25 * 60 + 12, '墙钟按宿主本地时区（CST）解析')
  assert.equal(s.fives24, 1, '只数本次 start 之后的 524（旧 run 那次不算）')
  assert.equal(s.rc, null)
})

test('parseRunState：终态 rc=0——捕获 rc/ARTIFACT/WALLCLOCK 三行', () => {
  const log = [
    START,
    'LINUXDO-PREFETCH-OK json_bytes=8596',
    DONE0,
    'ARTIFACT-OK md_bytes=8671 confirmed=8 killed=0 urls=13/40 degraded=[fetch_budget_dropped:32]',
    'WALLCLOCK real=36m21s soft_target=30m → OVER by 6m（realm 累加器低估，见运维笔记 P1）',
  ].join('\n')
  const s = parseRunState(log, 0)
  assert.equal(s.terminal, true)
  assert.equal(s.rc, 0)
  assert.match(s.artifactLine, /^ARTIFACT-OK md_bytes=8671/)
  assert.match(s.wallclockLine, /real=36m21s/)
  assert.match(s.wallclockLine, /OVER/)
})

test('parseRunState：终态 rc=1 + 无 start 日志两种边界', () => {
  const fail = parseRunState([START, 'API Error: 524 x', DONE1, 'ARTIFACT-FAIL report_missing err=ENOENT'].join('\n'), 0)
  assert.equal(fail.terminal, true)
  assert.equal(fail.rc, 1)
  assert.match(fail.artifactLine, /^ARTIFACT-FAIL/)
  const none = parseRunState('随便什么日志，没有 start 标记', 0)
  assert.equal(none.started, false)
})

test('classifyPrompt：五阶段 + 探针锚点与 prompts.mjs 标题逐字对齐', () => {
  assert.equal(classifyPrompt('## 共享源 Harvest（批量 official）\n\n窗口：…'), 'harvest')
  assert.equal(classifyPrompt('## 板块发现代理（合组：labs+opensource）\n\n窗口：…'), 'discover')
  assert.equal(classifyPrompt('## Source Extractor\n\n窗口：…抓取并提取该来源的可证伪声明：'), 'fetch')
  assert.equal(classifyPrompt('## 对抗性核查票 ' + '(voter)\n\n窗口：…'), 'verify')
  assert.equal(classifyPrompt('## 日报终稿 —— 新闻编辑简报\n\n窗口：…'), 'synth')
  assert.equal(classifyPrompt('仅回复 OK。'), 'probe')
  assert.equal(classifyPrompt('无锚点文本'), null)
})

test('countJournal：started/result 事件计数（journal.jsonl 每行一个 JSON 事件）', () => {
  const j = [
    JSON.stringify({ type: 'started', key: 'k1', agentId: 'a' }),
    JSON.stringify({ type: 'result', key: 'k1', agentId: 'a', result: { claims: [] } }),
    JSON.stringify({ type: 'started', key: 'k2', agentId: 'b' }),
    JSON.stringify({ type: 'started', key: 'k3', agentId: 'c' }),
    JSON.stringify({ type: 'result', key: 'k2', agentId: 'b', result: null }),
  ].join('\n')
  assert.deepEqual(countJournal(j), { started: 3, results: 2 })
  assert.deepEqual(countJournal(''), { started: 0, results: 0 })
})

test('furthestPhase：阶段推进取最远者（阶段不回退）', () => {
  assert.equal(furthestPhase(['harvest', 'fetch', 'fetch']), 'fetch')
  assert.equal(furthestPhase(['synth']), 'synth')
  assert.equal(furthestPhase([]), null)
  assert.equal(furthestPhase(['fetch', 'harvest']), 'fetch')
  assert.deepEqual(PHASES, ['harvest', 'discover', 'fetch', 'verify', 'synth'])
})

const fakeIo = tree => ({
  readdirSync: p => {
    if (!(p in tree)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return tree[p].dirs || []
  },
  statSync: p => {
    if (!(p in tree)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return { mtimeMs: tree[p].mtimeMs }
  },
  readFileSync: p => {
    if (!(p in tree)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    return tree[p].content ?? ''
  },
})

test('findLatestJournal：扫 projects 下 obsidian 会话的 wf_*/journal.jsonl，取 mtime 最新且 ≥ sinceMs', () => {
  const P = '/projects'
  const u1 = '11111111-1111-4111-8111-111111111111' // 实现只认 36 位 UUID 会话目录名
  const u2 = '22222222-2222-4222-8222-222222222222'
  const s1 = P + '/' + u1 + '/subagents/workflows'
  const s2 = P + '/' + u2 + '/subagents/workflows'
  const io = fakeIo({
    [P]: { dirs: [u1, u2, 'not-a-session'] },
    [P + '/' + u1]: { dirs: ['subagents'] },
    [P + '/' + u1 + '/subagents']: { dirs: ['workflows'] },
    [s1]: { dirs: ['wf_old'] },
    [s1 + '/wf_old']: { dirs: [] },
    [s1 + '/wf_old/journal.jsonl']: { content: '{"type":"started"}\n', mtimeMs: 1000 },
    [P + '/' + u2]: { dirs: ['subagents'] },
    [P + '/' + u2 + '/subagents']: { dirs: ['workflows'] },
    [s2]: { dirs: ['wf_new'] },
    [s2 + '/wf_new']: { dirs: [] },
    [s2 + '/wf_new/journal.jsonl']: { content: '{"type":"started"}\n{"type":"result"}\n', mtimeMs: 2000 },
  })
  assert.equal(findLatestJournal(P, 500, io), s2 + '/wf_new/journal.jsonl', '取最新')
  assert.equal(findLatestJournal(P, 1500, io), s2 + '/wf_new/journal.jsonl', '边界：wf_old 1000 早于 1500 被排除，wf_new 2000 在场')
  assert.equal(findLatestJournal(P, 2500, io), null, '全部早于 sinceMs → null')
  assert.equal(findLatestJournal('/nonexistent', 0, io), null, '目录缺失静默 null')
})

test('renderLine：运行中——单行含墙钟/软目标、五阶段推进、代理计数、524、换级', () => {
  const s = {
    date: '2026-09-02', started: true, terminal: false, elapsedS: 25 * 60 + 12,
    softLimitS: 1800,
    fives24: 0, ladderNext: 1, ladderOk: 1, ladderFail: 0, ladderBudget: 0,
    journal: { started: 31, results: 16 },
    phases: { harvest: { done: 3, inflight: 0 }, discover: { done: 2, inflight: 1 }, fetch: { done: 0, inflight: 4 }, verify: { done: 0, inflight: 0 }, synth: { done: 0, inflight: 0 } },
  }
  const line = renderLine(s)
  assert.match(line, /⏱25m12s\/30m/)
  assert.match(line, /收✓/)
  assert.match(line, /发●1/)
  assert.match(line, /抓●4/)
  assert.match(line, /核·/)
  assert.match(line, /稿·/)
  assert.match(line, /代理 5✓ 5飞/)
  assert.match(line, /524×0/)
  assert.match(line, /换级1/, 'ladderNext>0 时显示换级次数')
})

test('renderLine：超软目标打 ⚠；终态 rc=0/1 两态；编排器阶段（journal 未起）', () => {
  const over = renderLine({ date: '2026-09-02', started: true, terminal: false, elapsedS: 2100, fives24: 2, ladderNext: 0, ladderOk: 0, ladderFail: 0, ladderBudget: 0, journal: { started: 3, results: 0 }, phases: { harvest: { done: 0, inflight: 3 }, discover: { done: 0, inflight: 0 }, fetch: { done: 0, inflight: 0 }, verify: { done: 0, inflight: 0 }, synth: { done: 0, inflight: 0 } } })
  assert.match(over, /⚠/)
  const ok = renderLine({ date: '2026-09-02', started: true, terminal: true, rc: 0, artifactLine: 'ARTIFACT-OK md_bytes=8671 confirmed=8', wallclockLine: 'WALLCLOCK real=36m21s soft_target=30m → OVER by 6m', fives24: 0, ladderNext: 1, ladderOk: 1, ladderFail: 0, ladderBudget: 0 })
  assert.match(ok, /^✓/)
  assert.match(ok, /rc=0/)
  assert.match(ok, /ARTIFACT-OK md_bytes=8671/)
  const bad = renderLine({ date: '2026-09-02', started: true, terminal: true, rc: 1, artifactLine: 'ARTIFACT-FAIL report_missing err=ENOENT', wallclockLine: null, fives24: 1, ladderNext: 0, ladderOk: 0, ladderFail: 0, ladderBudget: 0 })
  assert.match(bad, /^✗/)
  assert.match(bad, /rc=1/)
  const orch = renderLine({ date: '2026-09-02', started: true, terminal: false, elapsedS: 90, fives24: 0, ladderNext: 0, ladderOk: 0, ladderFail: 0, ladderBudget: 0, journal: null, phases: null })
  assert.match(orch, /编排器/, 'journal 未起 → 显示编排器阶段')
})
