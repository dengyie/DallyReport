import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TPL = fs.readFileSync(path.join(HERE, '../ai-daily.template.js'), 'utf8')
const PROMPTS = fs.readFileSync(path.join(HERE, '../prompts.mjs'), 'utf8')

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
  const fallbackLines = codeLines.filter(l => l.includes('harvest-fallback') && l.includes('fallbackByUrl.push'))
  assert.ok(fallbackLines.length >= 1, '存在 fallbackByUrl.push 兜底行')
  for (const l of fallbackLines) {
    assert.match(l, /claimWindow\(\{[^}]*date:[^}]*\}\)\s*!==\s*'out'/, '必须用 claimWindow({date:...}) 函数调用且判 !== "out": ' + l.trim())
    assert.doesNotMatch(l, /claimWindow\.inWindow/, '不得用 .inWindow 方法（不存在，会崩）: ' + l.trim())
  }
})

test('fallback: 补进的条目标 found_via:"harvest-fallback" 供核查溯源', () => {
  assert.match(TPL, /found_via:\s*'harvest-fallback'/, '兜底条目 found_via 标记')
})

test('fallback: 主 boardURLMap 构造在兜底之前（防 TDZ——先构造再补）', () => {
  const mainMapIdx = TPL.split('\n').findIndex(l => /const boardURLMap\s*=\s*new Map\(\)/.test(l))
  const fallbackIdx = TPL.split('\n').findIndex(l => /Discover 失败兜底/.test(l))
  assert.ok(mainMapIdx >= 0, '主 boardURLMap 构造行在场')
  assert.ok(fallbackIdx >= 0, '兜底注释标记在场')
  assert.ok(mainMapIdx < fallbackIdx, '主 boardURLMap 必须在兜底块之前（否则 boardURLMap 在兜底块内被引用 → TDZ）')
})

test('fallback: 跳过 failed digest（!h || h.failed continue）', () => {
  assert.match(TPL, /if \(!h \|\| h\.failed\) continue/, 'harvest 失败/failed 的 digest 不作兜底源')
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
