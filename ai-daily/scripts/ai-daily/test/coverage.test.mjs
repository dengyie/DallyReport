// 板级降级判定回归测试 — 锁死「按板归属组统一」语义。
//
// 背景 bug（2026-08-21 全量实测）：
//   「降级」判定原本只用 failedBoardKeys = 「板不在任何返回组」+ discoverRows.some(d.degraded)。
//   media-cn 组失败（disc:media-cn null → DISCOVER-FAIL）时：
//     - safety/people 由 media-cn 独占 → 无返回 → 标 missing（上报 discovery_degraded:missing_safety+people）✓
//     - strategy/funding/policy 由 media-en 兜底（有返回）→ 不算 failed → 既不标 missing 也不标 [degraded]
//     → 同一失败组，共享板全静默。policy 0 claims 却无任何降级迹象 = 缺报。
//   且 labs 组「有返回但自报 degraded」（主源通道空）→ 原判为 [degraded]（通道降级，应保留）。
// 修复：板 degraded = 任一归属组失败（无返回）或 返回的组自报 degraded；
//       板 missing   = 所有归属组全部无返回（无任何发现覆盖）。
//   media-cn 失败 → strategy/funding/policy/safety/people 全 degraded；missing 只留 safety/people。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeBoardStates, BOARDS } from '../boards.mjs'

// discoverRows 元素形状与 template 内 safeAgent.then 产物一致：{ group: { key }, degraded }
const grp = (key, degraded = false) => ({ group: { key }, degraded })

const ALL_KEYS = BOARDS.map(b => b.key)

// 8/21 实况：media-cn 失败（无返回），其余 4 组成功，其中 labs 自报通道降级。
// 8/23 linuxdo 接入：linuxdo 组始终有返回（默认 no_cdp_host 不降级），故真实行集合含 linuxdo。
function rows821() {
  return [grp('labs', true), grp('opensource'), grp('academic'), grp('media-en'), grp('linuxdo')]
}

test('8/21 实况：media-cn 失败 → 5 覆盖板全 degraded，missing 只留独占板', () => {
  const st = computeBoardStates(rows821(), ALL_KEYS)
  // 失败组覆盖的全部板都 degraded（含被 media-en 兜底、有 URL 的）
  for (const k of ['strategy', 'funding', 'policy', 'safety', 'people']) {
    assert.equal(st.get(k).degraded, true, k + ' 应标 degraded（media-cn 失败）')
  }
  // 只有 media-cn 独占板 missing
  assert.equal(st.get('safety').missing, true, 'safety missing（media-cn 独占失败）')
  assert.equal(st.get('people').missing, true, 'people missing')
  for (const k of ['strategy', 'funding', 'policy', 'products']) {
    assert.equal(st.get(k).missing, false, k + ' 不 missing（media-en 兜底有返回）')
  }
  // 独立单板组正常
  for (const k of ['opensource', 'academic', 'labs']) {
    assert.equal(st.get(k).missing, false, k + ' 不 missing')
  }
  // opensource/academic 完全不降级
  for (const k of ['opensource', 'academic']) {
    assert.equal(st.get(k).degraded, false, k + ' 不应 degraded')
  }
})

test('labs 通道降级保留：有返回 + degraded → degraded 但不 missing', () => {
  const st = computeBoardStates(rows821(), ALL_KEYS)
  assert.equal(st.get('labs').degraded, true, 'labs 通道降级应保留')
  assert.equal(st.get('labs').missing, false, 'labs 有返回，不 missing')
})

test('全组正常 → 任何板不降级/missing', () => {
  const rows = [
    grp('labs'), grp('opensource'), grp('academic'), grp('media-cn'), grp('media-en'), grp('linuxdo'),
  ]
  const st = computeBoardStates(rows, ALL_KEYS)
  for (const k of ALL_KEYS) {
    assert.equal(st.get(k).degraded, false, k + ' 不应 degraded')
    assert.equal(st.get(k).missing, false, k + ' 不应 missing')
  }
})

