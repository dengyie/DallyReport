import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePhaseDeadlines, makeBudgetGate } from '../budget.mjs'

test('死线累加：切片 8/9/8/5 + 60s 缓冲 + 30min → 8/17/25/29/30min', () => {
  const dl = computePhaseDeadlines({ harvest: 480000, discover: 540000, fetch: 480000, verify: 300000, verifyInflightBuffer: 60000, totalLimit: 1800000 })
  assert.equal(dl.Harvest, 480000)
  assert.equal(dl.Discover, 1020000)              // 8+9=17min
  assert.equal(dl.Fetch, 1500000)                 // +8=25min
  assert.equal(dl.Verify, 1800000 - 60000)        // +5=30min 减 60s 缓冲 = 29min
  assert.equal(dl.Synthesize, 1800000) // 字段保留（方案 D 计划）；模板从不 budgetGate('Synthesize')
})

test('切片误当死线即 bug：Verify 死线必须大于 Fetch 死线（累计语义）', () => {
  const dl = computePhaseDeadlines({ harvest: 480000, discover: 540000, fetch: 480000, verify: 300000, verifyInflightBuffer: 60000, totalLimit: 1800000 })
  assert.ok(dl.Verify > dl.Fetch, 'Verify 累计死线必须在 Fetch 之后')
  assert.ok(dl.Fetch > dl.Discover)
  assert.ok(dl.Discover > dl.Harvest)
})

test('budgetGate 越线记账且同 stage 不重复 push', () => {
  const dl = computePhaseDeadlines({ harvest: 1000, discover: 1000, fetch: 1000, verify: 1000, verifyInflightBuffer: 100, totalLimit: 10000 })
  let elapsed = 5000
  const skippedLog = []
  const gate = makeBudgetGate(dl, () => elapsed, (stage, e, d) => skippedLog.push(stage))
  assert.equal(gate('Harvest').ok, false)
  assert.equal(gate('Harvest').ok, false)   // 二次越线
  assert.deepEqual(gate.skipped, ['Harvest']) // 只记一次
  assert.deepEqual(skippedLog, ['Harvest'])
})

test('budgetGate roomMs 与放行', () => {
  const dl = computePhaseDeadlines({ harvest: 480000, discover: 540000, fetch: 480000, verify: 300000, verifyInflightBuffer: 60000, totalLimit: 1800000 })
  let elapsed = 300000  // 5min，Harvest 内
  const gate = makeBudgetGate(dl, () => elapsed)
  const g1 = gate('Harvest')
  assert.equal(g1.ok, true)
  assert.equal(g1.roomMs, 180000)  // 480000-300000
  elapsed = 2000000  // 33min，全越线
  // Synthesize 字段保留但模板从不 budgetGate('Synthesize')——越线示例用 Verify，避免把死字段教成入口闸门。
  assert.equal(gate('Verify').ok, false)
  assert.equal(gate('Verify').roomMs, 0)  // roomMs 下限 0 不负
})

test('逐波重算语义：elapsed 前进后同 stage 从 ok 变 !ok', () => {
  const dl = computePhaseDeadlines({ harvest: 480000, discover: 540000, fetch: 480000, verify: 300000, verifyInflightBuffer: 60000, totalLimit: 1800000 })
  let elapsed = 1700000  // 28.3min，Verify 死线 29min 内
  const gate = makeBudgetGate(dl, () => elapsed)
  assert.equal(gate('Verify').ok, true)
  elapsed = 1750000  // 29.17min，越线
  assert.equal(gate('Verify').ok, false)
})
