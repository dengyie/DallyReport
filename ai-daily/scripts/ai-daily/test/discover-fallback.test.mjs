import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normURL } from '../date-utils.mjs'
import { buildFallback } from '../fallback.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TPL = fs.readFileSync(path.join(HERE, '../ai-daily.template.js'), 'utf8')
const PROMPTS = fs.readFileSync(path.join(HERE, '../prompts.mjs'), 'utf8')
// 8/22 第二十项：兜底构造抽为纯函数 fallback.mjs 后，兜底逻辑契约断言读 FALLBACK_SRC（非 TPL）。
const FALLBACK_SRC = fs.readFileSync(path.join(HERE, '../fallback.mjs'), 'utf8')

// 8/22 第十九项 discover empty_result 根因（systematic-debugging 实证）：
// deepseek-v4-flash 长思考后倾向 stop_reason:end_turn 返回纯文本、不调 StructuredOutput 工具
// → disc 代理 settle(null) → tries=1 不重试 → DISCOVER-FAIL → 归属板 0 claim / degraded。
// 双轨修复：①兜底——disc 失败的组，从 harvest 已抓到的 digestByKey entries 补进 boardURLMap
// （不重跑代理，省墙钟省 token）；②prompt 强化——discoverPrompt 末尾强制"必须调 StructuredOutput、
// 禁止 end_turn 返回纯文本"。本测试固化两条修复的关键契约，防回退。

// 剔除注释行：注释里出现关键字不算代码契约。
const codeLines = TPL.split('\n').filter(l => !l.trim().startsWith('//'))

test('fallback: 仅对 discover 失败组补 URL（succeedGroupKeys / failedGroups 在场）', () => {
  assert.match(TPL, /succeedGroupKeys\s*=\s*new Set\(discoverRows\.map/, 'succeedGroupKeys 由成功组 key 集合构造')
  assert.match(TPL, /failedGroups\s*=\s*DISCOVER_GROUPS\.filter\(g => !succeedGroupKeys\.has/, 'failedGroups = 失败组（key 不在成功集合里）')
})

test('fallback: 用 claimWindow({...}) 函数调用，非 .inWindow 方法（API 不匹配即崩）', () => {
  // claimWindow 是 makeClaimWindow 返回的函数 c => {...}，读 c.date/c.publishDate，返回 'in'/'out'/'unknown'。
  // 旧 bug 写成 claimWindow.inWindow(normalizeDate(e.date)) —— 调不存在的 .inWindow 方法，运行时 TypeError。
  // 8/22 第二十项重构后：兜底构造在 fallback.mjs 纯函数，claimWindow 调用断言读 FALLBACK_SRC。
  assert.match(FALLBACK_SRC, /claimWindow\(\{[^}]*date:[^}]*\}\)\s*!==\s*'out'/, '必须用 claimWindow({date:...}) 函数调用且判 !== "out"')
  assert.doesNotMatch(FALLBACK_SRC, /claimWindow\.inWindow/, '不得用 .inWindow 方法（不存在，会崩）')
})

test('fallback: 补进的条目标 found_via:"harvest-fallback" 供核查溯源', () => {
  assert.match(FALLBACK_SRC, /found_via:\s*'harvest-fallback'/, '兜底条目 found_via 标记')
})

test('fallback: 主 boardURLMap 构造在兜底之前（防 TDZ——先构造再补）', () => {
  const mainMapIdx = TPL.split('\n').findIndex(l => /const boardURLMap\s*=\s*new Map\(\)/.test(l))
  const fallbackIdx = TPL.split('\n').findIndex(l => /Discover 失败兜底/.test(l))
  assert.ok(mainMapIdx >= 0, '主 boardURLMap 构造行在场')
  assert.ok(fallbackIdx >= 0, '兜底注释标记在场')
  assert.ok(mainMapIdx < fallbackIdx, '主 boardURLMap 必须在兜底块之前（否则 boardURLMap 在兜底块内被引用 → TDZ）')
})

test('fallback: 跳过 failed digest（!h || h.failed continue）', () => {
  assert.match(FALLBACK_SRC, /if \(!h \|\| h\.failed\) continue/, 'harvest 失败/failed 的 digest 不作兜底源')
})

test('fallback: DISCOVER-FALLBACK 日志可见（降级/兜底可 grep）', () => {
  assert.match(TPL, /DISCOVER-FALLBACK/, '兜底触发时有可见日志行')
})

