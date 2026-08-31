import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { starvationFactor, makeCalibratedElapsed, makeCircuitBreaker } from '../wallclock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TPL = fs.readFileSync(path.join(HERE, '../ai-daily.template.js'), 'utf8')

// 8/31 P1：realm 累加器在事件循环饱和下只低估（实测 4.7–7.6×），30min 软目标形同不存在。
// 本段锁死「定时器超时可反推真实经过下界」的标定契约 + 不依赖时钟的计数型断路器。

test('P1：饥饿倍率 = 真实经过 / 累加器增量，恒 ≥1（累加器只低估）', () => {
  assert.equal(starvationFactor(1000, 1000), 1, '健康：倍率 1')
  assert.equal(starvationFactor(360000, 50000), 7.2, '饱和：360s 定时器只累加 50s → 7.2×')
  assert.equal(starvationFactor(1000, 2000), 1, '累加器若快于真实（不该发生）也不得 <1')
  assert.equal(starvationFactor(1000, 0), null, 'tick 完全饿死 → 无从取比值，返回 null')
  assert.equal(starvationFactor(0, 1000), null, '无真实证据 → null')
})

test('P1：8/31 三个检查点——标定后读数不再低估到放行', () => {
  // 复刻 8/31：Fetch gate 真实 6981s 而累加器只报 1500s 以下 → 闸门放行。
  // 标定器在此前已由若干超时代理观测到饥饿倍率 ≈4.7×。
  let raw = 0
  const clock = makeCalibratedElapsed(() => raw)
  // 一个名义 360s 的代理超时了，同窗口累加器只涨了 76s → 观测到 ≈4.7×
  clock.observe(360000, 76000)
  assert.ok(clock.factor > 4.5 && clock.factor < 5, '倍率标定到 ≈4.7×（实得 ' + clock.factor.toFixed(2) + '）')
  // 此时原始累加器读 1480s（<1500s 死线，旧版放行）
  raw = 1480000
  const corrected = clock.elapsed()
  assert.ok(corrected > 1500000, '标定后 ' + Math.round(corrected / 1000) + 's 已越 Fetch 死线 1500s（旧版 1480s 放行）')
})

test('P1：elapsed 单调不减——倍率回落不得让已越线阶段「复活」', () => {
  let raw = 100000
  const clock = makeCalibratedElapsed(() => raw)
  clock.observe(360000, 40000)      // 9× 饥饿
  const high = clock.elapsed()
  assert.ok(high > 800000, '重度饥饿下读数被放大')
  clock.observe(360000, 360000)     // 网关恢复健康 → 倍率回落到 1
  assert.equal(clock.factor, 1, '倍率跟得上恢复')
  assert.ok(clock.elapsed() >= high, '读数不得倒退（时间绝不倒流）')
})

test('P1：无观测时等价于原始累加器（默认行为不变，健康跑零影响）', () => {
  let raw = 0
  const clock = makeCalibratedElapsed(() => raw)
  raw = 12345
  assert.equal(clock.elapsed(), 12345, '未标定 → 倍率 1，逐字节等价原累加器')
  assert.equal(clock.observations, 0)
})

test('P1：倍率封顶防单次异常观测放飞', () => {
  let raw = 1000
  const clock = makeCalibratedElapsed(() => raw, { maxFactor: 20 })
  clock.observe(600000, 1)  // 病态观测：会算出 600000×
  assert.equal(clock.factor, 20, '封顶到 maxFactor')
})

test('P1：断路器连续失败跳闸（不依赖时钟，饱和下仍准确）', () => {
  const cb = makeCircuitBreaker({ consecutive: 3, total: 99 })
  assert.equal(cb.record(false, 'disc:labs'), true, '第 1 次失败未跳闸')
  assert.equal(cb.record(false, 'disc:academic'), true, '第 2 次未跳闸')
  assert.equal(cb.record(false, 'disc:funding'), false, '第 3 次连续失败 → 跳闸')
  assert.equal(cb.open(), true)
  assert.match(cb.reason(), /^consecutive_failures:3@disc:funding$/)
})

test('P1：成功清零连续计数（间歇失败不误跳闸）', () => {
  const cb = makeCircuitBreaker({ consecutive: 3, total: 99 })
  cb.record(false); cb.record(false); cb.record(true)
  assert.equal(cb.stats.consecutive, 0, '成功清零连续计数')
  assert.equal(cb.record(false), true, '再失败仅为连续 1，不跳闸')
  assert.equal(cb.open(), false)
  assert.deepEqual(cb.stats, { failures: 3, successes: 1, consecutive: 1 })
})

test('P1：累计失败达阈值也跳闸（间歇但整体已崩）', () => {
  const cb = makeCircuitBreaker({ consecutive: 99, total: 5 })
  for (let i = 0; i < 4; i++) { cb.record(false); cb.record(true) }
  assert.equal(cb.open(), false, '4 次间歇失败未达累计阈值')
  cb.record(false)
  assert.equal(cb.open(), true, '第 5 次累计失败 → 跳闸')
  assert.match(cb.reason(), /^total_failures:5/)
})

test('P1：跳闸原因只记首次（后续失败不覆盖，溯源稳定）', () => {
  const cb = makeCircuitBreaker({ consecutive: 2, total: 99 })
  cb.record(false, 'a'); cb.record(false, 'b')
  const first = cb.reason()
  cb.record(false, 'c')
  assert.equal(cb.reason(), first, '原因不被后续失败覆盖')
})

