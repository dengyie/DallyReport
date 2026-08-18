// ai-daily — Comprehensive AI daily report workflow（模板源）。
// 本文件是 workflow 的"编排骨架 + realm 适配层"；纯逻辑（schemas/boards/date-utils/dedup/budget/prompts/render-md）
// 已下沉到 scripts/ai-daily/*.mjs 模块真源，由 build.mjs 剥 export inline 进下方占位符生成自包含产物。
// 规则：改模块逻辑去 scripts/ai-daily/ 改；改编排去本模板改；改完必须跑 node scripts/ai-daily/build.mjs。
//
// Deterministic 9-board × roster coverage → grok-search/X/RSS discovery →
// fetch+extract falsifiable claims → adaptive 2+1 adversarial verification →
// coverage self-check (script-computed) → synthesis → return payloads（含 md）。

export const meta = {
  name: 'ai-daily',
  description: 'Comprehensive AI daily report — deterministic coverage, adversarial verification, cited, saved to disk',
  whenToUse: 'Run the daily AI news report for a date. Args: { date, window:{from,to}, outDir, boards?, maxFetch?, maxVerify? }',
  phases: [
    { title: 'Harvest', detail: 'Unique feeds fetched once into compact digests' },
    { title: 'Discover', detail: 'Boards mined via injected digest + grok-search X + WebSearch supplement' },
    { title: 'Fetch', detail: 'Extract falsifiable claims with quotes/dates' },
    { title: 'Verify', detail: '对抗核查：双票快查 + 分歧升补，≥2 否决 kill（语义不变）' },
    { title: 'Synthesize', detail: 'Coverage self-check + report + write artifacts' },
  ],
}

// ─── Config ───
// 8/17：Workflow harness 偶发把 args 以 JSON 字符串形式注入（而非对象），这里兼容解包，保证两种形式都能用。
if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { args = {} } }
if (!args || typeof args !== 'object') args = {}
const VOTES_PER_CLAIM = 3
const REFUTATIONS_REQUIRED = 2
// 8/14 优化（速率优先）：源预算整体下调——数据源更少 → 大头阶段（fetch/verify）代理数约 -50%。
// MAX_FETCH 48→20、MAX_VERIFY 48→24、每板候选 URL 12→6；fetch 预算改为板间轮询公平分配（见下），保证晚序板块不被挤掉。
// 8/15 第九项优化（结构降本，见设计文档 changelog）：MAX_FETCH 20→12、MAX_VERIFY 24→12；
// harvest 14 并发→5 分组串行批；discover 9→5 分组；核查 3 票→双票快查+分歧升补；昂贵代理失败不再换新重跑（tries 按阶段）。
const MAX_FETCH = typeof args.maxFetch === 'number' && args.maxFetch > 0 ? args.maxFetch : 12
const MAX_VERIFY = typeof args.maxVerify === 'number' && args.maxVerify > 0 ? args.maxVerify : 12
const MAX_URLS_PER_BOARD = 6
// 单代理最大存活时长。deepseek 网关偶发"发了工具结果后模型再无回复"的静默卡死：
// 没有此上限时一个卡死代理会永久挡住整个 parallel/pipeline 闸门（实测 >10min 无产出）。
// 超时 → 视作 null → 按阶段重试策略处理（harvest/discover/核查票不换新代理，fetch 换一次，report 单次直出）。
// 默认 6 分钟（8/15 起）：不再对昂贵代理做全新重跑，仅对"网关拥堵拖慢完整体"的静默挂起兜底。
const AGENT_TIMEOUT_MS = typeof args.agentTimeoutMs === 'number' && args.agentTimeoutMs > 0 ? args.agentTimeoutMs : 360000

// 8/17 第十一项：Synthesize 前网关健康探针超时 + 主脚本总墙钟上限（宽松兜底，防任一阶段挂起拖满整轮）。
const GATEWAY_PROBE_MS = typeof args.probeTimeoutMs === 'number' && args.probeTimeoutMs > 0 ? args.probeTimeoutMs : 20000
const TOTAL_LIMIT_MS = typeof args.totalLimitMs === 'number' && args.totalLimitMs > 0 ? args.totalLimitMs : 1800000
// 8/17 第十四项：墙钟治理升级——TOTAL_LIMIT_MS（仅 Synthesize 前查一次的事后闸门）拆成各阶段累计死线，
// 每个阶段前 budgetGate 查墙钟，超限即跳过该阶段快速降级（病态运行不再拖满；健康跑远低于死线、永不触发）。
// 切片和 = 8+9+8+5 = 30min 与 TOTAL_LIMIT_MS 对齐；分配序：Harvest/Discover 留足慢但有效的包络，Verify 牺牲序最低。
// 8/17 全量实测（Harvest 5.2 / Discover 9.2 / Fetch 7.3 / Verify 9.1min）证明 30min 盘子装不下 50 代理健康包络（合计 30.8min）：
// 修复后健康跑尾部 Verify 被逐波重算硬停（尾部核查票如实降 unverified），墙钟由 Verify 死线缓冲严格钉在 ≤ TOTAL_LIMIT_MS。
const HARVEST_BUDGET_MS = typeof args.harvestBudgetMs === 'number' && args.harvestBudgetMs > 0 ? args.harvestBudgetMs : 480000
const DISCOVER_BUDGET_MS = typeof args.discoverBudgetMs === 'number' && args.discoverBudgetMs > 0 ? args.discoverBudgetMs : 540000
const FETCH_BUDGET_MS   = typeof args.fetchBudgetMs   === 'number' && args.fetchBudgetMs   > 0 ? args.fetchBudgetMs   : 480000
const VERIFY_BUDGET_MS  = typeof args.verifyBudgetMs  === 'number' && args.verifyBudgetMs  > 0 ? args.verifyBudgetMs  : 300000
// 8/17 全量修复（观察项①）：Verify 最后一批在飞票带 60s timeoutMs 下限（D 的 min(60s) 防逼空），
// 累计死线预留该缓冲（从 Verify 切片和后扣除），批内在飞票拖满下限也越不过 Synthesize 总闸门。
const VERIFY_INFLIGHT_BUFFER_MS = typeof args.verifyInflightBufferMs === 'number' && args.verifyInflightBufferMs > 0 ? args.verifyInflightBufferMs : 60000