test('prompt: discoverPrompt 收口纪律——开头框架 + 末尾硬收尾，强制 StructuredOutput、禁 end_turn 纯文本', () => {
  // 实测缺陷：thinking 推导完却 end_turn 不调工具。优化后：开头立"唯一出口是 StructuredOutput"框架，末尾精炼硬收尾呼应。
  assert.match(PROMPTS, /收口框架（最终唯一出口/, '开头立收口框架：最终唯一出口是 StructuredOutput')
  assert.match(PROMPTS, /StructuredOutput 工具\*{0,2}返回 \{ urls, noNews, nearWindow, majorOutOfWindow, degraded \}/, '明确给出工具调用的字段结构')
  assert.match(PROMPTS, /最后一步也是调用该工具，而不是 end_turn 输出文字/, '命中 thinking→tool 卡点：最后一步是调工具非 end_turn')
  assert.match(PROMPTS, /判定为 null/, '明确告知不调工具=判定 null/降级后果')
  assert.match(PROMPTS, /严禁 end_turn 返回纯文本/, '末尾硬收尾：严禁 end_turn 纯文本')
  assert.match(PROMPTS, /这是最常见的失败模式/, '末尾标注该 end_turn 模式为常见失败模式')
  // 收口纪律不得与末尾 Structured output only. 矛盾——两者都应在场且一致
  const m = PROMPTS.match(/最终收口[\s\S]*?Structured output only\./)
  assert.ok(m, '末尾最终收口段以 Structured output only. 收束')
})