test('媒体两组都失败 → 共享板 missing + degraded', () => {
  const rows = [grp('labs'), grp('opensource'), grp('academic'), grp('linuxdo')]  // media-* 无返回
  const st = computeBoardStates(rows, ALL_KEYS)
  for (const k of ['strategy', 'funding', 'policy', 'safety', 'people', 'products']) {
    assert.equal(st.get(k).degraded, true, `${k} 都应 degraded`)
    assert.equal(st.get(k).missing, true, `${k} 都应 missing`)
  }
})

test('子集板（冒烟）只输出传入子集', () => {
  const rows = [grp('labs', true), grp('opensource')]
  const subset = ['labs', 'strategy', 'opensource']
  const st = computeBoardStates(rows, subset)
  assert.deepEqual([...st.keys()].sort(), [...subset].sort(), '只输出传入子集的板')
  assert.equal(st.get('labs').degraded, true, 'labs degraded（通道降级）')
  assert.equal(st.get('strategy').missing, true, 'strategy 子集里 media-cn 失败 → missing')
  assert.equal(st.get('opensource').missing, false, 'opensource 正常')
})

// ─── 第二十项 HIGH-2：兜底救回的板不再标 missing，保留 degraded 通道降级 + recovered 溯源 ───
// 8/22 修复：disc 失败但兜底已从 harvest entries 补 URL 的板，computeBoardStates 收到 recoveredKeys 后：
//   missing:false（有覆盖，不再显示 unreached/无覆盖）、degraded:true（通道失败如实保留）、recovered:true（溯源）。
test('兜底救回的板：missing 降为 false，degraded 保留 true，标 recovered', () => {
  // 8/21 实况：media-cn 失败，safety/people 独占失败
  const rows = rows821()
  // 假设兜底救回了 safety（harvest 的 qbitai entry 补进 safety）
  const st = computeBoardStates(rows, ALL_KEYS, ['safety'])
  assert.equal(st.get('safety').missing, false, 'safety 被兜底救回 → 不再 missing')
  assert.equal(st.get('safety').degraded, true, 'safety 通道仍失败 → degraded 保留')
  assert.equal(st.get('safety').recovered, true, 'safety 标 recovered 供溯源')
  // 未救回的独占板 people 仍 missing（兜底没补到）
  assert.equal(st.get('people').missing, true, 'people 未被兜底救回 → 仍 missing')
  assert.equal(st.get('people').recovered, undefined, 'people 无 recovered 标记')
})

test('recoveredKeys 为空时行为与无参数一致（向后兼容）', () => {
  const rows = rows821()
  const withoutArg = computeBoardStates(rows, ALL_KEYS)
  const withEmpty = computeBoardStates(rows, ALL_KEYS, [])
  for (const k of ALL_KEYS) {
    assert.equal(withEmpty.get(k).missing, withoutArg.get(k).missing, k + ' missing 一致')
    assert.equal(withEmpty.get(k).degraded, withoutArg.get(k).degraded, k + ' degraded 一致')
    assert.equal(withEmpty.get(k).recovered, undefined, k + ' 无 recovered（无兜底）')
  }
})

test('recovered 不影响完全成功的板（无失败组）', () => {
  const rows = [grp('labs'), grp('opensource'), grp('academic'), grp('media-cn'), grp('media-en'), grp('linuxdo')]
  const st = computeBoardStates(rows, ALL_KEYS, ['labs'])  // labs 本就成功，误传 recovered 不应打标记
  assert.equal(st.get('labs').degraded, false, 'labs 成功 → 不 degraded')
  assert.equal(st.get('labs').missing, false, 'labs 成功 → 不 missing')
  assert.equal(st.get('labs').recovered, undefined, 'labs 无失败组 → recovered 不打标（仅在失败/降级路径上才标）')
})