const DATE = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : null
const WFROM = args.window && /^\d{4}-\d{2}-\d{2}$/.test(String(args.window.from)) ? String(args.window.from) : null
const WTO = args.window && /^\d{4}-\d{2}-\d{2}$/.test(String(args.window.to)) ? String(args.window.to) : DATE
const OUT = typeof args.outDir === 'string' && args.outDir ? args.outDir : null
const BOARDS_SELECTED = Array.isArray(args.boards) ? new Set(args.boards) : null
const GROK_DIR = '/Users/mango/.claude/skills/grok-search'

if (!DATE || !OUT) {
  return { error: 'Args must include date (YYYY-MM-DD) and outDir (absolute path). window optional. got: ' + JSON.stringify(args) }
}
const WINDOW_LABEL = WFROM && WTO ? WFROM + ' ~ ' + WTO : WTO || DATE

// ─── 常量区（供 prompt ctx 与编排使用）───
// 8/15：稠密源（arXiv/HF papers）与普通源统一 12000 字符——稠密源曾是输入大户，降到与普通源同档。
const feedMaxChars = () => 12000
const WEB_BUDGET_TOTAL = 4
const WEB_BUDGET_PER = 2

// ═══ 模块内联区（build.mjs 替换；逻辑真源见 scripts/ai-daily/*.mjs）═══
// 依赖序与 build.mjs MODULES 一致：date-utils(normURL) 必须在 boards(GROUPS_RAW.test 闭包) 与 dedup 前。
/* @inline: date-utils */
/* @inline: schemas */
/* @inline: boards */
/* @inline: dedup */
/* @inline: budget */
/* @inline: prompts */
/* @inline: render-md */

// boards 由 BOARDS 花名册按选区派生（BOARDS 已 inline 就绪，此时访问无 TDZ）。
const boards = BOARDS_SELECTED ? BOARDS.filter(b => BOARDS_SELECTED.has(b.key)) : BOARDS

// ─── 编排层 helpers（realm 专属/依赖注入后）───
const impRank = { central: 0, supporting: 1, tangential: 2 }
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }

const WIN_FROM = WFROM ? normalizeDate(WFROM) : null
const WIN_TO = normalizeDate(WTO || DATE)
const claimWindow = makeClaimWindow(WIN_FROM, WIN_TO)

const TRANSIENT = /(422|429|5\d\d|524|timeout|timed out|connection closed|model not found|upstream|gateway|cloudflare)/i
const withDeadline = (p, ms) => new Promise(resolve => {
  let done = false
  const settle = v => { if (!done) { done = true; clearTimeout(to); resolve(v) } }
  const to = setTimeout(() => { log('agent 超时 ' + Math.round(ms / 1000) + 's 无产出 → 视为失败（按阶段重试策略：harvest/disc/票不换新代理，fetch 换一次，report 单次直出）'); settle(null) }, ms)
  p.then(v => settle(v), () => settle(null))
})
const safeAgent = async (p, o, tries = 2) => {
  for (let i = 0; i < tries; i++) {
    let r = null
    try { r = await withDeadline(agent(p, o), o.timeoutMs || AGENT_TIMEOUT_MS) } catch (e) {
      const msg = String(((e && (e.message || e.error)) || e) || '')
      if (i === tries - 1 || !TRANSIENT.test(msg)) { log('safeAgent fail ' + (o.label || '?') + ': ' + msg.slice(0, 120)); return null }
      log('safeAgent retry ' + (i + 1) + ' ' + (o.label || '?') + ': ' + msg.slice(0, 100))
      continue
    }
    if (r) return r
    log('safeAgent retry ' + (i + 1) + ' ' + (o.label || '?') + ' (null agent)')
  }
  return null
}
// 8/17 第十一项：墙钟基准用 performance.now()（Workflow realm 内 Date.now()/new Date() 会抛错）。
// 8/17 第十四项：墙钟基准。Workflow realm 里 performance 不存在（实测 undefined）、Date.now()/new Date() 被静态拒绝（resume 确定性）。
// 唯一可用时钟源 = setTimeout 链累加：脚本启动即开一条每 250ms 自递归的链累加 _wallMs，await 期间事件循环空闲时持续推进（实测 agent 跑 2.2s → 累加 2000ms，吻合）。
// 精度 250ms 对分钟级墙钟预算足够；resume 时链重新起算（脚本从头跑），语义=重新计时，与本注释历史意图一致。
const _TICK_MS = 250
let _wallMs = 0
const _tick = () => { _wallMs += _TICK_MS; setTimeout(_tick, _TICK_MS) }
setTimeout(_tick, _TICK_MS)
const now = () => _wallMs
const RUN_START = now()
const RUN_ELAPSED = () => now() - RUN_START
const probeGateway = async label => {
  const t0 = now()
  const p = await withDeadline(agent('仅回复 OK。', { label: 'probe:' + label, effort: 'low', timeoutMs: GATEWAY_PROBE_MS }), GATEWAY_PROBE_MS)
  const took = Math.round(now() - t0)
  if (!p) { log('PROBE-FAIL ' + label + ' ' + took + 'ms 网关不可用 → 跳过合成（快速降级 raw archive）'); return false }
  log('PROBE-OK ' + label + ' ' + took + 'ms'); return true
}
// 8/17 第十四项：阶段墙钟闸门——某阶段前查 RUN_ELAPSED 是否已过该阶段累计死线；超限即记 budget_skipped + log，返回 ok:false。
// roomMs = 死线减已耗，供批内 timeoutMs 收紧（in-flight 硬停）。performance 不可用时 now()=0 → 恒放行（软兜底失效但不误杀已完成工作）；resume 重新起算仅宽松兜底。
// budget.mjs：computePhaseDeadlines 算累计死线 + makeBudgetGate(stage) 闸门（elapsedFn 注入 RUN_ELAPSED，clock 解耦测试化）。
const PHASE_DEADLINES = computePhaseDeadlines({
  harvest: HARVEST_BUDGET_MS, discover: DISCOVER_BUDGET_MS, fetch: FETCH_BUDGET_MS,
  verify: VERIFY_BUDGET_MS, verifyInflightBuffer: VERIFY_INFLIGHT_BUFFER_MS, totalLimit: TOTAL_LIMIT_MS,
})
// 注意：HARVEST/DISCOVER/FETCH/VERIFY_BUDGET_MS 是"该阶段允许花多久"的切片（用户可单独调），
// 死线必须累加——若误把切片当死线，Verify 切片 5min 会在健康跑（elapsed 早已 >5min）误判超时。
// Verify 累计死线在切片和后另减 VERIFY_INFLIGHT_BUFFER_MS：最后一批在飞票带 60s timeoutMs 下限（防逼空），
// 预留该缓冲使批内在飞票拖满下限也越不过 Synthesize 的总闸门 → 墙钟严格 ≤ TOTAL_LIMIT_MS。
const budgetGate = makeBudgetGate(PHASE_DEADLINES, RUN_ELAPSED, stage =>
  log('BUDGET-SKIP ' + stage + ' elapsed=' + Math.round(RUN_ELAPSED() / 1000) + 's ≥ 死线 ' + Math.round(PHASE_DEADLINES[stage] / 1000) + 's → 跳过该阶段快速降级'))
