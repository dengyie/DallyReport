// SKILL.md 语义契约锁定（8/31 review 新增）——防「探针把关 / report 单次直出」等 8/30 已废除措辞再次漂回。
// 维护函数文档的规则是「行为变 → 三处(代码注释 / 运维 doc / SKILL)必须同更」；本文件把这第三处变成可测试的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 本文件位于 <repo>/scripts/ai-daily/test/ → 向上 3 级到 <repo>/，再进 .claude/skills/ai-daily/SKILL.md
const SKILL = readFileSync(new URL('../../../.claude/skills/ai-daily/SKILL.md', import.meta.url), 'utf8')

test('SKILL.md: 探针语义为 advisory 观察（8/30 契约，不得残留否决权）', () => {
  assert.ok(SKILL.includes('探针仅观察不否决'), '应写明探针仅观察、不否决合成')
  assert.ok(SKILL.includes('advisory'), '应带 advisory 标识')
  assert.ok(!SKILL.includes('探针把关'), '不得保留「探针把关」旧否决语义')
})

test('SKILL.md: report 不再「单次直出」，有内容可重试 2 次', () => {
  assert.ok(!SKILL.includes('report 单次直出'), '不得保留 report 单次直出旧措辞')
  assert.match(SKILL, /report 至多 2 试/, '应写明「有内容时至多 2 试」')
})

test('SKILL.md: verifyInflightBuffer 描述为 360s 固定在飞（非 60s 下限）', () => {
  assert.ok(!SKILL.includes('60s timeoutMs 下限'), '不得残留 60s timeout 下限旧描述')
  assert.ok(SKILL.includes('固定 360s 在飞票'), '应描述为固定 360s 在飞票缓冲')
})

test('SKILL.md: 墙钟为软目标（不得断言严格 ≤30min 硬上界）', () => {
  assert.ok(!SKILL.includes('墙钟严格 ≤30min'), '不得保留墙钟严格硬上界断言')
  assert.ok(SKILL.includes('软目标'), '应描述为软目标')
})

// 8/31 P1：新增 args 与新降级旗标必须在 SKILL 有名有姓，否则调用方永远不会传、排查者读不懂旗标。
test('SKILL.md: P1 新增 args breakerConsecutive/breakerTotal 及其默认值在场', () => {
  assert.match(SKILL, /breakerConsecutive/, '连续失败阈值 arg 须文档化')
  assert.match(SKILL, /breakerTotal/, '累计失败阈值 arg 须文档化')
  assert.match(SKILL, /breakerConsecutive`（默认 3/, '默认值 3 与模板 ?? 3 一致')
  assert.match(SKILL, /breakerTotal`（默认 5/, '默认值 5 与模板 ?? 5 一致')
})

test('SKILL.md: P1 记录累加器「只低估」根因与两条修法，且新旗标可查', () => {
  assert.ok(SKILL.includes('只低估、永不高估'), '须写明累加器单向偏差（这是全部闸门失效的根因）')
  assert.match(SKILL, /breaker_open:/, '跳闸旗标须文档化')
  assert.match(SKILL, /wallclock_starved:/, '饥饿旗标须文档化')
  assert.match(SKILL, /单调不减/, '须写明标定读数单调性（否则误以为读数会回落）')
  assert.match(SKILL, /peak_factor/, 'meta 峰值倍率须文档化（旗标看峰值不看最新）')
  assert.ok(SKILL.includes('不') && SKILL.includes('WALL.observe'), '须写明探针超时不喂 WALL.observe')
})

// 9/01 方案 D：合成入口与总墙钟脱钩。P1 标定落地后病态跑会正确把旧 synthAllowed 打成 false，
// 已确认内容整份降 raw——入口闸门必须从文档里消失，换成 synthesisLimitMs 自身 timeout。
test('SKILL.md: 方案 D synthesisLimitMs 在场，默认 600000', () => {
  assert.match(SKILL, /synthesisLimitMs/, '合成自身 timeout arg 须文档化')
  assert.match(SKILL, /synthesisLimitMs[`"]?\s*[（(]?默认 600/, '默认值 600s 与模板 : 600000 一致')
  assert.ok(SKILL.includes('"synthesisLimitMs": 600000'), 'args JSON 示例须带 synthesisLimitMs')
})

test('SKILL.md: build 检测 find 走 vault cwd 路径，不得用镜像仓 ai-daily/ 前缀', () => {
  assert.doesNotMatch(SKILL, /find ai-daily\/scripts\/ai-daily/, 'find 不得带镜像布局前缀 ai-daily/scripts/ai-daily')
  assert.doesNotMatch(SKILL, /ai-daily\/\.claude\/workflows/, '产物路径不得带镜像前缀 ai-daily/.claude')
  assert.match(SKILL, /find scripts\/ai-daily -newer \.claude\/workflows\/ai-daily\.js/, 'find 相对 vault 根：scripts/ai-daily vs .claude/workflows/ai-daily.js')
})

test('SKILL.md: 合成入口与总墙钟脱钩（不得再写总墙钟守门/超限跳过合成）', () => {
  assert.ok(!SKILL.includes('report 由总墙钟唯一守门'), '不得保留「report 由总墙钟唯一守门」')
  assert.ok(!SKILL.includes('超限跳过合成直接降级'), '不得保留 totalLimitMs 超限跳过合成')
  assert.ok(SKILL.includes('合成') && (SKILL.includes('脱钩') || SKILL.includes('不再看总墙钟')), '须写明合成与总墙钟脱钩')
})