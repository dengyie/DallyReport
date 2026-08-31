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

// ─── 8/27 Task 1：linuxdo-cdp 优先通道（预抓内容不再被轮询挤掉）───
// 预抓的 linux.do 候选（found_via:'linuxdo-cdp'）有专用预扣 slots，保证预抓内容真正进入验证流水线，
// 而不是被其他板块的轮询名额挤到 budgetDropped。MAX_FETCH 仍是总硬上限。

test('allocateFetchBudget: linuxdo-cdp 候选优先占用 slots（预抓内容进流水线）', () => {
  const linuxdoUrls = Array.from({ length: 8 }, (_, i) => ({
    url: 'https://linux.do/t/' + (1000 + i), title: 'post' + i, found_via: 'linuxdo-cdp', board: 'linuxdo',
  }))
  const m = new Map([
    ['linuxdo', linuxdoUrls],
    ['strategy', [{ url: 'https://strategy.example/a' }]],
    ['labs', [{ url: 'https://labs.example/b' }]],
  ])
  const { fetchTargets, budgetDropped } = allocateFetchBudget(m, 12)
  // preferCap = floor(12 × 0.5)=6 → linuxdo-cdp 前 6 条优先进；其余走轮询。
  // 全部 10 条 URL（8 linuxdo + strategy + labs）都会进（预算 12 足够）。
  const linuxdoFetched = fetchTargets.filter(t => t.found_via === 'linuxdo-cdp').length
  assert.ok(linuxdoFetched >= 6, 'linuxdo-cdp 优先通道吃满 prefer 配额（收到 ' + linuxdoFetched + '）')
  assert.ok(fetchTargets.some(t => t.board === 'strategy') && fetchTargets.some(t => t.board === 'labs'),
    '其余板仍至少各拿名额（轮询公平不被挤掉）')
  assert.equal(fetchTargets.length, 10, '10 条可用 URL 全部进（MAX_FETCH=12 未超、未破上限）')
  assert.equal(budgetDropped.length, 0, '预算充足时无丢')
})

test('allocateFetchBudget: linuxdo-cdp 优先但不超过 MAX_FETCH', () => {
  const m = new Map([
    ['linuxdo', Array.from({ length: 5 }, (_, i) => ({ url: 'https://linux.do/t/' + i, found_via: 'linuxdo-cdp', board: 'linuxdo' }))],
    ['labs', [{ url: 'https://labs.example/x' }]],
  ])
  const { fetchTargets } = allocateFetchBudget(m, 4)
  assert.equal(fetchTargets.length, 4, 'MAX_FETCH=4，不超过')
  const linuxdoSlots = fetchTargets.filter(t => t.found_via === 'linuxdo-cdp').length
  assert.ok(linuxdoSlots >= 3, '优先通道给 linuxdo-cdp 多数 slots（预抓优先）')
})

test('allocateFetchBudget: 无 linuxdo-cdp 时行为不变（轮询公平）', () => {
  const m = new Map([
    ['a', [{ url: 'https://a.example/1' }, { url: 'https://a.example/2' }]],
    ['b', [{ url: 'https://b.example/1' }]],
  ])
  const { fetchTargets } = allocateFetchBudget(m, 2)
  assert.equal(fetchTargets.length, 2)
  assert.ok(fetchTargets.some(t => t.board === 'a') && fetchTargets.some(t => t.board === 'b'), '轮询公平仍成立')
})

test('allocateFetchBudget: static-fallback 也被 prefer（与 linuxdo-cdp 共通道）', () => {
  const m = new Map([
    ['labs', [{ url: 'https://anthropic.com/news', found_via: 'static-fallback', board: 'labs' },
              { url: 'https://openai.com/news/', found_via: 'static-fallback', board: 'labs' }]],
    ['strategy', [{ url: 'https://strategy.example/a' }]],
  ])
  const { fetchTargets } = allocateFetchBudget(m, 12)
  assert.equal(fetchTargets.filter(t => t.found_via === 'static-fallback').length, 2, '静态源全部进 fetchTargets')
  assert.equal(fetchTargets.length, 3, '全部进（预算足够）')
})

test('allocateFetchBudget: preferShare=0 关闭保留位（与空 preferFoundVia 逐字节等价，回退纯轮询）', () => {
  // preferShare=0 → preferCap=0 → Phase 1 完全跳过，与传空 preferFoundVia（不命中任何 found_via）等价。
  // 两者都回退纯轮询：静态/linuxdo 候选不再吃保留位，但仍按板内列表序参与轮询公平（不凭空消失）。
  const mk = () => new Map([
    ['labs', [{ url: 'https://anthropic.com/news', found_via: 'static-fallback', board: 'labs' },
              { url: 'https://labs.example/y', board: 'labs' }]],
    ['strategy', [{ url: 'https://strategy.example/a', board: 'strategy' }]],
  ])
  const viaShare0 = allocateFetchBudget(mk(), 2, { preferShare: 0 })
  const viaEmptySet = allocateFetchBudget(mk(), 2, { preferFoundVia: [] })
  assert.deepEqual(viaShare0.fetchTargets.map(t => t.url), viaEmptySet.fetchTargets.map(t => t.url),
    'preferShare=0 与空 preferFoundVia 分配序列一致（Phase 1 均关闭）')
  assert.deepEqual(viaShare0.budgetDropped, viaEmptySet.budgetDropped, '丢弃明细一致')
})

