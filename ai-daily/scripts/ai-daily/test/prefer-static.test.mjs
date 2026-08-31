import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preferStaticFirst, allocateFetchBudget } from '../dedup.mjs'

// ─── 8/27 Task 1：preferStaticFirst 纯函数 + 静态候选进 Fetch 配额 ───
// 场景：discover 全失败 + harvest-fallback 仍空 → 静态兜底注入（found_via:'static-fallback'）。
// 预算紧张时若静态项排在普通候选后，会被轮询分配挤到 budgetDropped（拿不到配额）。
// preferStaticFirst 把 static-fallback 项移到数组前部，Fetch 首批（max(FETCH_BATCH, staticCount)）装下全部已分配静态项。

test('preferStaticFirst: 多个静态项全部前置且组内顺序稳定', () => {
  const targets = [
    { url: 'u1', found_via: 'rss' },
    { url: 's1', found_via: 'static-fallback' },
    { url: 'u2', found_via: 'discover' },
    { url: 's2', found_via: 'static-fallback' },
    { url: 'u3', found_via: 'rss' },
    { url: 's3', found_via: 'static-fallback' },
  ]
  const out = preferStaticFirst(targets)
  assert.equal(out.length, targets.length, '长度不变（只排序不增减）')
  assert.deepEqual(
    out.map(t => t.url),
    ['s1', 's2', 's3', 'u1', 'u2', 'u3'],
    'static-fallback 全前置，静态与普通两组各自保持原顺序'
  )
})

test('preferStaticFirst: 真实项顺序稳定（非静态项相对序不变，静态项也保持相对序）', () => {
  const targets = [
    { url: 'a', found_via: 'discover' },
    { url: 'b', found_via: 'rss' },
    { url: 'c', found_via: 'static-fallback' },
    { url: 'd', found_via: 'discover' },
  ]
  const out = preferStaticFirst(targets)
  assert.deepEqual(out.map(t => t.url), ['c', 'a', 'b', 'd'], 'c 前置，a/b/d 保持原序')
})

test('preferStaticFirst: 无静态项/空数组保持等价（元素与顺序不变）', () => {
  assert.deepEqual(preferStaticFirst([]), [], '空数组返回空数组')
  const noStatic = [{ url: 'x', found_via: 'discover' }, { url: 'y', found_via: 'rss' }]
  const out = preferStaticFirst(noStatic)
  assert.deepEqual(out.map(t => t.url), ['x', 'y'], '无静态项时逐字等价')
  assert.deepEqual(out, noStatic, '返回等价数组（含对象引用）')
})

test('preferStaticFirst: 输入数组与项对象不被修改（纯函数）', () => {
  const targets = [
    { url: 'u1', found_via: 'rss' },
    { url: 's1', found_via: 'static-fallback' },
    { url: 'u2', found_via: 'discover' },
  ]
  const snapshot = targets.map(t => ({ ...t }))
  const out = preferStaticFirst(targets)
  assert.ok(out !== targets, '返回新数组引用（不原地重排）')
  assert.deepEqual(targets.map(t => t.url), ['u1', 's1', 'u2'], '输入数组未被原地重排')
  assert.deepEqual(targets, snapshot, '输入数组对象未被修改')
})

test('preferStaticFirst: null/undefined 项按"其它"处理不报错（稳健）', () => {
  const targets = [null, { url: 's', found_via: 'static-fallback' }, undefined, { url: 'u', found_via: 'rss' }]
  const out = preferStaticFirst(targets)
  assert.equal(out.length, 4, '长度不变')
  assert.equal(out[0].url, 's', '静态项仍前置')
  assert.ok(out[1] === null && out[2] === undefined && out[3].url === 'u', 'null/undefined 归其它组且顺序稳定')
})