const budgetSkipped = budgetGate.skipped  // degraded 标记读取（makeBudgetGate 内同 stage 只记一次）

log('Q: 生成 ' + WINDOW_LABEL + ' 窗口的 AI 日报（' + boards.length + ' 个板块）')

// ─── Phase Harvest: 每个唯一 feed 只抓一次 → 紧凑 digest → 注入 discover prompt ───
// 实测证据：让 discover 代理自己逐 feed 跑 fetch.js（labs 23 家 × 12KB 输出 + 中间推理轮），
// 单个 discover transcript 冲到 160-256KB。改为：主流程用独立 harvest 代理预抓唯一 feed 一次（去重
// 后 techcrunch/qbitai 等共享源只抓一遍，不再被 6 个板块各抓一遍），产出紧凑 digest 文本注入每个
// discover 的 prompt；discover 代理整个移除 fetch.js，上下文结构上封顶（= digest + 少量 X 搜索）。
const feedSources = []
for (const b of boards) {
  for (const f of (b.feeds || [])) feedSources.push({ url: f, label: f, board: b.key })
  for (const c of (b.companies || [])) if (c.feed) feedSources.push({ url: c.feed, label: c.name, board: b.key })
}
for (const f of OFFICIAL_FEEDS) feedSources.push({ url: f.url, label: f.label, board: 'labs' })
const feedMap = new Map() // normURL → {url,label,boards:Set}
for (const f of feedSources) {
  const k = normURL(f.url)
  if (!feedMap.has(k)) feedMap.set(k, { url: f.url, label: f.label, boards: new Set() })
  feedMap.get(k).boards.add(f.board)
}
const uniqueFeeds = [...feedMap.values()]
phase('Harvest')
// 批量 Harvest（8/15 第九项优化）：14 个独立 feed 并行代理 → 5 个分组代理，每组依次跑完组内 feed、
// 条目标注来源 feed 键；组代理 3+2 两批串行执行——今天 14 并发同时打 deepseek 网关是 524 风暴的最大诱因。
// GROUPS_RAW 定义见 boards.mjs（test 闭包引用 normURL，build inline 顺序保证在前）。
const HARVEST_GROUPS = []
for (const g of GROUPS_RAW) {
  const feeds = uniqueFeeds.filter(f => g.test(f.url))
  if (feeds.length) HARVEST_GROUPS.push({ key: g.key, label: g.label, feeds })
}
// base prompt ctx：harvest/verify 仅需常量级字段，不依赖 digest（discover 才需）。
const ctxBase = { WINDOW_LABEL, WFROM, WTO, DATE, GROK_DIR, feedMaxChars, VOTES_PER_CLAIM, REFUTATIONS_REQUIRED }
const harvestResults = []
const HARVEST_BATCH = 3
const harvestGate = budgetGate('Harvest')
for (const batch of chunkArr(HARVEST_GROUPS, HARVEST_BATCH)) {
  if (!budgetGate('Harvest').ok) { log('BUDGET-BREAK Harvest 余批跳过，用已完成批次结果'); break }
  const room = harvestGate.roomMs
  const round = await parallel(batch.map(g => () =>
    // 8/16 复盘根因：harvest 不带 timeoutMs → 吃 AGENT_TIMEOUT_MS=360s，而 5 组共源并发下 3 个分组实测 384–800s
    // 才完成（cn-media 442s / opensource 384s / en-media 800s）。withDeadline 在 360s 先让 safeAgent 返回 null →
    // .then 里 failed=true → digest 整块标"抓取失败"，已完成的工作被静默丢弃 → 6 个媒体板 discover 拿到空摘要、
    // 只剩 X 搜索兜底 → 8/9 板 degraded。死线放到 1800s：让已完成的 harvest 结果真正进 digest（慢但必须被用上）。
    // 8/17 第十四项：timeoutMs 收紧到阶段剩余预算（健康跑 room≫1800s 取 1800s 行为不变；病态跑 room 收缩提前死线）。
    safeAgent(harvestPrompt(g, ctxBase), { label: 'harv:' + g.key, phase: 'Harvest', schema: HARVEST_SCHEMA, effort: 'low', timeoutMs: Math.max(60000, Math.min(1800000, room)) }, 1)
      .then(r => ({ g, entries: (r && r.entries) || [], recent: (r && r.recent) || [], failed: !r || !!r.failed }))
  ))
  harvestResults.push(...round)
}
// 条目按 feed 标签归栈到每个 feed 的 digest；未标 feed 的条目：单 feed 组归该 feed，多 feed 组丢弃（防串栈）。
const digestByKey = new Map()
for (const h of harvestResults) {
  const feedByKey = new Map(h.g.feeds.map(f => [normURL(f.url), f]))
  const slots = new Map()
  for (const [k, feed] of feedByKey) slots.set(k, { feed, entries: [], recent: [], failed: h.failed })
  for (const e of h.entries || []) {
    const k = e.feed ? normURL(e.feed) : (h.g.feeds.length === 1 ? normURL(h.g.feeds[0].url) : null)
    if (k && slots.has(k) && slots.get(k).entries.length < 15) slots.get(k).entries.push(e)
  }
  for (const r of h.recent || []) {
    const k = r.feed ? normURL(r.feed) : (h.g.feeds.length === 1 ? normURL(h.g.feeds[0].url) : null)
    if (k && slots.has(k) && slots.get(k).recent.length < 4) slots.get(k).recent.push(r)
  }
  for (const [k, rec] of slots) digestByKey.set(k, rec)
}
const digestForFeeds = feedKeys => {
  const parts = []
  for (const u of [...new Set(feedKeys.map(normURL))]) {
    const h = digestByKey.get(u)
    if (!h) continue
    const head = '**' + (h.feed.label || h.feed.url) + '**（' + h.feed.url + '）'
    if (h.failed) { parts.push(head + ' — 抓取失败（可用 X 搜索/WebSearch 补）'); continue }
    const rows = (h.entries || []).map(e => '- [' + (e.date || '?') + '] ' + e.title + ' | ' + e.url).join('\n')
    const rec = (h.recent || []).length ? '\n  【近窗口·重大候选】' + h.recent.map(r => '[' + (r.date || '?') + '] ' + r.title + (r.note ? '（' + r.note + '）' : '') + ' | ' + r.url).join('\n  ') : ''
    parts.push(head + '\n' + (rows || '  （窗口内无条目）') + rec)
  }
  return parts.join('\n')
}
const digestForBoard = board => {
  const keys = []
  for (const f of (board.feeds || [])) keys.push(f)
  for (const c of (board.companies || [])) if (c.feed) keys.push(c.feed)
  if (board.key === 'labs') for (const f of OFFICIAL_FEEDS) keys.push(f.url)
  return digestForFeeds(keys)
}
// full prompt ctx：discover 额外依赖 boards 花名册、digest 函数与 web 预算（构造于 digest 就绪后）。
const ctxP = { ...ctxBase, BOARDS, MAX_URLS_PER_BOARD, digestForBoard, digestForFeeds, WEB_BUDGET_TOTAL, WEB_BUDGET_PER }
log('Harvest: ' + HARVEST_GROUPS.length + ' groups over ' + uniqueFeeds.length + ' unique feeds → digests ready（14 并发→' + HARVEST_GROUPS.length + ' 分组串行）')