// ─── 第二十项修复（CRITICAL-1 + HIGH-2）───
// CRITICAL-1：兜底 entry board 置 null（g.boards.length === 1 ? ... : null）导致合组(media-cn/media-en)
// 失败时兜底生成的 entry 全被 if(!u.board) continue 丢弃——恰是历史高发场景。
// 修复：兜底构造抽为纯函数 buildFallback（fallback.mjs），board 按 h.feed.boards ∩ g.boards 派生，
// 每个归属板都补进 boardURLMap（dedup 跨板去重不重复抓取）。空交集跳过不灌首板。
test('fallback: 多板组兜底 board 按 feed.boards ∩ g.boards 派生，不置 null（CRITICAL-1 源级）', () => {
  // fallback.mjs 不得有 board: g.boards.length === 1 ? ... : null 这种把合组置 null 的写法
  assert.doesNotMatch(FALLBACK_SRC, /board:\s*g\.boards\.length\s*===\s*1\s*\?[^;]*:\s*null/, 'fallback.mjs 不得把合组 board 置 null')
  // 必须从 digest 的 feed.boards 与组 boards 求交派生归属板
  assert.match(FALLBACK_SRC, /feed\.boards/, 'fallback.mjs 必须读 digest feed.boards 派生归属板')
  assert.match(FALLBACK_SRC, /g\.boards\.includes\(b\)/, '按 g.boards.includes 求交集（feed.boards ∩ g.boards）')
  // 空交集跳过（不灌首板制造错误归属）
  assert.match(FALLBACK_SRC, /if \(!feedBoards\.length\) continue/, '空交集时 continue 跳过 entry')
  // template 必须调用 buildFallback（编排层只负责预算 srcUrls + 调纯函数 + 落 boardURLMap）
  assert.match(TPL, /buildFallback\(/, 'template 调用 buildFallback 纯函数构造兜底')
})

test('fallback: 兜底救回的板记入 recoveredBoards（供降级标记回收，HIGH-2）', () => {
  // 兜底构造在 buildFallback（fallback.mjs）；recoveredBoards 由其返回，外层合并进 computeBoardStates/discovery_recovered。
  assert.match(TPL, /recoveredBoards/, '存在 recoveredBoards 集合记录兜底救回的板')
  assert.match(TPL, /buildFallback\(/, 'template 调用 buildFallback 纯函数构造兜底（消除 forward-test）')
})

// ─── 运行时行为断言（直调真实 buildFallback，非复刻逻辑的 forward-test）───
// 8/22 第二十项 review 发现：旧版"运行时测试"自己复刻了修复逻辑，抓不到 template 内的静默回归。
// 抽 buildFallback 为纯函数后，测试直调它断言真实行为——若 buildFallback 被改坏（如 board 置 null、
// 空交集灌首板、窗口判定写错），这些测试会失败。

test('buildFallback: 多板组失败时 entry 落进所有归属板（CRITICAL-1 运行时）', () => {
  // media-cn 失败，digest 有 qbitai entry（feed.boards 含 5 个 media-cn 板）→ 5 板都应有兜底条目。
  // 旧 board:null 版本下，buildFallback 会把 board 置 null → 这里断言会失败。
  const digestByKey = new Map([[normURL('https://www.qbitai.com/'), {
    feed: { url: 'https://www.qbitai.com/', label: '量子位', boards: new Set(['strategy', 'funding', 'policy', 'safety', 'people']) },
    entries: [{ url: 'https://www.qbitai.com/x', title: 't', date: '2026-08-19' }], failed: false
  }]])
  const failedGroups = [{ key: 'media-cn', boards: ['strategy', 'funding', 'policy', 'safety', 'people'], srcUrls: ['https://www.qbitai.com/'] }]
  const claimWindow = c => (c && c.date) ? 'in' : 'unknown'
  const { fallbackByUrl, recoveredBoards } = buildFallback(digestByKey, failedGroups, claimWindow, normURL)
  // 1 entry × 5 板 = 5 条（每板一条，同 URL 补多板——dedup 阶段去重）
  assert.equal(fallbackByUrl.length, 5, '1 entry 补进 5 板 → 5 条 fallbackByUrl')
  for (const k of ['strategy', 'funding', 'policy', 'safety', 'people']) {
    assert.ok(fallbackByUrl.some(u => u.board === k), k + ' 应有兜底条目')
    assert.ok(recoveredBoards.has(k), k + ' 应进 recoveredBoards')
  }
  // 每条都标 found_via:'harvest-fallback'
  assert.ok(fallbackByUrl.every(u => u.found_via === 'harvest-fallback'), 'found_via 标 harvest-fallback')
})

test('buildFallback: 单板组 fallback 到该板（无回归）', () => {
  const digestByKey = new Map([[normURL('https://export.arxiv.org/api/query'), {
    feed: { url: 'https://export.arxiv.org/api/query', label: 'arXiv', boards: new Set(['academic']) },
    entries: [{ url: 'https://arxiv.org/abs/2608.16834', title: 'Model Hypnosis', date: '2026-08-17' }], failed: false
  }]])
  const failedGroups = [{ key: 'academic', boards: ['academic'], srcUrls: ['https://export.arxiv.org/api/query'] }]
  const claimWindow = () => 'in'
  const { fallbackByUrl, recoveredBoards } = buildFallback(digestByKey, failedGroups, claimWindow, normURL)
  assert.equal(fallbackByUrl.length, 1, '单板组 1 entry → 1 条')
  assert.equal(fallbackByUrl[0].board, 'academic', '归属 academic 板')
  assert.ok(recoveredBoards.has('academic'))
})

test('buildFallback: 空交集时跳过 entry，不灌首板（MEDIUM 修复）', () => {
  // 冒烟子集场景：feed.boards 与失败组 boards 求交为空（feed 订阅板被 BOARDS_SELECTED 过滤掉）。
  // 修复前：所有 entry 灌到 g.boards[0]（首板被灌满、真实板 0 claim）。修复后：跳过，不制造错误归属。
  const digestByKey = new Map([[normURL('https://techcrunch.com/category/artificial-intelligence/'), {
    feed: { url: 'https://techcrunch.com/', label: 'TC', boards: new Set(['products', 'funding']) },
    entries: [{ url: 'https://techcrunch.com/x', title: 't', date: '2026-08-19' }], failed: false
  }]])
  // 失败组 boards 不含 products/funding（被子集过滤）→ 空交集
  const failedGroups = [{ key: 'media-en', boards: ['strategy', 'policy'], srcUrls: ['https://techcrunch.com/category/artificial-intelligence/'] }]
  const claimWindow = () => 'in'
  const { fallbackByUrl, recoveredBoards } = buildFallback(digestByKey, failedGroups, claimWindow, normURL)
  assert.equal(fallbackByUrl.length, 0, '空交集 → 不补任何 entry（不灌首板制造错误归属）')
  assert.equal(recoveredBoards.size, 0, '空交集 → 无板被标 recovered')
})

test('buildFallback: 跳过 failed digest 与窗口外 entry', () => {
  const digestByKey = new Map([
    [normURL('https://www.qbitai.com/'), { feed: { url: 'https://www.qbitai.com/', boards: new Set(['safety']) }, entries: [{ url: 'https://www.qbitai.com/a', title: 'a', date: '2026-08-19' }], failed: true }], // failed → 跳过
    [normURL('https://36kr.com/'), { feed: { url: 'https://36kr.com/', boards: new Set(['funding']) }, entries: [
      { url: 'https://36kr.com/in', title: 'in', date: '2026-08-19' },     // 窗口内 → 补
      { url: 'https://36kr.com/out', title: 'out', date: '2026-07-01' },    // 窗口外 → 跳
    ], failed: false }],
  ])
  const failedGroups = [{ key: 'media-cn', boards: ['safety', 'funding'], srcUrls: ['https://www.qbitai.com/', 'https://36kr.com/'] }]
  const claimWindow = c => (c && c.date === '2026-08-19') ? 'in' : 'out'
  const { fallbackByUrl, recoveredBoards } = buildFallback(digestByKey, failedGroups, claimWindow, normURL)
  assert.equal(fallbackByUrl.length, 1, 'failed digest 跳过 + 窗口外 entry 跳过 → 仅 1 条')
  assert.equal(fallbackByUrl[0].url, 'https://36kr.com/in')
  assert.ok(recoveredBoards.has('funding') && !recoveredBoards.has('safety'), '只 funding 被救回（safety digest failed）')
})