// ─── allocation 后首批大小为所有已分配静态项（不绕过 MAX_FETCH 上限）───
test('preferStaticFirst + allocation: 首批大小含所有已获配额的静态项', () => {
  const m = new Map([
    ['labs', [
      { url: 'https://labs.example/1', found_via: 'discover' },
      { url: 'https://labs.example/2', found_via: 'discover' },
      { url: 'https://labs.example/3', found_via: 'discover' },
      { url: 'https://labs.example/static-a', found_via: 'static-fallback' },
      { url: 'https://labs.example/static-b', found_via: 'static-fallback' },
    ]],
  ])
  const { fetchTargets } = allocateFetchBudget(m, 6)
  // allocation 内按板轮询，labs 板 5 条全部进 fetchTargets（MAX_FETCH 6 足够）
  const preferred = preferStaticFirst(fetchTargets)
  const staticCount = preferred.filter(t => t.found_via === 'static-fallback').length
  assert.equal(fetchTargets.length, 5)
  assert.equal(staticCount, 2, '两条静态候选都已在 fetchTargets 内（已获配额）')
  // 首批大小 = max(FETCH_BATCH=6, staticCount=2) = 6 → 两条静态都在首批
  const firstBatchSize = Math.max(6, staticCount)
  assert.equal(firstBatchSize, 6)
  // 前置后两条静态项落在批次前部
  assert.equal(preferred[0].found_via, 'static-fallback')
  assert.equal(preferred[1].found_via, 'static-fallback')
})

test('preferStaticFirst + 8/27 prefer 通道：静态候选有保留配额（不被预算丢弃）,MAX_FETCH 仍硬上限', () => {
  const STATIC_URL = 'https://labs.example/static1'
  const m = new Map([
    ['labs', [
      { url: 'https://labs.example/1', found_via: 'discover' },
      { url: 'https://labs.example/2', found_via: 'discover' },
      { url: STATIC_URL, found_via: 'static-fallback' },
    ]],
  ])
  // preferCap = floor(2 × 0.5) = 1 → 静态项占 1 保留位；剩余 1 slot 走轮询（两个 discover 争 1 个）
  const { fetchTargets, budgetDropped } = allocateFetchBudget(m, 2)
  assert.equal(fetchTargets.length, 2, 'MAX_FETCH=2 → 只有 2 项获配额')
  // 静态项 static1 占保留位 → 进 fetchTargets（不再被预算丢弃）
  assert.ok(fetchTargets.some(t => t.url === STATIC_URL), '静态候选优先进入 fetchTargets（prefer 通道生效）')
  const pref2 = preferStaticFirst(fetchTargets)
  assert.equal(pref2.length, 2, 'preferStaticFirst 只排序不改名额数')
  assert.ok(pref2.some(t => t.url === STATIC_URL), 'preferStaticFirst 后静态项仍在列表中')
  // 被丢弃的是普通 discover 候选（不是静态项）
  const droppedNonStatic = budgetDropped.filter(d => d.url !== STATIC_URL)
  assert.equal(droppedNonStatic.length, 1, '预算不足丢弃的是普通候选之一')
})

test('preferStaticFirst: MAX_FETCH 是硬上限（prefer 通道也不绕过）,静态候选超预算仍 drop', () => {
  // MAX_FETCH=3：preferCap=floor(3*0.5)=1 → 1 条静态占 prefer 位；剩 2 slots 走轮询也全给静态（单板）
  // → 3 条静态全进；第 4 条静态在 budgetDropped。
  const STATIC = Array.from({ length: 4 }, (_, i) => ({ url: 'https://s.example/' + i, found_via: 'static-fallback' }))
  const m = new Map([['labs', STATIC]])
  const { fetchTargets, budgetDropped } = allocateFetchBudget(m, 3)
  assert.equal(fetchTargets.length, 3, 'MAX_FETCH=3 总能装 3 条（备选足够）')
  assert.equal(fetchTargets.filter(t => t.found_via === 'static-fallback').length, 3, '静态候选填满全部 slots（prefer 优先）')
  assert.equal(budgetDropped.length, 1, '剩 1 条静态 drop（预算不足）')
})