// ─── 8/31 P2：prefer 保留位不得被单一通道独占 ───
// 8/31 生产实证（wf_e14b2828-ff5）：preferCap=8 全被 linuxdo-cdp 吃光（进配额 10/丢 14），
// static_fallback 5 条全进 budgetDropped。而 ROI 倒挂——静态单席产出是 linuxdo 的 4.5×。
// 根因：旧 Phase 1 按 boardURLMap 插入序逐板吃满 cap，template 里 linuxdo 预块 push 在普通组之前。

test('P2：linuxdo 带海量候选时 static-fallback 仍拿到保留位（8/31 饥饿场景回归）', () => {
  // 复刻 8/31 形状：linuxdo 先插入且带 24 个候选，static-fallback 5 条散在后续板
  const m = new Map([
    ['linuxdo', Array.from({ length: 24 }, (_, i) => ({
      url: 'https://linux.do/t/' + (2830000 + i), title: 'p' + i, found_via: 'linuxdo-cdp', board: 'linuxdo' }))],
    ...['labs', 'academic', 'funding', 'policy', 'safety'].map(b => [b, [
      { url: 'https://' + b + '.example/official', title: b, found_via: 'static-fallback', board: b },
    ]]),
  ])
  const { fetchTargets } = allocateFetchBudget(m, 16)
  const statics = fetchTargets.filter(t => t.found_via === 'static-fallback')
  const linuxdo = fetchTargets.filter(t => t.found_via === 'linuxdo-cdp')
  assert.equal(statics.length, 5, '5 条 static-fallback 全部进配额（旧版全被丢弃）')
  assert.ok(linuxdo.length >= 4, 'linuxdo 仍拿到实质份额（收到 ' + linuxdo.length + '）')
  assert.ok(linuxdo.length <= 11, 'linuxdo 不再独占 prefer 全部保留位（收到 ' + linuxdo.length + '）')
  assert.equal(fetchTargets.length, 16, 'MAX_FETCH=16 吃满')
})

test('P2：prefer 保留位在通道间等分——单通道最多拿 ⌈cap/通道数⌉ 席', () => {
  // 两通道各带远超 cap 的候选 → preferCap=8 应大致对半（4/4），不再先到先得通吃
  const m = new Map([
    ['linuxdo', Array.from({ length: 20 }, (_, i) => ({ url: 'https://linux.do/t/' + i, found_via: 'linuxdo-cdp', board: 'linuxdo' }))],
    ['labs', Array.from({ length: 20 }, (_, i) => ({ url: 'https://labs.example/' + i, found_via: 'static-fallback', board: 'labs' }))],
  ])
  const { fetchTargets } = allocateFetchBudget(m, 16, { preferShare: 0.5 })
  // preferCap=8：两活跃通道等分 → 各 4；剩 8 席走轮询（两板继续各拿）
  const first8 = fetchTargets.slice(0, 8)
  const ld = first8.filter(t => t.found_via === 'linuxdo-cdp').length
  const st = first8.filter(t => t.found_via === 'static-fallback').length
  assert.equal(ld, 4, 'linuxdo 在保留位内拿 4 席（cap 8 / 2 通道）')
  assert.equal(st, 4, 'static-fallback 在保留位内拿 4 席')
})

test('P2：通道用不满时余量自然流给其它通道（不浪费配额）', () => {
  // static 只有 1 条候选 → 吃 1 席，余下保留位应全给 linuxdo，而非空置
  const m = new Map([
    ['linuxdo', Array.from({ length: 20 }, (_, i) => ({ url: 'https://linux.do/t/' + i, found_via: 'linuxdo-cdp', board: 'linuxdo' }))],
    ['labs', [{ url: 'https://labs.example/only', found_via: 'static-fallback', board: 'labs' }]],
  ])
  const { fetchTargets } = allocateFetchBudget(m, 16, { preferShare: 0.5 })
  const first8 = fetchTargets.slice(0, 8)
  assert.equal(first8.filter(t => t.found_via === 'static-fallback').length, 1, 'static 只有 1 条 → 拿 1 席')
  assert.equal(first8.filter(t => t.found_via === 'linuxdo-cdp').length, 7, '余下 7 席流给 linuxdo（配额不空置）')
  assert.equal(fetchTargets.length, 16, 'MAX_FETCH 吃满')
})

test('P2：单通道场景行为不变（无第二通道时不因等分而缩水）', () => {
  const m = new Map([
    ['linuxdo', Array.from({ length: 10 }, (_, i) => ({ url: 'https://linux.do/t/' + i, found_via: 'linuxdo-cdp', board: 'linuxdo' }))],
    ['labs', [{ url: 'https://labs.example/plain', board: 'labs' }]],
  ])
  const { fetchTargets } = allocateFetchBudget(m, 12)
  // preferCap=6，只有 linuxdo 一条活跃通道 → 独得 6 席（等分退化为全额）
  assert.equal(fetchTargets.slice(0, 6).filter(t => t.found_via === 'linuxdo-cdp').length, 6,
    '唯一活跃通道仍吃满 preferCap（不因新等分逻辑缩水）')
  assert.ok(fetchTargets.some(t => t.board === 'labs'), '普通板轮询名额不受影响')
})
