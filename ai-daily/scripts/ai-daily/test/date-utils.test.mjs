import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDate, makeClaimWindow, normURL, hostOf, chunkArr, pad2, daysBetween, filterSeedsByAge } from '../date-utils.mjs'

test('normalizeDate ISO 与变体', () => {
  assert.equal(normalizeDate('2026-08-17'), 20260817)
  assert.equal(normalizeDate('2026-8-7'), 20260807)
  assert.equal(normalizeDate('2026/08/17'), 20260817)
  assert.equal(normalizeDate('20260817'), 20260817)
})

test('normalizeDate MM-DD-YYYY 与英文月份', () => {
  assert.equal(normalizeDate('08-17-2026'), 20260817)
  assert.equal(normalizeDate('8/7/2026'), 20260807)
  assert.equal(normalizeDate('Aug 17, 2026'), 20260817)
  assert.equal(normalizeDate('August 7 2026'), 20260807)
  assert.equal(normalizeDate('2026, 17'), null)  // 无月份前缀不命中英文分支
})

test('normalizeDate 空/垃圾输入', () => {
  assert.equal(normalizeDate(null), null)
  assert.equal(normalizeDate(''), null)
  assert.equal(normalizeDate('昨天'), null)
  assert.equal(normalizeDate('2026-13-45'), 20261345)  // 数值化不校验月份合法性（现行语义）
})

test('makeClaimWindow 窗口门 in/out/unknown', () => {
  const cw = makeClaimWindow(20260815, 20260817)
  assert.equal(cw({ publishDate: '2026-08-16' }), 'in')
  assert.equal(cw({ publishDate: '2026-08-15' }), 'in')   // 边界含
  assert.equal(cw({ publishDate: '2026-08-17' }), 'in')   // 边界含
  assert.equal(cw({ publishDate: '2026-08-14' }), 'out')
  assert.equal(cw({ publishDate: '2026-08-18' }), 'out')
  assert.equal(cw({}), 'unknown')                          // 无日期
  assert.equal(cw({ publishDate: '2026-08-16', date: '2026-08-10' }), 'out')  // 任一超窗即 out（every 语义）
})

test('makeClaimWindow 跨年边界', () => {
  const cw = makeClaimWindow(20261230, 20270102)
  assert.equal(cw({ publishDate: '2026-12-31' }), 'in')
  assert.equal(cw({ publishDate: '2027-01-01' }), 'in')
  assert.equal(cw({ publishDate: '2026-12-29' }), 'out')
})

test('normURL 归一化（去协议/www/尾斜杠/大小写）', () => {
  assert.equal(normURL('https://www.qbitai.com/'), 'qbitai.com')
  assert.equal(normURL('https://TechCrunch.com/AI/'), 'techcrunch.com/ai')
  assert.equal(normURL('not-a-url'), 'not-a-url')
})

test('hostOf 提取主机', () => {
  assert.equal(hostOf('https://x.ai/news'), 'x.ai')
  assert.equal(hostOf(''), 'unknown')
  assert.equal(hostOf(null), 'unknown')
})

test('chunkArr 分批', () => {
  assert.deepEqual(chunkArr([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]])
  assert.deepEqual(chunkArr([], 6), [])
})

test('pad2', () => {
  assert.equal(pad2(7), '07')
  assert.equal(pad2(12), '12')
})

test('daysBetween：基础差/同日/闰年/非闰年/跨年/负差', () => {
  assert.equal(daysBetween(20260731, 20260820), 20)
  assert.equal(daysBetween(20260820, 20260820), 0)
  assert.equal(daysBetween(20200229, 20200301), 1)              // 闰年 2020
  assert.equal(daysBetween(20200228, 20200301), 2)
  assert.equal(daysBetween(20210228, 20210301), 1)              // 非闰年 2021
  assert.equal(daysBetween(20210227, 20210301), 2)
  assert.equal(daysBetween(20251231, 20260101), 1)              // 跨年
  assert.equal(daysBetween(20260821, 20260820), -1)             // seed 在 report 之后
})

test('filterSeedsByAge：≤阈保留/超阈滤除/无日期滤除/fail-open 全保留 + 区分 retire 原因', () => {
  const seeds = [
    { name: 'fresh', date: '2026-08-19' },   // 距 20260820 = 1
    { name: 'at-21', date: '2026-07-30' },   // 距 21（含）
    { name: 'over-1', date: '2026-07-29' },  // 距 22
    { name: 'none', date: '' },              // normalizeDate→null
  ]
  const r = filterSeedsByAge(seeds, 20260820, 21)
  assert.deepEqual(r.kept.map(s => s.name), ['fresh', 'at-21'])
  assert.equal(r.retired.length, 2, '2 个退役')
  // 超期退役
  const exp = r.retired.find(x => x.seed.name === 'over-1')
  assert.ok(exp, 'over-1 在退役列表')
  assert.equal(exp.reason, 'expired')
  assert.equal(exp.age, 22)
  assert.equal(exp.max, 21)
  // 日期不可解析退役
  const unp = r.retired.find(x => x.seed.name === 'none')
  assert.ok(unp, 'none 在退役列表')
  assert.equal(unp.reason, 'unparseable')
  assert.equal(unp.raw, '')
  // fail-open
  const fo = filterSeedsByAge(seeds, null, 21)
  assert.deepEqual(fo.kept.map(s => s.name), seeds.map(s => s.name)) // fail-open 全保留
  assert.deepEqual(fo.retired, [])
  assert.equal(seeds.length, 4)  // 不改原数组
})
