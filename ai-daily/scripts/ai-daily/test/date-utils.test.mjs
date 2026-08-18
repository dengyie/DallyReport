import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDate, makeClaimWindow, normURL, hostOf, chunkArr, pad2 } from '../date-utils.mjs'

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
