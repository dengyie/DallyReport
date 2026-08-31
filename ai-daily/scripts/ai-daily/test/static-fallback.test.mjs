import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATIC_FALLBACK_SOURCES } from '../boards.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TPL = fs.readFileSync(path.join(HERE, '../ai-daily.template.js'), 'utf8')
const TOP = TPL.split('\n').filter(l => !l.trim().startsWith('//'))
const INJECT_START = TPL.indexOf('const staticFallbackBoards = new Set()')
const INJECT = TPL.slice(INJECT_START)                                    // 注入块（含外层 if 与 log）直到文件尾

// ─── 2026-08-26 静态编辑兜底源（static-fallback）───
// 背景：discover 代理全失败 + harvest-fallback（found_via:'harvest-fallback'）仍没给到该板 → 板 0 claim。
// 修复：从 STATIC_FALLBACK_SOURCES 注入精选常驻一级/官方新闻页 URL 进 boardURLMap（found_via:'static-fallback'），
// 让 fetch→verify 仍对抗式处理。本测试固化契约，防回退。
//
// 8/26 触发条件收宽（第二次，wf_f7cc4d14 生产实证）：disc:labs/disc:opensource 组成功返回（done + StructuredOutput）
// 但 urls:[] 且自报 degraded（labs「主源空白→立即降级」、opensource「3 次 X 搜索均 degraded」）
// → 旧触发只看「组是否全失败(null)」→ 不注入 → 板仍 0/0。
// 新触发两条件任一即注入：(A) 全部归属组均无返回行（missing）；(B) 所有归属组返回的行 urls 均为 []
// 且其中至少一个行 self-degraded（通道坏但组活着）。任一归属组给了 URL（delivered）则不注入。

