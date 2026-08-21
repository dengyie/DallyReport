import { test } from 'node:test'
import assert from 'node:assert/strict'
import { majorKey, makeAddMajor, allocateFetchBudget } from '../dedup.mjs'

// ─── 三个历史指纹 bug 固化 ───

test('指纹 bug①：hassabis 必须在 jeff-dean 前（含两人条目不并入 jeff-dean）', () => {
  assert.equal(majorKey('Hassabis plans departure alongside Jeff Dean'), 'hassabis')
  assert.equal(majorKey('哈萨比斯原本要和Jeff Dean一起出走'), 'hassabis')
  assert.equal(majorKey('Jeff Dean 创业 BP 曝光'), 'jeff-dean')
})

test('指纹 bug②：xAI 前缀条目的全 claim 命中（split 首段是 xAI 也得归 grok-4.6）', () => {
  assert.equal(majorKey('xAI：Grok 4.6：Frontier-model release'), 'grok-4.6')
  assert.equal(majorKey('Grok 4.6 发布'), 'grok-4.6')
})

test('指纹 bug③：GPT-5.6 + Fable 数学难题两种表述归一', () => {
  assert.equal(majorKey('GPT-5.6 与 Fable 联手解决了一道悬了25年的数学难题'), 'gpt5.6-math')
  assert.equal(majorKey('GPT5.6 联手 Fable 攻克数学难题'), 'gpt5.6-math')
})

test('指纹常规实体与兜底', () => {
  assert.equal(majorKey('DeepSeek V4 Pro 开源'), 'deepseek-v4')
  assert.equal(majorKey('深度求索 V4 Flash 发布'), 'deepseek-v4')
  assert.equal(majorKey('DeepSeek Harness 团队组建'), 'deepseek-harness')
  assert.equal(majorKey('Google Gemini 3 发布'), 'gemini')
  assert.equal(majorKey('某公司创业（联合创始人）'), '某公司创业')  // 兜底剥括号
})

// ─── makeAddMajor 去重语义 ───

test('makeAddMajor 同事件只保留一份；日期更具体者覆盖', () => {
  const arr = []
  const add = makeAddMajor(arr)
  add({ name: 'Grok 4.6 发布', date: '2026-07下旬', note: '近似日期' }, 'labs')
  assert.equal(arr.length, 1)
  // 发现代理上报同事件更具体日期 → 覆盖
  add({ name: 'xAI：Grok 4.6 发布', date: '2026-07-28', note: '官方发布' }, 'labs')
  assert.equal(arr.length, 1)
  assert.equal(arr[0].date, '2026-07-28')
  assert.equal(arr[0].claim, 'xAI：Grok 4.6 发布：官方发布')
  // 反向（先具体后模糊）→ 不覆盖
  const arr2 = []
  const add2 = makeAddMajor(arr2)
  add2({ name: 'Grok 4.6 发布', date: '2026-07-28', note: '官方发布' }, 'labs')
  add2({ name: 'Grok 4.6 发布', date: '2026-07下旬', note: '近似' }, 'labs')
  assert.equal(arr2.length, 1)
  assert.equal(arr2[0].date, '2026-07-28')
})

// ─── B.4 2026-08-22 三契约缺口修复：major-out 可溯源（种子带 url → 真 URL；无 url → (多源公认) 兜底）───

test('_mkMajor 带 url 种子 → sourceUrl 是真 URL + sourceTitle 为 hostname', () => {
  const arr = []
  makeAddMajor(arr)({ name: 'DeepSeek V4-Pro 正式版上线', date: '2026-08-13', note: '官方登记', url: 'https://api-docs.deepseek.com/news/' }, 'labs')
  assert.equal(arr.length, 1)
  assert.equal(arr[0].sourceUrl, 'https://api-docs.deepseek.com/news/')
  assert.equal(arr[0].sourceTitle, 'api-docs.deepseek.com', 'hostname 提取')
  assert.equal(arr[0].isMajorOut, true)
})

test('_mkMajor 无 url → sourceUrl 退回 (多源公认) + sourceTitle 行业客观公认事实', () => {
  const arr = []
  makeAddMajor(arr)({ name: 'OpenAI 预告 Astra 旗舰模型', date: '2026-08-02', note: '媒体口径预告' }, 'labs')
  assert.equal(arr.length, 1)
  assert.equal(arr[0].sourceUrl, '(多源公认)')
  assert.equal(arr[0].sourceTitle, '行业客观公认事实')
})

test('makeAddMajor 产物 verifiedByVote:false / vote:— 不冒充投出', () => {
  const arr = []
  makeAddMajor(arr)({ name: 'DeepSeek V4 Pro / V4 Flash 开源', date: '2026-07-31', note: 'MIT 开源' }, 'labs')
  assert.equal(arr[0].isMajorOut, true)
  assert.equal(arr[0].vote, '—')
  assert.equal(arr[0].verdicts.length, 0)
  assert.equal(arr[0].survives, true)
  assert.equal(arr[0].erroredCount, 0)
})

// ─── 轮询公平分配 ───

test('allocateFetchBudget 重板块不挤掉晚序板块', () => {
  // labs 占 8 条 URL，policy/safety/people 各 1 条，预算 6
  const m = new Map([
    ['labs', Array.from({ length: 8 }, (_, i) => ({ url: 'https://labs.example/' + i }))],
    ['policy', [{ url: 'https://policy.example/a' }]],
    ['safety', [{ url: 'https://safety.example/b' }]],
    ['people', [{ url: 'https://people.example/c' }]],
  ])
  const { fetchTargets, budgetDropped } = allocateFetchBudget(m, 6)
  const boards = fetchTargets.map(t => t.board)
  assert.ok(boards.includes('policy'), 'policy 有名额')
  assert.ok(boards.includes('safety'), 'safety 有名额')
  assert.ok(boards.includes('people'), 'people 有名额')
  assert.equal(fetchTargets.length, 6)
  assert.equal(budgetDropped.length, 8 + 3 - 6)
})

test('allocateFetchBudget 跨板块 URL 去重（同 URL 两板只抓一次）', () => {
  const m = new Map([
    ['strategy', [{ url: 'https://qbitai.com/a' }, { url: 'https://qbitai.com/b' }]],
    ['funding', [{ url: 'https://qbitai.com/a' }]],  // 与 strategy 重复
  ])
  const { fetchTargets, dupes } = allocateFetchBudget(m, 12)
  assert.equal(fetchTargets.length, 2)
  assert.equal(dupes.length, 1)
  assert.equal(dupes[0].url, 'https://qbitai.com/a')
})

test('allocateFetchBudget 预算为 0 时全 drop', () => {
  const m = new Map([['labs', [{ url: 'https://x.example/1' }]]])
  const { fetchTargets, budgetDropped } = allocateFetchBudget(m, 0)
  assert.equal(fetchTargets.length, 0)
  assert.equal(budgetDropped.length, 1)
})
