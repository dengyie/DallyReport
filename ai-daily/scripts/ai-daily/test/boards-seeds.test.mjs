// P5（2026-09-01 修复清单第 5 项）：KNOWN_MAJOR_OUT 种子刷新 + 契约锁定。
// 原状：Astra（媒体口径预告、无第一方页）退役顶替；仅剩 V4-Pro 一条，2026-09-04 即过 21d 门禁
//   → 一旦过期，major_out 永久为 0（大事件节从每日报告消失，只能手动补）。
// 本次：Astra 退役，补 3 条官方一手页可溯源的种子（DeepSeek-V4-Flash-Vision-Exp / MHS / 科学家支持）。
// 契约：①全量强制一手页 url；②种子间 majorKey 指纹两两不同（否则 makeAddMajor 互相去重）；③落地日全存活。
// 命名坑（实测锁定）：DeepSeek 新名必须用连字符——空格形式 'DeepSeek V4-Flash…' 会命中 dedup.mjs
//   `(?:deepseek|深度求索)\s*v4` 而变 fingerprint 'deepseek-v4'，与既有 V4-Pro 种子同 key → 被静默去重。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_MAJOR_OUT } from '../boards.mjs'
import { majorKey } from '../dedup.mjs'
import { filterSeedsByAge, normalizeDate } from '../date-utils.mjs'

const MAX_SEED_AGE_DAYS = 21

test('P5：每条种子必须带官方一手页 url，且 host 全是官方域（纯媒体口径不收录）', () => {
  assert.ok(KNOWN_MAJOR_OUT.length >= 4, '种子数不得退回 （' + KNOWN_MAJOR_OUT.length + ' 条过低）')
  for (const s of KNOWN_MAJOR_OUT) {
    assert.ok(s.url && /^https:\/\//.test(s.url), s.name + ' 缺官方 url')
    assert.match(s.url, /^https:\/\/(api-docs\.deepseek\.com|www\.anthropic\.com|openai\.com|x\.ai)\//,
      s.name + ' url 必须指向官方一手域（实得 ' + s.url + '）')
  }
})

test('P5：任一已上市种子不得互相命中同一指纹（否则被去重吞掉）', () => {
  const keys = KNOWN_MAJOR_OUT.map(s => majorKey(s.name))
  assert.equal(new Set(keys).size, keys.length, '两两 key 必须不同，实得：' + JSON.stringify(keys))
  // 回归锁死命名坑：DeepSeek 新条必须用连字符形式，空格形式必被 dedup 到 V4-Pro。
  const space = majorKey('DeepSeek V4-Flash-Vision-Exp 多模态实验模型上线')
  const hyphen = majorKey('DeepSeek-V4-Flash-Vision-Exp 多模态实验模型上线')
  assert.equal(space, 'deepseek-v4', '空格形式被既有 V4 指纹吞掉（这是坑，禁止新种子叫这个名字）')
  assert.notEqual(hyphen, 'deepseek-v4', '连字符形式必须有独立指纹')
  assert.ok(keys.includes(hyphen), '现网种子必须含连字符新条目')
})

test('P5：落地日 2026-09-01 检查 21d 门禁——4 条全存活、0 条被门禁剔除', () => {
  // 落地断言固定到修复当日，是刻意：锚定「修复时种子是全量可用的」这一事实本身。
  const { kept, retired } = filterSeedsByAge(KNOWN_MAJOR_OUT, normalizeDate('2026-09-01'), MAX_SEED_AGE_DAYS)
  assert.equal(retired.length, 0, '退役名单必须为空（Astra 已退役移除，其余 age≤21）：' + JSON.stringify(retired.map(r => r.seed.name)))
  assert.equal(kept.length, KNOWN_MAJOR_OUT.length)
  for (const s of kept) assert.ok(s.date >= '2026-08-01', s.name + ' 日期过旧')
})

test('P5：任一"今天"运行当天至少 1 条存活（种子过期即有 test 提示需要刷新，不让报告静默空节）', () => {
  const today = normalizeDate(new Date().toISOString().slice(0, 10))
  const { kept } = filterSeedsByAge(KNOWN_MAJOR_OUT, today, MAX_SEED_AGE_DAYS)
  assert.ok(kept.length >= 1,
    'running day ' + today + ' 无存活种子——维护需刷新 KNOWN_MAJOR_OUT（插入 ≤21d 的新条目）')
})