test('static-fallback: 静态源表定义在场且每板有精选 URL', () => {
  assert.ok(Array.isArray(STATIC_FALLBACK_SOURCES) && STATIC_FALLBACK_SOURCES.length > 0, 'STATIC_FALLBACK_SOURCES 非空')
  for (const s of STATIC_FALLBACK_SOURCES) {
    assert.equal(typeof s.board, 'string', 'board 为 string')
    assert.match(s.url, /^https?:\/\//, 'url 必须 https')
    assert.ok(s.title, 'title 必填')
  }
  // 至少覆盖最脆弱的两板（8/26 降级板）
  const boards = new Set(STATIC_FALLBACK_SOURCES.map(s => s.board))
  assert.ok(boards.has('labs'), 'labs 板有静态源')
  assert.ok(boards.has('opensource'), 'opensource 板有静态源')
})

test('static-fallback: 模板在 allocateFetchBudget 之前注入静态 URL（防拿不到配额）', () => {
  const idxAlloc = TPL.indexOf('allocateFetchBudget(boardURLMap, MAX_FETCH)')
  assert.ok(idxAlloc >= 0 && INJECT_START >= 0, '两处代码行在场')
  assert.ok(INJECT_START < idxAlloc, '静态注入定义必须早于 allocateFetchBudget（否则静态 URL 拿不到分配配额）')
})

test('static-fallback: 注入条目带 found_via:"static-fallback" + board + date', () => {
  assert.match(TPL, /found_via:\s*'static-fallback'/, '注入条目标记 found_via static-fallback')
  // 8/27 契约更新：arr.push → arr.unshift——静态项先进 boardURLMap 数组前部，allocation 每板每轮取 1 个
  // 的首额先命中静态兜底 URL（否则被排在普通候选后、预算紧张时挤到 budgetDropped 拿不到配额）。
  assert.match(TPL, /arr\.unshift\(\{ \.\.\.s, found_via/, '注入 arr.unshift 携带 spread + 覆写字段（静态前置）')
  assert.match(TPL, /\.\.\.s, found_via:\s*'static-fallback', date:\s*DATE, board:\s*key/, 'found_via/date/board 三字段保真固定在注入行')
})

test('static-fallback: 静态注入必须先于 allocateFetchBudget（unshift 的候选能进配额）', () => {
  const idxAlloc = TPL.indexOf('allocateFetchBudget(boardURLMap, MAX_FETCH)')
  const idxStatic = TPL.indexOf('const staticFallbackBoards = new Set()')
  const idxUnshift = TPL.indexOf('arr.unshift({ ...s, found_via')
  assert.ok(idxAlloc >= 0 && idxStatic >= 0 && idxUnshift >= 0, '三处行在场')
  assert.ok(idxUnshift > idxStatic && idxUnshift < idxAlloc, '静态 unshift 注入必须发生在 allocateFetchBudget 之前（否则拿不到配额）')
})

test('static-fallback: 注入块不得引用 boardStates（板派生计算点在 allocate 之后，TDZ 禁区）', () => {
  // 静态注入在 allocate 之前、boardStates 计算（computeBoardStates）之前是禁区——这里必须只用
  // 已算好的 discoverRows / recoveredBoards 派生，绝不引用 boardStates。注入块（<2000 字符）内无 boardStates。
  const injectStart = TPL.indexOf('const staticFallbackBoards = new Set()')
  const injectBlock = TPL.slice(injectStart, injectStart + 2000)
  assert.ok(!injectBlock.includes('boardStates'), '注入块不得引用 boardStates（其计算点在 allocate 之后）')
})

test('static-fallback: linuxdo 板不注入静态源 + 已复回板不重复注入', () => {
  const injectBlock = TPL.slice(INJECT_START, INJECT_START + 2000)
  assert.match(injectBlock, /key === 'linuxdo'/, 'linuxdo 板被显式跳过（无静态源）')
  assert.match(injectBlock, /recoveredBoards\.has\(key\)/, 'harvest-fallback 已复回的板不重复注入')
})

// ─── 8/26 新契约：触发条件收宽至今「全失败 或 通道旧(返回 0 候选 + degraded)」 ───

test('static-fallback: 宽触发——组返回但 0 候选 + degraded → 注入路径存在', () => {
  // 组成功返回（不是 null）但 urls:[] 且自报 degraded（通道坏但组活着）→ 应走上注入路径。
  const injectBlock = TPL.slice(INJECT_START, INJECT_START + 2000)
  assert.match(injectBlock, /discoverRows\.find\(d => d\.group\.key === g\.key\)/, 'rowsOf 按组 key 查返回行（复用已有 discoverRows，不新建 map）')
  assert.match(injectBlock, /r\.urls\.length === 0/, '「0 候选」判定在注入逻辑中出现（宽触发核心）')
  assert.match(injectBlock, /r\.urls\.length === 0\s*&&\s*r\.degraded/, '0 候选 + degraded 双条件并满（通道坏单决定注入）')
  assert.match(injectBlock, /allMissingRows/, 'missing 判定（A 路径）保留')
  // 「宽触发」判定必须位于 delivered 跳过之后：板有真实候选先行排掉，才轮到看 0 候选 + degraded
  const deliveredIdx = injectBlock.indexOf('if (delivered) continue')
  const emptyIdx = injectBlock.indexOf('r.urls.length === 0')
  assert.ok(deliveredIdx > 0, 'if (delivered) continue 守卫在场')
  assert.ok(emptyIdx > deliveredIdx, '0 候选/degraded 判定紧跟 delivered 闸门之后（不抢先）')
})

test('static-fallback: 宽触发：有 group 返回了 URL（delivered）时跳过注入', () => {
  const injectBlock = TPL.slice(INJECT_START, INJECT_START + 2000)
  assert.match(injectBlock, /const delivered = groupsOfBoard\.some\(g => \{/, 'delivered = 任一归属组返回非空 urls')
  assert.match(injectBlock, /if\s*\(delivered\) continue/, '有真实候选 → 不注入（delivered 闸门直连 continue）')
})

test('static-fallback: 宽触发：全空候选（missing）仍走注入', () => {
  const injectBlock = TPL.slice(INJECT_START, INJECT_START + 2000)
  assert.match(injectBlock, /const shouldInject = allMissingRows \|\| anyReturnedWithURL/, 'shouldInject = A(all missing) 或 B(通道旧) 任一都注入')
  assert.match(injectBlock, /if\s*\(!shouldInject\) continue/, 'shouldInject 直接用为注入开关')
})

// ─── 8/31 修正: 撤销 8/27 「窗外信号排除门」───
// 8/27 鉴别: 0候选 + degraded + 有 nearWindow/majorOut 探索产物 → 判「窗口内确实没新闻」→ 不注入。
// 8/30 实证打脸: academic/labs 返回 degraded + 0 窗内 URL，却带窗外探索产物（Opus-4 08-28、Sonnet-4 08-26
// 其实在 8/28-8/30 窗口内）→ 该门把两板整板堵成 0 claim。degraded 来自通道失败、窗口产物是检索副产品，
// 「有窗外探索产物」≠「窗口内无新闻」。8/31 起仅凭「0 URLs + degraded」即注入，删净窗外信号门。

test('static-fallback 鉴别器: 8/31 起不再「有窗外信号 → 不注入」', () => {
  const injects = TPL.slice(INJECT_START, INJECT_START + 2200)
  // 注入判定不得复现窗外信号排除（不得再出现 hasOutWindowSignal 参与判定）
  assert.ok(!/hasOutWindowSignal|!hasOutWindowSignal/.test(injects), '注入块内不得残留窗外信号排除（8/31 契约）')
  assert.match(injects, /r\.urls\.length === 0 && r\.degraded/, '仍以 0 候选 + degraded 为注入条件')
})

test('8f-fallback 鉴别器: 真·空通道（0 候选 + degraded）注入路径保留', () => {
  const injects = TPL.slice(INJECT_START, INJECT_START + 2200)
  assert.match(injects, /r\.urls\.length === 0 && r\.degraded/, '空通道判定（urls 0 + degraded）保留为注入条件')
  assert.ok(!/!hasOutWindowSignal/.test(injects), '不再要求窗外产出为空（8/31 契约）')
})