// ─── Phase Discover ───
phase('Discover')
// 分组发现（8/15 第九项优化）：labs / opensource / academic 单板专代理；6 个媒体/垂类板合并为
// media-cn（量子位+36氪）与 media-en（TechCrunch+TheVerge+qbitai）两组。共享 feed digest 只注入该组一次
// （不再被 6 个板各注入一遍）；媒体组每条 URL 必须标 board 归属板。qbitai 在 media-en 出现是为保住
// products 板块的国内产品报道面（products 板 feeds 含 qbitai），构成本组 9 板覆盖闭环。
// DISCOVER_GROUPS_ALL 定义见 boards.mjs。
// 分组随选板派生：仅保留至少覆盖一个已选板块的组（冒烟/子集跑不会白白全跑 5 组）。
const boardKeysSel = new Set(boards.map(b => b.key))
const DISCOVER_GROUPS = DISCOVER_GROUPS_ALL
  .map(g => ({ ...g, boards: g.boards.filter(k => boardKeysSel.has(k)) }))
  .filter(g => g.boards.length > 0)
const discoverResults = []
const DISCOVER_BATCH = 3
const discoverGate = budgetGate('Discover')
for (const batch of chunkArr(DISCOVER_GROUPS, DISCOVER_BATCH)) {
  if (!budgetGate('Discover').ok) { log('BUDGET-BREAK Discover 余批跳过，用已完成批次结果'); break }
  const room = discoverGate.roomMs
  const round = await parallel(batch.map(g => () =>
    // 8/16：discover 与 harvest 同款的批量串行（5→3+2 两波）+ 按实测放宽死线 + 瞬时错误重试一次。
    // 8/15 只给 labs 特殊 600s 并在单板冒烟里验证（334s 达标），全量 5 并发时网关争抢使每个 discover 都 3-6×变慢，
    // media-cn 实测 1967s、labs 1213s、opensource/media-en 各 ~770s，全部超死线被 withDeadline 丢弃 → 8/9 板块 degrade、23/23 unreached。
    // 修法：批量降并发（复用 harvest 的 3 并发批次，两波跑完），并把死线放到实测量级——慢但已完成的发现结果必须被用上，不许静默丢弃。
    // 8/16 二打：批量已生效（两波严格串行），但 disc:media-en 实测 2336s 后 API Connection closed（瞬时错误）
    // → tries=1 无重试 → strategy/products/funding/policy 4 板尽失 + 40 分钟墙钟。当初升 tries=2 意在保护 9 板覆盖。
    // 8/17 第十四项复盘改回 tries=1：实测 tries=2 在网关差窗口下**没能**保护（8/17 media 两组重试后仍全废），反而烧 80min 死路；
    // 且 safeAgent 的 null 路径（withDeadline settle(null)）不查 TRANSIENT、无条件重试——删正则也拦不住重跑。tries=1 是唯一可靠杠杆，
    // 配合阶段墙钟预算（budgetGate）兜底：失败即如实降级（标 missing_*），时间省给探针/其他阶段。失败可见性由 DISCOVER-FAIL 日志补上。
    safeAgent(discoverPrompt(g, ctxP), { label: 'disc:' + g.key, phase: 'Discover', schema: DISCOVER_SCHEMA, timeoutMs: Math.max(60000, Math.min(g.key === 'labs' ? 1800000 : 2400000, room)) }, 1)
      .then(r => { if (!r) { log('DISCOVER-FAIL disc:' + g.key + ' → ' + g.boards.join('+') + ' 板降级（代理失败/超时，tries=1 不重跑）'); return null }; return { group: g, boards: g.boards, urls: r.urls || [], noNews: r.noNews || [], nearWindow: r.nearWindow || [], majorOutOfWindow: r.majorOutOfWindow || [], degraded: !!r.degraded } })
  ))
  discoverResults.push(...round)
}
const discoverRows = discoverResults.filter(Boolean)
log('Discover: ' + discoverRows.length + ' groups over ' + boards.length + ' boards, ' + discoverRows.reduce((n, d) => n + d.urls.length, 0) + ' raw URLs')