test('P1：全成功永不跳闸（健康跑零副作用）', () => {
  const cb = makeCircuitBreaker()
  for (let i = 0; i < 20; i++) assert.equal(cb.record(true, 'ok' + i), true)
  assert.equal(cb.open(), false)
  assert.equal(cb.reason(), null)
})

// ── 模板接线（源级）：模块存在但没接上等于没修，8/31 的病症正是「闸门在场却读到假读数」。──

test('P1 接线：所有墙钟消费点走标定后的 RUN_ELAPSED，原始累加器只喂 WALL', () => {
  assert.match(TPL, /const RUN_ELAPSED_RAW = \(\) => now\(\) - RUN_START/, '原始累加器改名 RUN_ELAPSED_RAW')
  assert.match(TPL, /const WALL = makeCalibratedElapsed\(RUN_ELAPSED_RAW\)/, 'WALL 包住原始累加器')
  assert.match(TPL, /const RUN_ELAPSED = \(\) => WALL\.elapsed\(\)/, 'RUN_ELAPSED 转发到标定读数')
  // 关键回归：除定义行与 meta 对账行外，不得再有别处直接读原始累加器（否则该闸门仍被骗）。
  const rawReads = TPL.split('\n').filter(l => /RUN_ELAPSED_RAW\(\)/.test(l) && !/const RUN_ELAPSED_RAW =/.test(l))
  assert.equal(rawReads.length, 1, '原始读数只允许 meta 对账处一次，实得：' + JSON.stringify(rawReads))
  assert.match(rawReads[0], /raw_s/, '唯一的原始读数用于 meta.wallclock.raw_s 对账')
})

test('P1 接线：withDeadline 超时把「真实经过 ≥ ms」喂给 WALL.observe', () => {
  assert.match(TPL, /const t0 = _wallMs/, '超时窗口起点取累加器快照')
  assert.match(TPL, /WALL\.observe\(ms, _wallMs - t0\)/, '真超时 → observe(名义 ms, 同窗口累加器增量)')
  assert.match(TPL, /饥饿倍率/, '标定结果有可 grep 日志')
})

test('P1 接线：Discover 批首查 BREAKER.open() 并跳余批（计数闸门不依赖时钟）', () => {
  assert.match(TPL, /if \(BREAKER\.open\(\)\) \{/, 'Discover 批边界消费断路器')
  assert.match(TPL, /BREAKER-OPEN Discover 余批跳过/, '跳闸有可 grep 日志')
  // 闸门必须在 Discover 批循环内、且在放行代理之前（与既有 BUDGET-BREAK 同一位置层）。
  const loop = TPL.indexOf("for (const batch of chunkArr(DISCOVER_GROUPS, DISCOVER_BATCH))")
  const gate = TPL.indexOf('if (BREAKER.open()) {')
  const cdpBlock = TPL.indexOf('for (const g of batch) {')
  assert.ok(loop > 0 && gate > loop && gate < cdpBlock, '闸门位于批循环内、放行任何本批工作之前')
})

test('P1 接线：safeAgent 三条终局路径全部记账，成功路径清零', () => {
  const seg = TPL.slice(TPL.indexOf('const safeAgent'), TPL.indexOf('const _TICK_MS'))
  assert.equal((seg.match(/BREAKER\.record\(false/g) || []).length, 2, '两条终局失败路径（异常终局 + tries 用尽/超时）')
  assert.equal((seg.match(/BREAKER\.record\(true/g) || []).length, 1, '成功路径记一次（清零连续计数）')
  assert.doesNotMatch(seg, /BREAKER\.record\([^)]*\)\s*;?\s*continue/, 'retry 中途不得记账（只记终局，否则重试被当独立失败）')
})

test('P1 接线：跳闸与饥饿写进 degraded + meta，run 后可审计', () => {
  assert.match(TPL, /degradedFlags\.push\('breaker_open:' \+ BREAKER\.reason\(\)\)/, '跳闸进降级旗标')
  assert.match(TPL, /degradedFlags\.push\('wallclock_starved:'/, '饥饿倍率显著时进降级旗标')
  assert.match(TPL, /wallclock: \{/, 'meta 带 wallclock 对账块')
  assert.match(TPL, /breaker: \{ open: BREAKER\.open\(\), reason: BREAKER\.reason\(\)/, 'meta 带 breaker 账')
})

test('P1 接线：wallclock_starved 阈值 1.5× 且要求有真实观测（健康跑不打旗标）', () => {
  // 复刻模板条件，锁死「无观测不打标」「1.0× 不打标」「4.7× 打标」三态。
  const flag = (observations, factor) => (observations > 0 && factor > 1.5) ? 'wallclock_starved:' + factor.toFixed(1) + 'x' : null
  assert.equal(flag(0, 1), null, '健康跑（零观测）无旗标')
  assert.equal(flag(3, 1.2), null, '轻微抖动不打标')
  assert.equal(flag(2, 4.74), 'wallclock_starved:4.7x', '8/31 级饥饿打标')
  assert.match(TPL, /WALL\.observations > 0 && WALL\.factor > 1\.5/, '模板条件与本测试同源')
})