// ─── Dedup + fetch budget（板间公平）───
// 旧实现按 boards 顺序消耗全局 quota，预算收紧后 labs/strategy 会把 policy/safety/people 整体挤掉。
// 改为轮询分配（dedup.mjs allocateFetchBudget）：每轮每板块至多取 1 个未抓 URL，直到 MAX_FETCH 耗尽——9 个板块雨露均沾。
const boardURLMap = new Map()
for (const d of discoverRows) for (const u of d.urls) {
  if (!u || !u.url) continue
  const b = d.boards.length === 1 ? d.boards[0] : (u.board || d.boards[0])
  if (!boardURLMap.has(b)) boardURLMap.set(b, [])
  boardURLMap.get(b).push({ ...u, board: b })
}
const { fetchTargets, dupes, budgetDropped } = allocateFetchBudget(boardURLMap, MAX_FETCH)
log('Dedup: ' + dupes.length + ' dupes, ' + budgetDropped.length + ' budget-dropped, fetching ' + fetchTargets.length)

// ─── Phase Fetch + Extract ───
phase('Fetch')
const extracted = []
const FETCH_BATCH = 6
const fetchGate = budgetGate('Fetch')
for (const batch of chunkArr(fetchTargets, FETCH_BATCH)) {
  if (!budgetGate('Fetch').ok) { log('BUDGET-BREAK Fetch 余批跳过，用已完成批次结果'); break }
  const room = fetchGate.roomMs
  const batchRes = await parallel(batch.map(src => () =>
    safeAgent(fetchPrompt(src, ctxP), { label: 'fetch:' + hostOf(src.url), phase: 'Fetch', schema: EXTRACT_SCHEMA, effort: 'low', timeoutMs: Math.max(60000, Math.min(AGENT_TIMEOUT_MS, room)) }, 2)
      .then(ext => {
        if (!ext) return null
        src.sourceQuality = ext.sourceQuality
        src.publishDate = ext.publishDate
        src.claims = (ext.claims || []).map(c => ({ ...c, sourceUrl: src.url, sourceTitle: src.title, sourceQuality: ext.sourceQuality, date: src.date, board: src.board }))
        return src
      }).catch(e => ({ ...src, sourceQuality: 'unreliable', claims: [] }))
  ))
  extracted.push(...batchRes)
}
const sources = extracted.filter(Boolean)
const allClaims = sources.flatMap(s => s.claims)
log('Fetch: ' + sources.length + ' sources → ' + allClaims.length + ' claims')

// ─── Phase Verify: 3-vote adversarial, window-enforced ───
// Verify 预算按板块按比例分配：保证每个板块的头条都被核查，
// 避免重板块（如 arXiv 的 primary 学术声明）把财经/战略头条整体挤出前 60。
const claimsByBoard = new Map()
for (const c of allClaims) {
  if (!claimsByBoard.has(c.board)) claimsByBoard.set(c.board, [])
  claimsByBoard.get(c.board).push(c)
}
for (const arr of claimsByBoard.values()) arr.sort((a, b) => (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]))
const boardKeysV = [...claimsByBoard.keys()]
const totalClaims = allClaims.length
const quota = new Map()
let assignedV = 0
if (totalClaims > 0) {
  for (const k of boardKeysV) {
    let q = Math.floor(MAX_VERIFY * claimsByBoard.get(k).length / totalClaims)
    if (q === 0 && claimsByBoard.get(k).length > 0 && assignedV < MAX_VERIFY) q = 1
    q = Math.min(q, claimsByBoard.get(k).length)
    quota.set(k, q); assignedV += q
  }
  let remainV = MAX_VERIFY - assignedV
  const byResidual = boardKeysV.slice().sort((a, b) => (claimsByBoard.get(b).length - quota.get(b)) - (claimsByBoard.get(a).length - quota.get(a)))
  // 欠配板块按残差降序逐板消化剩余额度，直到用尽或全部板块配额达 cap。
  // 8/16 review：原紧接另有"第二轮"同序同分配循环——模拟 6 组分布验证其在上述循环耗尽 remainV 或全板
  // canTake=0 后必无任何效果，属死代码，删除（行为不变）。
  for (const k of byResidual) {
    if (remainV <= 0) break
    const canTake = Math.min(claimsByBoard.get(k).length - quota.get(k), remainV)
    quota.set(k, quota.get(k) + canTake); remainV -= canTake
  }
}
const rankedClaims = []
for (const k of boardKeysV) rankedClaims.push(...claimsByBoard.get(k).slice(0, quota.get(k)))
log('Verify: ' + rankedClaims.length + ' claims across ' + boardKeysV.length + ' boards [' + [...quota.entries()].map(e => e[0] + ':' + e[1]).join(' ') + '], adaptive 2+1 votes')
phase('Verify')

const _voteBatch = (c, n, startIdx, timeoutMs) => parallel(Array.from({ length: n }, (_, v) => () =>
  safeAgent(verifyPrompt(c, ctxP), { label: 'v' + (startIdx + v) + ':' + (c.claim || '').slice(0, 30), phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'low', timeoutMs }, 1)
))
// 8/15 自适应 2+1（语义无损）：round0 并发 2 票。双否→kill（2 票）；双非否→存活（2 票）；分歧/缺票→补 1 票终判。
// 终判规则与 3 票时代逐字一致：survives ⇔ valid≥2 且 refuted<2；isRefuted ⇔ refuted≥2。平均 2.0-2.3 票/claim。
const voteClaim = async (c, timeoutMs) => {
  const valid = []
  let agentFails = 0  // 真正的代理失败（null）数；与"够票早停"分开，避免把主动停算成 error
  const round0 = await _voteBatch(c, Math.min(2, VOTES_PER_CLAIM), 0, timeoutMs)
  agentFails += round0.filter(x => !x).length
  valid.push(...round0.filter(Boolean))
  const ref0 = valid.filter(x => x.refuted).length
  const ok0 = valid.length - ref0
  // 非收敛（1-1 分歧，或两票里有失败缺位）→ 补 1 票；双否/双过都直接收束在 2 票。
  const need1 = VOTES_PER_CLAIM - valid.length
  if (need1 > 0 && !(ref0 >= REFUTATIONS_REQUIRED || ok0 >= REFUTATIONS_REQUIRED)) {
    const round1 = await _voteBatch(c, Math.min(1, need1), valid.length, timeoutMs)
    agentFails += round1.filter(x => !x).length
    valid.push(...round1.filter(Boolean))
  }
  const refuted = valid.filter(x => x.refuted).length
  const errored = agentFails
  const survives = valid.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED
  const isRefuted = refuted >= REFUTATIONS_REQUIRED
  log((survives ? '✓' : isRefuted ? '✗' : '?') + ' ' + (c.claim || '').slice(0, 46) + ' — ' + (valid.length - refuted) + '-' + refuted + (errored ? ' (' + errored + '×err)' : ''))
  return { ...c, verdicts: valid, refutedCount: refuted, erroredCount: errored, survives, isRefuted }
}
const voted = []
const VERIFY_BATCH = 6
// 8/17 全量修复（观察项①）：room 由阶段 START 一次性快照改为每批重算——批内在飞票拖满 60s 下限后，
// 下一批的 budgetGate 用当前剩余 room 判定，越线即 BUDGET-BREAK 不再启动新票；配合 PHASE_DEADLINES.Verify 的
// 60s 缓冲（VERIFY_INFLIGHT_BUFFER_MS），批内在飞票拖满下限也越不过 Synthesize 总闸门 → 墙钟严格 ≤ TOTAL_LIMIT_MS。
for (const batch of chunkArr(rankedClaims, VERIFY_BATCH)) {
  const gate = budgetGate('Verify')
  if (!gate.ok) { log('BUDGET-BREAK Verify 余批跳过，用已完成批次结果'); break }
  const vtimeout = Math.max(60000, Math.min(AGENT_TIMEOUT_MS, gate.roomMs))
  const batchRes = await parallel(batch.map(c => () => voteClaim(c, vtimeout)))
  voted.push(...batchRes.filter(Boolean))
}

const confirmedVerify = voted.filter(c => c.survives && claimWindow(c) !== 'out')
const confirmed = [...confirmedVerify]  // copy：后续 major-out 注入不许污染 confirmedVerify 计数（reportPrompt 分开统计）
const outOfWindow = voted.filter(c => c.survives && claimWindow(c) === 'out')
const killed = voted.filter(c => c.isRefuted)
const unverified = voted.filter(c => !c.survives && !c.isRefuted)
const toolError = voted.filter(c => c.erroredCount >= 1).length  // 8/17 全量修复（观察项③）：阈值 2→1，单票错误不再被成品抹掉
log('Verify done: ' + voted.length + ' → ' + confirmedVerify.length + ' verified, ' + killed.length + ' refuted, ' + unverified.length + ' unverified')

// ─── 重大超窗事实注入：行业里程碑级公认客观事件，即使不在窗口也需出现在正文 ───
// mkMajor/majorKey/去重覆盖逻辑在 dedup.mjs（makeAddMajor + majorKey，测试固化三历史 bug）。
const majorOutClaims = []
const _addMajor = makeAddMajor(majorOutClaims)
for (const d of discoverRows) for (const m of (d.majorOutOfWindow || [])) if (m && m.name) _addMajor(m, d.boards[0])
// 种子 KNOWN_MAJOR_OUT 作为保底（未被发现代理上报的补上）
for (const m of KNOWN_MAJOR_OUT) _addMajor(m, 'labs')
confirmed.push(...majorOutClaims)
log('majorOut: ' + majorOutClaims.length + ' industry milestones injected into confirmed')

// ─── Coverage self-check (deterministic) ───
const boardClaimCount = new Map()
for (const s of sources) { s.claims.forEach(c => boardClaimCount.set(c.board, (boardClaimCount.get(c.board) || 0) + 1)) }
// labs 板块的公司三态由发现代理回报的 noNews 派生（其余公司视为"有动态或已达"）。
const noNewsSet = new Set()
for (const d of discoverRows) (d.noNews || []).forEach(k => noNewsSet.add(k))
// 分组发现失败判据：板块归属的发现组整体无返回才标 fail（组内个别板无内容不惩罚组内其他板）。
const failedBoardKeys = new Set(boards.map(b => b.key).filter(k => !discoverRows.some(d => d.boards.includes(k))))
const coverage = boards.map(b => ({
  board: b.key, title: b.title,
  claims: boardClaimCount.get(b.key) || 0,
  urls: sources.filter(s => s.board === b.key).length,
  companiesChecked: b.companies ? b.companies.map(c => failedBoardKeys.has(b.key)
    ? { name: c.name, state: 'unreached', evidence: 'no_discover_agent' }
    : { name: c.name, state: noNewsSet.has(c.name) ? 'no_news' : 'has_dynamic', evidence: 'labs' }) : null,
  degraded: discoverRows.some(d => d.boards.includes(b.key) && d.degraded) || failedBoardKeys.has(b.key),
}))

// ─── labs 花名册跨板块校正：发现代理可能过报 no_news。
// 任一已确认窗口内声明/来源标题命中公司别名 → 翻转为 has_dynamic（report_match）───
// LABS_ALIASES 定义见 boards.mjs。
const matchedCompany = new Set()
const seenText = confirmed.map(c => c.claim + ' ' + (c.quote || '')).concat(sources.map(s => s.title || ''))
// 注意：coverage 对象字段是 board（不是 key）——find 必须匹配 r.board，否则校正永远不执行。
const labsCov = coverage.find(r => r.board === 'labs')
let _diagHit = 0, _diagNoNews = 0
if (labsCov && labsCov.companiesChecked) {
  for (const comp of labsCov.companiesChecked) {
    const al = LABS_ALIASES.find(a => a[0] === comp.name)
    const hit = al && seenText.some(t => al[1].some(a => String(t).includes(a)))
    if (comp.state === 'no_news') {
      _diagNoNews++
      if (hit) { comp.state = 'has_dynamic'; comp.evidence = 'report_match'; matchedCompany.add(comp.name); _diagHit++ }
      else { comp.state = 'no_dynamic'; comp.evidence = 'labs' }
    }
  }
}
log('RECONCILE-DIAG labsCov=' + !!labsCov + ' noNewsSet=' + noNewsSet.size + ' no_news=' + _diagNoNews + ' hit=' + _diagHit + ' matched=[' + [...matchedCompany].join(',') + '] seenText=' + seenText.length + ' confirmed=' + confirmed.length + ' sources=' + sources.length)
const noDynamicCompanies = labsCov ? labsCov.companiesChecked.filter(c => c.state === 'no_dynamic').map(c => c.name) : []

// ─── 窗口外参考聚合：发现代理自报的次要超窗项 + 门禁拦下的已确认项 ───
// 注：重大超窗事实（majorOutOfWindow + KNOWN_MAJOR_OUT）已注入正文，不在此列。
const discoveredMisses = []
for (const d of discoverRows) for (const m of (d.nearWindow || [])) if (m && m.name) discoveredMisses.push(m)
const gatedMisses = outOfWindow.map(c => ({ name: c.claim.slice(0, 36) + (c.claim.length > 36 ? '…' : ''), date: c.publishDate || c.date || null, note: '页面/标注日期在窗口外（' + (c.publishDate || c.date || '?') + '），不列入正文。来源：' + c.sourceUrl }))
const windowMisses = []
for (const m of discoveredMisses.concat(gatedMisses)) if (m && m.name && !windowMisses.some(w => w.name === m.name)) windowMisses.push(m)

// ─── Phase Synthesize ───
phase('Synthesize')
// 8/17 第十一项：report（上下文最重、最容易撞网关挂起）前先判总墙钟 + 网关探针；
// 超总时限或网关不可用 → 跳过合成直接降级，杜绝挂起空转拖满墙钟。
const synthAllowed = RUN_ELAPSED() <= TOTAL_LIMIT_MS ? await probeGateway('report') : false
if (!synthAllowed) log('SYNTH-SKIP 总墙钟超限或网关探针失败 → 归 raw archive')
const reportBody = (confirmed.length ? confirmed.map((c, i) =>
  // 8/17 第十二项：quote 截断 140 字降 report 输入体积——合成只需要点，引语全文由核查阶段保证；大幅压单请求 payload（挂起敏感度 + token）。
  '### ' + (c.isMajorOut ? '[窗口外·重大] ' : '') + '[' + i + '] ' + c.claim + '\nVote: ' + (c.isMajorOut ? '—（未投票，多源公认行业里程碑）' : (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount) + ' · Source: ' + c.sourceUrl + ' (' + c.sourceQuality + ') · Date: ' + (c.publishDate || c.date || '?') + '\nQuote: "' + c.quote.slice(0, 140) + (c.quote.length > 140 ? '…' : '') + '"\n')
  .join('\n')
  : '(无已确认声明)')
const refutedList = killed.map(c => '- "' + c.claim + '" — ' + c.sourceUrl)
const unverifiedList = unverified.map(c => '- "' + c.claim + '" — ' + c.sourceUrl)
const coverBlock = coverage.map(c => '- ' + c.title + ': ' + c.claims + ' claims / ' + c.urls + ' sources' + (c.degraded ? ' [degraded]' : '') + (c.companiesChecked
  ? ' ; 公司覆盖(' + c.companiesChecked.length + '家): 有动态[' + c.companiesChecked.filter(x => x.state === 'has_dynamic').map(x => x.name).join('、') + '] 未发现动态[' + c.companiesChecked.filter(x => x.state === 'no_dynamic').map(x => x.name).join('、') + ']' + (c.companiesChecked.some(x => x.state === 'unreached') ? ' 未达[' + c.companiesChecked.filter(x => x.state === 'unreached').map(x => x.name).join('、') + ']' : '')
  : '')).join('\n')
const missLines = windowMisses.map(w => '- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note).join('\n')
const missBlock = windowMisses.length ? '\n## 窗口外参考（次要超窗项，须单列一节如实标注，不得混入正文）\n' + missLines : ''

const report = synthAllowed ? await safeAgent(reportPrompt({
  ...ctxP, confirmedVerifyCount: confirmedVerify.length, majorOutCount: majorOutClaims.length,
  reportBody, killedCount: killed.length, refutedList, unverifiedCount: unverified.length, unverifiedList, missBlock, coverBlock,
}), { label: 'report', phase: 'Synthesize', schema: REPORT_SCHEMA, timeoutMs: Math.max(60000, Math.min(600000, TOTAL_LIMIT_MS - RUN_ELAPSED())) }, 1) : null

// ─── md 确定性渲染（report 成功 → 完整版；失败 → 降级版）。render-md.mjs，不再有 mdWriter 代理。───
// report 成功 → md 必然成功（纯字符串拼接），md 产出不再受网关波动影响。
const degradedFlags = []
if (toolError > 0) degradedFlags.push('verify_agent_errors:' + toolError)
if (budgetDropped.length > 0) degradedFlags.push('fetch_budget_dropped:' + budgetDropped.length)
if (discoverRows.some(d => d.degraded) || failedBoardKeys.size > 0) degradedFlags.push('discovery_degraded' + (failedBoardKeys.size ? ':missing_' + [...failedBoardKeys].join('+') : ''))
if (budgetSkipped.length > 0) degradedFlags.push('budget_skipped:' + budgetSkipped.join('+'))
const reportErr = report ? null : 'report agent failed; reverting to raw archive'
if (reportErr) degradedFlags.push('report_failed')
// 归档 payload 数组（claimsJson 与降级 md 共用同一份同构数据，避免两处映射漂移）。
const confirmedOut = confirmed.map(c => ({ claim: c.claim, quote: c.quote, source: c.sourceUrl, sourceQuality: c.sourceQuality, date: c.publishDate || c.date, window: c.isMajorOut ? 'major-out' : claimWindow(c), vote: c.isMajorOut ? '—' : (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount, verifiedByVote: !c.isMajorOut, erroredCount: c.erroredCount || 0, confidence: (c.verdicts.filter(v => !v.refuted)[0] || {}).confidence || (c.isMajorOut ? 'high' : 'low') }))
const refutedOut = killed.map(c => ({ claim: c.claim, source: c.sourceUrl, vote: (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount, erroredCount: c.erroredCount || 0 }))
const unverifiedOut = unverified.map(c => ({ claim: c.claim, source: c.sourceUrl }))
const outOfWindowOut = outOfWindow.map(c => ({ claim: c.claim, source: c.sourceUrl, date: c.publishDate || c.date, vote: (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount, erroredCount: c.erroredCount || 0 }))
const md = report
  ? renderMarkdown({ date: DATE, window: WINDOW_LABEL, report, coverage, windowMisses, degraded: degradedFlags })
  : renderDegradedMarkdown({ date: DATE, window: WINDOW_LABEL, confirmed: confirmedOut, refuted: refutedOut, coverage, windowMisses, degraded: degradedFlags, noNewsCompanies: noDynamicCompanies, reportError: reportErr })

const claimsJson = JSON.stringify({ date: DATE, window: WINDOW_LABEL, confirmed: confirmedOut, refuted: refutedOut, unverified: unverifiedOut, outOfWindow: outOfWindowOut }, null, 1)
// JSON 归档不再走 writer 代理（base64 转录会被 LLM 损坏，曾导致 control-char 非法 JSON + 每失败代理烧 260KB）。
// 改为：workflow 把 payload 原样返回 → 主会话用 Write 逐字节落盘（见下方 payloads 字段）。
const claimsPath = OUT + '/' + DATE + '.verified-claims.json'
const sourcesPath = OUT + '/' + DATE + '.sources.json'
const sourcesJson = JSON.stringify({ date: DATE, sources: sources.map(s => ({ url: s.url, title: s.title, board: s.board, found_via: s.found_via, sourceQuality: s.sourceQuality, publishDate: s.publishDate || s.date, claimCount: s.claims.length, confirmed: confirmed.filter(c => c.sourceUrl === s.url).length })) }, null, 1)
const artifacts = [claimsPath, sourcesPath]  // md 由 orchestrator 从 payloads.md 落盘，artifact 清单列 JSON（3 个见下）

const metaJson = JSON.stringify({
  date: DATE, window: { from: WFROM, to: WTO || DATE }, generated_by: 'ai-daily (deepseek-v4-flash)',
  boards: boards.length, urls_discovered: discoverRows.reduce((n, d) => n + d.urls.length, 0), urls_fetched: sources.length, claims_extracted: allClaims.length,
  claims_verified: voted.length, confirmed: confirmed.length, major_out: majorOutClaims.length, killed: killed.length, unverified: unverified.length, out_of_window_confirmed: outOfWindow.length,
  window_misses: windowMisses,
  url_dupes: dupes.length, fetches_dropped: budgetDropped.length, verify_agent_errors: toolError,
  degraded: degradedFlags, report_error: reportErr,
  // md_written 语义（8/18 重构后）：report 是否成功（1=完整版 md 进 payloads.md，0=降级版 md 仍落盘）——不再是 workflow 写盘计数。
  md_written: report ? 1 : 0, artifacts_failed: [],
  coverage: coverage, noNews_companies: noDynamicCompanies, covered_elsewhere_companies: [...matchedCompany],
  unreached_companies: coverage.map(c => (c.companiesChecked || []).filter(x => x.state === 'unreached').map(x => x.name)).flat(),
}, null, 1)
const metaPath = OUT + '/' + DATE + '.meta.json'
artifacts.push(metaPath)

return {
  date: DATE, window: WINDOW_LABEL, outDir: OUT, artifacts,
  payloads: { claims: claimsJson, sources: sourcesJson, meta: metaJson, md },
  stats: { boards: boards.length, urls_discovered: discoverRows.reduce((n, d) => n + d.urls.length, 0), urls_fetched: sources.length, claims_extracted: allClaims.length, claims_verified: voted.length, confirmed: confirmed.length, major_out: majorOutClaims.length, killed: killed.length, unverified: unverified.length },
  headline: report ? report.oneLiner : null,
  summary: report ? report.execSummary : (confirmed.length ? 'synthesis failed; ' + confirmed.length + ' verified claims archived' : 'no confirmed claims'),
  coverage: coverage,
  artifacts_failed: [],
  degraded: degradedFlags,
}