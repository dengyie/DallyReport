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
// 8/31 修正（8/30 生产实证）：45 发现只抓 12 → _MAX_FETCH/MAX_VERIFY 默认 12→16。
// 8/30 标本：urls_discovered 45、urls_fetched 12、fetch_budget_dropped 33（linuxdo_cdp 17 + other 15 + static 1），
// 10 板轮询公平分配下每个板最多 1 名，还剩 ~8 板第二轮名额被挤掉——覆盖率被配额掐头去尾。
// 16 属预算可容的上限（fetch 480s/verify 300s 仍按批间归软目标；真超时限走既有 BUDGET-BREAK/roomTo 兜底），
// 让更多板真的进一批候选而非整板 0 抓取。
const MAX_FETCH = typeof args.maxFetch === 'number' && args.maxFetch > 0 ? args.maxFetch : 16
const MAX_VERIFY = typeof args.maxVerify === 'number' && args.maxVerify > 0 ? args.maxVerify : 16
const MAX_URLS_PER_BOARD = 6
// 单代理最大存活时长。deepseek 网关偶发"发了工具结果后模型再无回复"的静默卡死：
// 没有此上限时一个卡死代理会永久挡住整个 parallel/pipeline 闸门（实测 >10min 无产出）。
// 超时 → 视作 null → 按阶段重试策略处理（harvest/discover/核查票不换新代理，fetch 换一次，report 有内容至多 2 试）。
// 默认 6 分钟（8/15 起）：不再对昂贵代理做全新重跑，仅对"网关拥堵拖慢完整体"的静默挂起兜底。
const AGENT_TIMEOUT_MS = typeof args.agentTimeoutMs === 'number' && args.agentTimeoutMs > 0 ? args.agentTimeoutMs : 360000

// 8/17 第十一项：Synthesize 前网关健康探针超时 + 主脚本总墙钟上限（宽松兜底，防任一阶段挂起拖满整轮）。
const GATEWAY_PROBE_MS = typeof args.probeTimeoutMs === 'number' && args.probeTimeoutMs > 0 ? args.probeTimeoutMs : 20000
const TOTAL_LIMIT_MS = typeof args.totalLimitMs === 'number' && args.totalLimitMs > 0 ? args.totalLimitMs : 1800000
// 9/01 方案 D：合成入口与总墙钟脱钩。TOTAL_LIMIT_MS 只约束 Harvest–Verify 切片死线，不再当 Synthesize 入口闸门
// （P1 标定落地后病态跑会正确把旧 synthAllowed 打成 false，已确认内容整份降 raw——入口设计错误，不是标定副作用）。
// report 单次 timeout = SYNTHESIS_LIMIT_MS（默认 600s，覆盖现网包络）；有内容 ≤2 试，空板 1 试。
const SYNTHESIS_LIMIT_MS = typeof args.synthesisLimitMs === 'number' && args.synthesisLimitMs > 0 ? args.synthesisLimitMs : 600000
// 8/17 第十四项：墙钟治理升级——TOTAL_LIMIT_MS 拆成各阶段累计死线，
// 每个阶段前 budgetGate 查墙钟，超限即跳过该阶段快速降级（病态运行不再拖满；健康跑远低于死线、永不触发）。
// 切片和 = 9+8+8+5 = 30min 与 TOTAL_LIMIT_MS 对齐（8/19 第十五项调序：Harvest 增到 9、Discover 减到 8，
// 依据见 HARVEST_BUDGET_MS 前的注释——discover 换 Tavily 兜底提速，harvest 保留 442-800s 慢但有效的 crops）；
// 分配序：Harvest/Discover 留足慢但有效的包络，Verify 牺牲序最低。
// 8/17 全量实测（Harvest 5.2 / Discover 9.2 / Fetch 7.3 / Verify 9.1min）证明 30min 盘子装不下 50 代理健康包络（合计 30.8min）：
// 修复后健康跑尾部 Verify 被逐波重算硬停（尾部核查票如实降 unverified）；墙钟为软目标——批末 360s 在飞票与
// 真死网关时 report 重试（≤2×SYNTHESIS_LIMIT_MS）可越过 TOTAL_LIMIT_MS，由 report 自身 timeout + render-md 降级兜底。
// 8/19 第十五项优化：Harvest/Discover 预算对调（480→540 / 540→480），零净盘子 30min 不变。
// 依据：8/18 重跑实测 harvest:crops 442-800s 在 480s 死线上被砍（opensource 38min 后超时、cn-media/en-media crops），
// 而 8/17 全量实测 harvest 健康包络 5.2min。Discover 因 8/19 的 --extra 4 改用 Tavily 快速兜底（~2-5s/查询，
// 对比 --no-extra 打 stateless 代理 ~30-60s/查询），健康 discover 显著提速 → 可让出 60s 给 Harvest，保住慢但有效的 crops。
const HARVEST_BUDGET_MS = typeof args.harvestBudgetMs === 'number' && args.harvestBudgetMs > 0 ? args.harvestBudgetMs : 540000
const DISCOVER_BUDGET_MS = typeof args.discoverBudgetMs === 'number' && args.discoverBudgetMs > 0 ? args.discoverBudgetMs : 480000
const FETCH_BUDGET_MS   = typeof args.fetchBudgetMs   === 'number' && args.fetchBudgetMs   > 0 ? args.fetchBudgetMs   : 480000
const VERIFY_BUDGET_MS  = typeof args.verifyBudgetMs  === 'number' && args.verifyBudgetMs  > 0 ? args.verifyBudgetMs  : 300000
// 8/17 全量修复（观察项①）后 8/20 语义更新：Verify 最后一批在飞票为固定 AGENT_TIMEOUT_MS（360s），无 60s 下限，
// 累计死线仍从 Verify 切片预留 VERIFY_INFLIGHT_BUFFER_MS 缓冲（为末批留空间），但不再对在飞票超时做钳制。
const VERIFY_INFLIGHT_BUFFER_MS = typeof args.verifyInflightBufferMs === 'number' && args.verifyInflightBufferMs > 0 ? args.verifyInflightBufferMs : 60000

const DATE = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : null
const WFROM = args.window && /^\d{4}-\d{2}-\d{2}$/.test(String(args.window.from)) ? String(args.window.from) : null
const WTO = args.window && /^\d{4}-\d{2}-\d{2}$/.test(String(args.window.to)) ? String(args.window.to) : DATE
const OUT = typeof args.outDir === 'string' && args.outDir ? args.outDir : null
const BOARDS_SELECTED = Array.isArray(args.boards) ? new Set(args.boards) : null
const GROK_DIR = '/Users/mango/.claude/skills/grok-search'
// 8/23 第二十一项：linuxdo 接入（登录态 CDP 独立发现组）。linuxdoCdpHost 默认 null → 组保留在
// DISCOVER_GROUPS（板不崩）但 LINUXDO-SKIP no_cdp_host → urls:[] 不降级（命令行/手动补跑默认不启用）；
// linuxdoMaxSources 配额默认 24（帖子轮换进组返回行）。
const LINUXDO_CDP_HOST = typeof args.linuxdoCdpHost === 'string' && args.linuxdoCdpHost ? args.linuxdoCdpHost : null
const LINUXDO_MAX_SOURCES = typeof args.linuxdoMaxSources === 'number' && args.linuxdoMaxSources > 0 ? args.linuxdoMaxSources : 24
// 8/27 Task 2：linux.do 预抓隔离——CDP 抓取从 Workflow realm 前移到宿主 Node（linuxdo-prefetch.mjs，
// run-daily.sh 在调 Workflow 前预抓并把成功 JSON 注入 args.linuxdoPrefetched）。这里严格校验其成功形状：
// ok===true 且 posts 是含 非空 url/title 的数组，才视为有效可消费；否则视同「无有效预抓数据」。
// realm 内不再调用裸 fetchLinuxDoNews34（workflow realm 无 fetch/WebSocket 全局），无有效数据即走 no_fetch_realm 降级。
const LINUXDO_PREFETCHED = (() => {
  const raw = args.linuxdoPrefetched
  if (!raw || typeof raw !== 'object') return null
  if (raw.ok !== true || !Array.isArray(raw.posts)) return null
  const posts = (raw.posts || []).filter(x => x && typeof x.url === 'string' && x.url && typeof x.title === 'string' && x.title)
  if (!posts.length) return null
  return { ok: true, host: raw.host || '', topics: Number(raw.topics) || posts.length, posts }
})()

if (!DATE || !OUT) {
  return { error: 'Args must include date (YYYY-MM-DD) and outDir (absolute path). window optional. got: ' + JSON.stringify(args) }
}
const WINDOW_LABEL = WFROM && WTO ? WFROM + ' ~ ' + WTO : WTO || DATE

// ─── 常量区（供 prompt ctx 与编排使用）───
// 8/15：稠密源（arXiv/HF papers）与普通源统一 12000 字符——稠密源曾是输入大户，降到与普通源同档。
// 8/21 学术板修复：arXiv 官方 API 返回 Atom XML（50 entries ≈ 42KB/URL），普通上限 12000 字符会截到 header →
// 条目被截只剩 1-2 条、digest 空洞。给 arXiv API 源单独放宽：窗口内最近 50 篇的标题/摘要即为此域全部正文，
// 无 `--full-path` 泄露、无多 feed 依赖。其余普通源仍 12000。
const feedMaxChars = f => /export\.arxiv\.org\/api\/query/i.test(f.url || f) ? 40000 : 12000
const WEB_BUDGET_TOTAL = 4
const WEB_BUDGET_PER = 2

// ═══ 模块内联区（build.mjs 替换；逻辑真源见 scripts/ai-daily/*.mjs）═══
// 依赖序与 build.mjs MODULES 一致：url-polyfill 最先（注入 globalThis.URL，workflow realm 无 URL 全局，
// 否则 dedup._hostnameOf / render-md.buildCitationMap 的 new URL() 抛错被 catch 吞 → 完整版 0 角标）；
// date-utils(normURL) 必须在 boards(GROUPS_RAW.test 闭包) 与 dedup 前。
/* @inline: url-polyfill */
/* @inline: date-utils */
/* @inline: schemas */
/* @inline: boards */
/* @inline: dedup */
/* @inline: budget */
/* @inline: wallclock */
/* @inline: ladder */
/* @inline: fallback */
/* @inline: prompts */
/* @inline: render-md */
/* @inline: cluster */
/* @inline: linuxdo */

// boards 由 BOARDS 花名册按选区派生（BOARDS 已 inline 就绪，此时访问无 TDZ）。
const boards = BOARDS_SELECTED ? BOARDS.filter(b => BOARDS_SELECTED.has(b.key)) : BOARDS
// 8/21 学术板修复：arXiv 官方 API 窗口查询（替代 HTML list 页——auto provider(Tavily) 把 HTML 压成 501 字符
// → digest 空 → discover degraded）。URL 含 {{WFROM}}/{{WTO}} 占位（YYYYMMDD + 0000/2359 时刻），此处按窗口展开；
// 无窗口时回退原 list 页（数组原元素）。cs.AI|cs.CL 合并在单 URL，normURL 去 query → key 稳定，digest 归栈一致。
const arxivWindow = (WFROM && WTO) ? { wf: WFROM.replace(/-/g, ''), wt: WTO.replace(/-/g, '') } : null
for (const b of boards) {
  if (!b.feeds) continue
  b.feeds = b.feeds.map(f => arxivWindow ? f.replace('{{WFROM}}', arxivWindow.wf).replace('{{WTO}}', arxivWindow.wt) : f.replace(/{{WFROM}}|{{WTO}}/g, 'recent'))
}

// ─── 编排层 helpers（realm 专属/依赖注入后）───
const impRank = { central: 0, supporting: 1, tangential: 2 }
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }

const WIN_FROM = WFROM ? normalizeDate(WFROM) : null
const WIN_TO = normalizeDate(WTO || DATE)
const claimWindow = makeClaimWindow(WIN_FROM, WIN_TO)

const TRANSIENT = /(422|429|5\d\d|524|timeout|timed out|connection closed|model not found|upstream|gateway|cloudflare)/i
// 8/31 P1：超时定时器是**真实时间的硬证据**——setTimeout(ms) 绝不早于 ms 真实毫秒触发，事件循环
// 饱和只会让它更晚。所以每次真超时都给了「真实经过 ≥ ms」这一事实，与同窗口累加器增量相比即得
// 饥饿倍率，喂给 WALL.observe 标定墙钟（见 wallclock.mjs）。这是 realm 内唯一能反推真实墙钟的通道。
// observe=false：探针等短窗口超时不得喂 WALL——advisory 探针本不该成为墙钟标定样本
// （10–20s 窗口 + tick 饥饿会把 factor 打到 cap，或一次准时超时把峰值抹成 1×）。
const withDeadline = (p, ms, observe = true) => new Promise(resolve => {
  let done = false
  const t0 = _wallMs
  const settle = v => { if (!done) { done = true; clearTimeout(to); resolve(v) } }
  const to = setTimeout(() => {
    // 真超时：ms 真实毫秒已过，而累加器同窗口只涨了 (_wallMs - t0) → 标定饥饿倍率。
    const f = observe ? WALL.observe(ms, _wallMs - t0) : null
    log('agent 超时 ' + Math.round(ms / 1000) + 's 无产出 → 视为失败（按阶段重试策略：harvest/disc/票不换新代理，fetch 换一次，report 有内容至多 2 试）'
      + (observe
        ? ' [墙钟标定 累加器仅计 ' + Math.round((_wallMs - t0) / 1000) + 's → 饥饿倍率 ' + (f || 1).toFixed(2) + '×]'
        : ' [探针/短窗超时不标定墙钟]'))
    settle(null)
  }, ms)
  p.then(v => settle(v), () => settle(null))
})
const safeAgent = async (p, o, tries = 2) => {
  for (let i = 0; i < tries; i++) {
    let r = null
    try { r = await withDeadline(agent(p, o), o.timeoutMs || AGENT_TIMEOUT_MS) } catch (e) {
      const msg = String(((e && (e.message || e.error)) || e) || '')
      if (i === tries - 1 || !TRANSIENT.test(msg)) {
        log('safeAgent fail ' + (o.label || '?') + ': ' + msg.slice(0, 120))
        BREAKER.record(false, o.label || '?')  // 8/31 P1-①：终局失败计入断路器
        return null
      }
      log('safeAgent retry ' + (i + 1) + ' ' + (o.label || '?') + ': ' + msg.slice(0, 100))
      continue
    }
    if (r) { BREAKER.record(true, o.label || '?'); return r }
    if (i === tries - 1) {
      log('safeAgent fail ' + (o.label || '?') + ' (null agent)')
    } else {
      log('safeAgent retry ' + (i + 1) + ' ' + (o.label || '?') + ' (null agent)')
    }
  }
  // 用尽 tries 仍无产出（含 withDeadline 超时的 null 路径）= 终局失败，计入断路器。
  BREAKER.record(false, o.label || '?')
  return null
}
// 8/17 第十一项：墙钟基准用 performance.now()（Workflow realm 内 Date.now()/new Date() 会抛错）。
// 8/17 第十四项：墙钟基准。Workflow realm 里 performance 不存在（实测 undefined）、Date.now()/new Date() 被静态拒绝（resume 确定性）。
// 唯一可用时钟源 = setTimeout 链累加：脚本启动即开一条每 250ms 自递归的链累加 _wallMs，await 期间事件循环空闲时持续推进（实测 agent 跑 2.2s → 累加 2000ms，吻合）。
// 精度 250ms 对分钟级墙钟预算足够；resume 时链重新起算（脚本从头跑），语义=重新计时，与本注释历史意图一致。
// 8/31 P1 根因：上面这段标定（「实测 agent 跑 2.2s → 累加 2000ms，吻合」）**只在健康快跑成立**。
// 累加器计的是 tick 发生次数 × 250ms；54 代理 + 26 stall + harness stall 检测把事件循环压满后
// tick 被饿死 → 累加器只低估、永不高估（8/31 实测 Fetch gate ≥4.7×、Verify ≥6.6×、synth ≥7.6×，
// 4h13m 的 run 零 BUDGET-SKIP）。修法见 wallclock.mjs：用超时定时器反推真实经过下界，标定倍率。
const _TICK_MS = 250
let _wallMs = 0
const _tick = () => { _wallMs += _TICK_MS; setTimeout(_tick, _TICK_MS) }
setTimeout(_tick, _TICK_MS)
const now = () => _wallMs
const RUN_START = now()
const RUN_ELAPSED_RAW = () => now() - RUN_START
// WALL 包住原始累加器：无观测时 factor=1 逐字节等价旧行为（健康跑零影响）；
// withDeadline 真超时且 observe=true 才标定（探针传 false，短窗不得污染倍率）。
const WALL = makeCalibratedElapsed(RUN_ELAPSED_RAW)
const RUN_ELAPSED = () => WALL.elapsed()
// 8/31 P1-①：计数型断路器——不依赖时钟（饱和下计数信号依然准确），连续 3 次或累计 5 次代理失败即跳闸，
// 之后不再放行昂贵的 Discover 代理批，直连 static-fallback → Fetch。
// 8/31 实证：Harvest 烧 70min、Discover 再烧 129min，而此间 DISCOVER-FAIL 早已密集出现。
const BREAKER = makeCircuitBreaker({
  consecutive: typeof args.breakerConsecutive === 'number' ? args.breakerConsecutive : 3,
  total: typeof args.breakerTotal === 'number' ? args.breakerTotal : 5,
})
const probeGateway = async label => {
  const t0 = now()
  const p = await withDeadline(agent('仅回复 OK。', { label: 'probe:' + label, effort: 'low', timeoutMs: GATEWAY_PROBE_MS }), GATEWAY_PROBE_MS, false)
  const took = Math.round(now() - t0)
  // 8/30：探针由「合成否决权」降为「只观察」——探针失败不再跳过 report（8/29 实证：
  // 单次 20s 探针超时竟把 9 条已确认内容整体判死，report 代理其实从未被调用过）。
  // 探针只用于记录网关饱和度；真死网关由 report 自身 600s 超时 + safeAgent 重试兜底。
  if (!p) { log('PROBE-FAIL advisory ' + label + ' ' + took + 'ms 探针未通过（不否决合成）'); return false }
  log('PROBE-OK ' + label + ' ' + took + 'ms'); return true
}
// 9/02 模型阶梯：仅 report + verify 走四级降级。DEFAULT_LADDER 由 ladder.mjs inline 提供。
// 必须放在时钟块（_TICK_MS / now）之后——workflow-integration 切片 const safeAgent … const _TICK_MS 不得被污染。
const MODEL_LADDER = Array.isArray(args.modelLadder) && args.modelLadder.length > 0 ? args.modelLadder : DEFAULT_LADDER
const LADDER_BUDGET_MS = typeof args.ladderBudgetMs === 'number' ? args.ladderBudgetMs : DEFAULT_LADDER_BUDGET_MS
const ladderUsed = []
const ladderExhaustedStages = new Set()
const safeAgentWithLadder = makeSafeAgentWithLadder({
  agent, withDeadline, now, log, TRANSIENT, AGENT_TIMEOUT_MS,
  onRecovered: (label, model) => { ladderUsed.push(label + ':' + model) },
  onExhausted: (label) => { ladderExhaustedStages.add(/^report/.test(String(label)) ? 'report' : 'verify') },
})
// 8/17 第十四项：阶段墙钟闸门——某阶段前查 RUN_ELAPSED 是否已过该阶段累计死线；超限即记 budget_skipped + log，返回 ok:false。
// roomMs = 死线减已耗，供批内 timeoutMs 收紧（in-flight 硬停）。performance 不可用时 now()=0 → 恒放行（软兜底失效但不误杀已完成工作）；resume 重新起算仅宽松兜底。
// budget.mjs：computePhaseDeadlines 算累计死线 + makeBudgetGate(stage) 闸门（elapsedFn 注入 RUN_ELAPSED，clock 解耦测试化）。
const PHASE_DEADLINES = computePhaseDeadlines({
  harvest: HARVEST_BUDGET_MS, discover: DISCOVER_BUDGET_MS, fetch: FETCH_BUDGET_MS,
  verify: VERIFY_BUDGET_MS, verifyInflightBuffer: VERIFY_INFLIGHT_BUFFER_MS, totalLimit: TOTAL_LIMIT_MS,
})
// 注意：HARVEST/DISCOVER/FETCH/VERIFY_BUDGET_MS 是"该阶段允许花多久"的切片（用户可单独调），
// 死线必须累加——若误把切片当死线，Verify 切片 5min 会在健康跑（elapsed 早已 >5min）误判超时。
// Verify 累计死线在切片和后另减 VERIFY_INFLIGHT_BUFFER_MS：为最后一批在飞票（固定 360s）预留空间，
// 墙钟仅为软目标——极端尾批 / 真死网关时 report 重试（≤2×SYNTHESIS_LIMIT_MS）可超 TOTAL_LIMIT_MS，由 report 自身 timeout + render-md 降级兜底。
const budgetGate = makeBudgetGate(PHASE_DEADLINES, RUN_ELAPSED, stage =>
  log('BUDGET-SKIP ' + stage + ' elapsed=' + Math.round(RUN_ELAPSED() / 1000) + 's ≥ 死线 ' + Math.round(PHASE_DEADLINES[stage] / 1000) + 's → 跳过该阶段快速降级'))
const budgetSkipped = budgetGate.skipped  // degraded 标记读取（makeBudgetGate 内同 stage 只记一次）
// 8/26 修复（Discover 慢代理不得拖垮 Fetch）：discover 批边界加"给 Fetch 保留窗口"的墙钟闸门。
// 根因（8/24/8/25 实证）：discover 单代理 timeout 上限 30/40min，慢批把墙钟拖过 Fetch 累计死线 →
// budgetGate('Fetch') 在阶段 START 判定整段跳过（urls_fetched=0）。no-room 硬约束禁止收紧 timeoutMs，
// 修法只能在批边界层：discover 每批启动前用 budgetGate.roomTo('Fetch')（纯读、不记账）看距
// Fetch 死线的剩余；余额 ≤ DISCOVER_FETCH_RESERVE_MS 就不再放行新 discover 批（BUDGET-BREAK Discover），
// 把余下的墙钟留给 Fetch 真实抓批——即使 Fetch 只跑 1-2 批也比整段跳过（0 源 → 0 claim）强。
// 健康包络（8/22 实测：harvest ~5-9min、discover ~9-11min、Fetch ~7min）下，健康批启动时
// roomTo('Fetch') 常年落在 13-18min，远高于阈值 → 永不触发；只有病态慢窗（discover 吞墙钟）才触发。
const DISCOVER_FETCH_RESERVE_MS = 480000  // 恒为 Fetch 保留整块切片时长（=FETCH_BUDGET_MS 8min）：绝不让 discover 吃光 Fetch 窗口

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
for (const batch of chunkArr(HARVEST_GROUPS, HARVEST_BATCH)) {
  if (!budgetGate('Harvest').ok) { log('BUDGET-BREAK Harvest 余批跳过，用已完成批次结果'); break }
  const round = await parallel(batch.map(g => () =>
    // 8/16 复盘根因：harvest 不带 timeoutMs → 吃 AGENT_TIMEOUT_MS=360s，而 5 组共源并发下 3 个分组实测 384–800s
    // 才完成（cn-media 442s / opensource 384s / en-media 800s）。withDeadline 在 360s 先让 safeAgent 返回 null →
    // .then 里 failed=true → digest 整块标"抓取失败"，已完成的工作被静默丢弃 → 6 个媒体板 discover 拿到空摘要、
    // 只剩 X 搜索兜底 → 8/9 板 degraded。死线放到 1800s：让已完成的 harvest 结果真正进 digest（慢但必须被用上）。
    // 8/20 第十六项：timeoutMs 解耦到固定上界 1800s，与阶段墙钟 room 无关——8/19 回归根因：第十四项把 room
    // 注入 timeoutMs，disc:academic 实测 436s 成功提交 schema，却被 room 收紧的 410s 提前判废丢弃 → 9 板全降级。
    // 墙钟只在批间 BREAK 检（下方 if !budgetGate('Harvest').ok）判定；单代理超时不再看 room，防挂死用固定上界。
    safeAgent(harvestPrompt(g, ctxBase), { label: 'harv:' + g.key, phase: 'Harvest', schema: HARVEST_SCHEMA, effort: 'low', timeoutMs: 1800000 }, 1)
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
// 9/01 覆盖韧性：Harvest 连续失败会垫高 consecutive；Discover 入口只清连续计数，
// 不清 failures/reason。已跳闸（Harvest 已烧穿阈值）仍 open，代理余批照跳。
BREAKER.resetConsecutive()
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
// 9/01 P2：linuxdo 是宿主预抓通道（CDP，不走 safeAgent），不得被代理失败断路器丢掉。
// linuxdo 在 DISCOVER_GROUPS 末位，DISCOVER_BATCH=3 → 第 2 批；Harvest consecutive=3 可在
// Discover 起跑前跳闸。同批把 cdp 挪到 BREAKER.open() 之前仍会在第 1 批 break 时丢掉预抓。
// 因此三态消费必须在代理批循环之外、之前；BREAKER/budget 只闸后续 discover 代理。
for (const g of DISCOVER_GROUPS) {
  if (!g.cdp) continue
  if (!LINUXDO_CDP_HOST) {
    log('LINUXDO-SKIP no_cdp_host ' + g.key + ' → urls:[]，不降级')
    discoverResults.push({ group: g, boards: g.boards, urls: [], noNews: [], nearWindow: [], majorOutOfWindow: [], degraded: false, linuxdoSkipped: true })
    continue
  }
  // 8/27 Task 2：优先消费 run-daily.sh 注入的 linuxdoPrefetched 预抓 JSON（已按上方严格校验）。
  // 无有效预抓数据时——不调用裸 fetchLinuxDoNews34（workflow realm 无 fetch/WebSocket，
  // 裸 CDP 长跑不可能、裸 HTTP 必 403）——记录 no_fetch_realm 稳定原因并降级，绝不静默空板。
  const LDP = LINUXDO_PREFETCHED
  if (!LDP) {
    log('LINUXDO-FAIL no_fetch_realm → ' + g.key + ' 降级（linuxdoPrefetch 无有效数据，realm 内不裸抓 CDP）')
    discoverResults.push({ group: g, boards: g.boards, urls: [], noNews: [], nearWindow: [], majorOutOfWindow: [], degraded: true, linuxdoFailed: true, linuxdoReason: 'no_fetch_realm' })
    continue
  }
  log('LINUXDO-OK prefetched ' + LDP.topics + ' topics → ' + g.key + ' board（配额 ' + LINUXDO_MAX_SOURCES + '）')
  const srcs = LDP.posts.slice(0, LINUXDO_MAX_SOURCES).map(p => ({
    url: p.url, title: p.title, found_via: 'linuxdo-cdp', date: p.date || DATE, board: 'linuxdo',
    snippet: p.snippet || '',
  }))
  discoverResults.push({ group: g, boards: g.boards, urls: srcs, noNews: [], nearWindow: [], majorOutOfWindow: [], degraded: false, linuxdoTopics: LDP.topics, linuxdoPosts: LDP.posts.length })
}
for (const batch of chunkArr(DISCOVER_GROUPS, DISCOVER_BATCH)) {
  if (!budgetGate('Discover').ok) { log('BUDGET-BREAK Discover 余批跳过，用已完成批次结果'); break }
  // 8/26 修复：Discover 慢代理保护 Fetch 的墙钟闸门（见 DISCOVER_FETCH_RESERVE_MS 注释）。
  // safeAgent birth 前查「距 Fetch 累计死线剩余」；不足阈值则本批不再放行新 discover 代理，
  // BUDGET-BREAK Discover 余批跳到 Fetch（丢弃慢批换取 Fetch 真实抓批，保住已发现 URL 摄入机会）。
  // 仅在 roomTo('Fetch') 低时触发——健康窗远高于阈值，永不触发、不影响既有 Discover stage 各批合法跑。
  // parallel 内的 map 若在批启动点已被 BREAK 跳过，不会再生效（break 跳出 for、round 不建），语义完整。
  if (budgetGate.roomTo('Fetch') < DISCOVER_FETCH_RESERVE_MS) {
    log('BUDGET-BREAK Discover 距 Fetch 死线仅 ' + Math.round(budgetGate.roomTo('Fetch') / 1000) + 's < 保留窗 ' + Math.round(DISCOVER_FETCH_RESERVE_MS / 1000) + 's → 余批跳过，时间留给 Fetch')
    break
  }
  // 8/31 P1-①：计数型断路器闸门。墙钟在事件循环饱和下只低估（4.7–7.6×），上面两道墙钟闸门
  // 因此在最需要它们的那种 run 里恰好失效——8/31 实测 Harvest 烧 70min、Discover 再烧 129min 而
  // 零 BUDGET-BREAK。失败计数不依赖时钟，饱和下依然准确，是最后一道可靠闸门：
  // Harvest/前批 Discover 已连续/累计失败到阈值 → 后续 Discover 代理大概率同样白烧，直接跳到
  // static-fallback → Fetch（保住真实抓批与产出），并把跳闸原因如实写进 degraded。
  // 9/01 P2：本闸只拦代理。linuxdo 已在循环外消费，跳闸不得丢掉预抓。
  if (BREAKER.open()) {
    log('BREAKER-OPEN Discover 余批跳过（' + BREAKER.reason() + '，代理失败计数 ' + JSON.stringify(BREAKER.stats) + '）→ 直连 static-fallback → Fetch')
    break
  }
  // 8/23 C2 复核修复：cdp 组已在循环外预块处理并 push（CDP 抓取不进普通发现代理）；此处只跑普通组，
  // 避免 linuxdo 组被双 push（urls_discovered 翻倍、Fetch 预算空耗）且不被当普通代理喂裸
  // https://linux.do/c/news/34（spec §A 明文裸 fetch 必 403 → 长墙钟失败 + 误标 degraded，违背
  // 「默认不启用时板不崩」）。.filter 后 batch 内不再有 g.cdp 组，.then 无需再判 cdp。
  const round = await parallel(batch.filter(g => !g.cdp).map(g => () =>
    // 8/16：discover 与 harvest 同款的批量串行（5→3+2 两波）+ 按实测放宽死线 + 瞬时错误重试一次。
    // 8/15 只给 labs 特殊 600s 并在单板冒烟里验证（334s 达标），全量 5 并发时网关争抢使每个 discover 都 3-6×变慢，
    // media-cn 实测 1967s、labs 1213s、opensource/media-en 各 ~770s，全部超死线被 withDeadline 丢弃 → 8/9 板块 degrade、23/23 unreached。
    // 修法：批量降并发（复用 harvest 的 3 并发批次，两波跑完），并把死线放到实测量级——慢但已完成的发现结果必须被用上，不许静默丢弃。
    // 8/16 二打：批量已生效（两波严格串行），但 disc:media-en 实测 2336s 后 API Connection closed（瞬时错误）
    // → tries=1 无重试 → strategy/products/funding/policy 4 板尽失 + 40 分钟墙钟。当初升 tries=2 意在保护 9 板覆盖。
    // 8/17 第十四项复盘改回 tries=1：实测 tries=2 在网关差窗口下**没能**保护（8/17 media 两组重试后仍全废），反而烧 80min 死路；
    // 且 safeAgent 的 null 路径（withDeadline settle(null)）不查 TRANSIENT、无条件重试——删正则也拦不住重跑。tries=1 是唯一可靠杠杆，
    // 配合阶段墙钟预算（budgetGate）兜底：失败即如实降级（标 missing_*），时间省给探针/其他阶段。失败可见性由 DISCOVER-FAIL 日志补上。
    safeAgent(discoverPrompt(g, ctxP), { label: 'disc:' + g.key, phase: 'Discover', schema: DISCOVER_SCHEMA, timeoutMs: g.key === 'labs' ? 1800000 : 2400000 }, 1)
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

// ─── Discover 失败兜底（8/22 第十八项）：用 harvest 已抓到的 entries 补 URL 候选 ───
// 根因（systematic-debugging 实证）：deepseek-v4-flash 长思考后倾向 end_turn 不调 StructuredOutput
// → disc:academic 返回 null（thinking 里已推导出 6 条 URL 却没调工具）→ tries=1 不重试 → DISCOVER-FAIL → academic 板 0 claim。
// harvest 阶段已成功抓到 feed entries（arXiv API + direct 走通），这些 entries 本就是高置信候选。
// 兜底：disc 失败的组，直接从 digestByKey 取窗口内 entries 补进 boardURLMap，不重跑代理（省墙钟、不烧 token）。
// 仅对失败的组补，且只取非窗口外（claimWindow !== 'out'，含 in 与无日期 unknown——后者交 verify 把关）、有 url 的 entries。found_via 标 "harvest-fallback" 供核查溯源。
//
// 8/22 第二十项 CRITICAL-1 修复：合组（media-cn/media-en，g.boards.length>1）失败时，旧版把 board 置 null
// → 下游 if(!u.board) continue 把兜底 entry 全丢弃，兜底对合组完全失效（恰是历史高发场景）。
// 修复：board 按 digest feed.boards（feedMap 已按板订阅集记录）与 g.boards 求交派生，交集中每个板都补进
// boardURLMap——allocateFetchBudget 跨板按 normURL 去重，同 URL 补多板只 fetch 一次，不重复抓取。
// 空交集（冒烟子集 BOARDS_SELECTED：feed 订阅板被过滤掉）时跳过该 entry，不灌到首板制造错误归属。
// 同时记 recoveredBoards：兜底救回的板在 computeBoardStates 里从 missing 降为 degraded（HIGH-2：兜底救回内容
// 但「通道失败」如实降级保留，不再误标 missing/unreached 让 coverage 自检读成「该板 0 claim 无覆盖」）。
//
// 兜底构造逻辑抽为纯函数 buildFallback（fallback.mjs，build.mjs inline 在此），消除"测试复刻修复逻辑"的 forward-test
// 缺陷——测试直调 buildFallback 断言真实行为，而非 grep 模板源码。
const succeedGroupKeys = new Set(discoverRows.map(d => d.group.key))
const failedGroups = DISCOVER_GROUPS.filter(g => !succeedGroupKeys.has(g.key))
const recoveredBoards = new Set()
if (failedGroups.length) {
  // 预算每失败组的 srcUrls（合组走 g.feeds 硬编码源；单板组从 boards 订阅源派生，含 labs 官方源），挂到 g.srcUrls。
  for (const g of failedGroups) {
    const bds = g.boards.map(k => boards.find(b => b.key === k)).filter(Boolean)
    g.srcUrls = g.feeds ? g.feeds : bds.flatMap(b => (b.feeds || []).concat((b.companies || []).filter(c => c.feed).map(c => c.feed)).concat(b.key === 'labs' ? OFFICIAL_FEEDS.map(f => f.url) : []))
  }
  const { fallbackByUrl, recoveredBoards: rb } = buildFallback(digestByKey, failedGroups, claimWindow, normURL)
  for (const b of rb) recoveredBoards.add(b)
  if (fallbackByUrl.length) {
    log('DISCOVER-FALLBACK ' + failedGroups.map(g => g.key).join('+') + ' → ' + fallbackByUrl.length + ' 条 harvest entries 补进 ' + recoveredBoards.size + ' 板（disc 失败兜底；CRITICAL-1：合组 board 按 feed.boards∩g.boards 派生）')
    for (const u of fallbackByUrl) {
      if (!boardURLMap.has(u.board)) boardURLMap.set(u.board, [])
      boardURLMap.get(u.board).push(u)
    }
  }
}

// 第二层静态兜底（8/26 新增）：discover 全组 0 候选/通道坏 或 全失败(missing) + harvest-fallback 未救回 → 注入精选一级/官方页 URL。
// 触发收宽（8/26 生产实证 wf_f7cc4d14）：原只看「组是否全失败(null)」，漏掉 disc:labs/disc:opensource
// 「组成功返回但 urls 空且自报 degraded」的通道坏场景 → 板仍 0/0。现两类任一即注入：
//   (A) 全部归属组均无返回行（missing）；
//   (B) 所有归属组返回的行 urls 均为 [] 且其中至少一个行自报 degraded。
// 任一归属组给了 URL（delivered）则不注入（近窗/超窗都算给过候选）。
// 注入 boardURLMap → 进 fetch 配额 → fetch/verify 仍对抗式处理。诚实书账：不注入 discoverRows.urls
// （urls_discovered 不含）；degraded 保留（discover 代理失败如实上报）；不写 recovered（无恢复据）。
const staticFallbackBoards = new Set()
{
  const staticByBoard = new Map()
  for (const s of STATIC_FALLBACK_SOURCES) {
    if (!staticByBoard.has(s.board)) staticByBoard.set(s.board, [])
    staticByBoard.get(s.board).push(s)
  }
  // 8/26 生产实证（wf_f7cc4d14）：disc:labs/disc:opensource 组「成功返回但 0 候选 URL + 自报 degraded」
  // → 原触发只看「组是否全失败(null)」→ 不注入 → 板仍 0/0。
  // 现收宽为两类之一即注入：
  //   (A) 所有归属组失败（null / 无返回行）→ 板 missing
  //   (B) 所有归属组返回的行都 0 候选，且其中至少一行自报 degraded（通道坏但组活着）
  // 有任一归属组给了 URL（delivered）→ 板已有候选，不注入。
  const rowsOf = g => discoverRows.find(d => d.group.key === g.key)
  for (const b of boards) {
    const key = b.key
    if (key === 'linuxdo') continue
    const groupsOfBoard = DISCOVER_GROUPS.filter(g => g.boards.includes(key))
    if (!groupsOfBoard.length) continue  // 无归属组（理论上不会）→ 跳过

    const delivered = groupsOfBoard.some(g => {
      const r = rowsOf(g)
      return r && r.urls.length > 0
    })
    if (delivered) continue             // 板已有真实候选 URL（urls 含近窗/远窗），不注入
    const anyReturnedWithURL = groupsOfBoard.some(g => {
      const r = rowsOf(g)
      if (!r) return false
      // 8/31 修正（8/30 生产实证）：移除 8/27 的窗外信号排除门。
      // 8/27 认为「0 URLs + degraded + 有 nearWindow/majorOutOfWindow 产物 → 窗口内确实没新闻 → 不注入」；
      // 8/30 两板实证打脸：academic/labs 返回 degraded + 0 窗内 URL，却带窗外探索产物
      // （Opus-4 08-28、Sonnet-4 08-26 等其实落在窗口内），该门把它们整板堵成 0 claim——
      // 「代理返回窗外产物」≠「窗口内确无新闻」：degraded 来自通道失败，窗外产物只是检索副产品。
      // 而静态源（官方首页/arXiv 最新）注入后 fetch/verify 仍对抗式处理，真窗内 claim 会被保留，
      // 窗外内容也会被 dates 过滤——注入不引入错误内容，却救回本该有内容却因通道失败而 0 的板。
      // 故 8/31 起仅凭「0 URLs + degraded」即注入，不再看窗外信号。
      return r.urls.length === 0 && r.degraded
    })
    const allMissingRows = groupsOfBoard.every(g => !rowsOf(g))
    const shouldInject = allMissingRows || anyReturnedWithURL
    if (!shouldInject) continue
    if (recoveredBoards.has(key)) continue  // harvest-fallback 已救回 → 不注入
    const cands = staticByBoard.get(key) || []
    if (!cands.length) continue
    staticFallbackBoards.add(key)
    const arr = boardURLMap.has(key) ? boardURLMap.get(key) : (boardURLMap.set(key, []), boardURLMap.get(key))
    for (const s of cands) arr.unshift({ ...s, found_via: 'static-fallback', date: DATE, board: key })
  }
}
if (staticFallbackBoards.size) {
  log('STATIC-FALLBACK ' + [...staticFallbackBoards].join('+') + '：discover 全组 0 候选/通道坏 或 missing → 注入精选常驻一级/官方新闻页 URL，fetch 仍对抗式处理（degraded 保留如实上报）')
}

let { fetchTargets, dupes, budgetDropped } = allocateFetchBudget(boardURLMap, MAX_FETCH)
// 8/27 prefer 通道：linuxdo-cdp 与 static-fallback 候选优先占位（预抓/兜底=已投入资源，真实进 Fetch），
// 其余走轮询公平；MAX_FETCH 仍是硬上限（单板墙量配额经 preferCap=floor(MAX_FETCH×0.5) 封顶）。
const linuxdoFetched = fetchTargets.filter(t => t.found_via === 'linuxdo-cdp').length
const linuxdoCdpUrls = (boardURLMap.get('linuxdo') || []).filter(u => u.found_via === 'linuxdo-cdp')
// 8/27 Task 2 书账：逐类统计被预算丢弃的候选（谁被丢、为什么），供 Dedup 日志与 meta.dropped_detail 复用。
const linuxdoDropped = budgetDropped.filter(d => linuxdoCdpUrls.some(u => u.url === d.url)).length
const staticUrls = [...boardURLMap.values()].flat().filter(u => u.found_via === 'static-fallback')
const staticDropped = budgetDropped.filter(d => staticUrls.some(u => u.url === d.url)).length
const otherDropped = budgetDropped.length - linuxdoDropped - staticDropped
log('Dedup: ' + dupes.length + ' dupes, ' + budgetDropped.length + ' budget-dropped, fetching ' + fetchTargets.length +
  (linuxdoFetched ? ' · linuxdo-cdp 进配额 ' + linuxdoFetched + '（丢弃 ' + linuxdoDropped + '）' : ''))
// 9/01 P0：不再 preferStaticFirst。allocateFetchBudget Phase 1 已按通道轮询混排 linuxdo-cdp
// 与 static-fallback；二次静态前置会把 linuxdo 挤出 FETCH 首批，BUDGET-BREAK 后整席蒸发。
// 诚实书账：staticCount 只统计已经进入 fetchTargets 的项（已在 allocation 内获配额），
// 不统计被预算丢弃（budgetDropped）或未进入配额的候选——不虚报未获配额的静态候选。
const staticCount = fetchTargets.filter(t => t.found_via === 'static-fallback').length
if (staticCount > 0) log('STATIC-FALLBACK quota: ' + staticCount + ' 条静态兜底 URL 已获 fetch 配额（fetchTargets 内实计）')
// 9/01 P1：配额内带 snippet 的 linuxdo 直铸 forum claim，不再进 fetch 代理（linux.do 无 cookie → 403）。
// 空 snippet 仍走既有 fetch。配额外的 budgetDropped 不铸——MAX_FETCH 硬上限不变。
const extracted = []
{
  const mintedUrls = new Set()
  for (const t of fetchTargets) {
    if (t.found_via !== 'linuxdo-cdp') continue
    const minted = mintLinuxdoSource(t, DATE)
    if (!minted) continue
    extracted.push(minted)
    mintedUrls.add(t.url)
  }
  if (mintedUrls.size) {
    log('LINUXDO-MINT ' + mintedUrls.size + ' 条配额内 snippet 直铸（跳过 fetch 代理）')
    fetchTargets = fetchTargets.filter(t => !mintedUrls.has(t.url))
  }
}
// 首批固定 FETCH_BATCH：allocate 前缀已混排，不得用 staticCount 扩首批把 linuxdo 挤出。
// 静态注入不在 discoverRows.urls → urls_discovered 账本不变（boardURLMap 仅从 discoverRows 派生）。
const FETCH_BATCH = 6
const FETCH_FIRST_BATCH = FETCH_BATCH
const fetchBatches = []
if (fetchTargets.length) fetchBatches.push(fetchTargets.slice(0, FETCH_FIRST_BATCH))
for (let i = FETCH_FIRST_BATCH; i < fetchTargets.length; i += FETCH_BATCH) fetchBatches.push(fetchTargets.slice(i, i + FETCH_BATCH))

// ─── Phase Fetch + Extract ───
phase('Fetch')
let stageFetchRan = false  // 8/27 一次性状态：Fetch 首批是否已正常启动（预算记账过 + 会在 await 前置位）
let salvaged = false  // 8/26 修复：救护首批已标记——余批整批 break，不再碰 budgetGate('Fetch')，避免把已抓过批的 Fetch 误记成「整段跳过」
for (const batch of fetchBatches) {
  if (salvaged) break  // 救护首批已跑：余批不再处理（budgetGate('Fetch') 不再被调用 → budgetSkipped 不记 Fetch）
  // 8/27 预算书账（stageFetchRan 一次性）：
  //  - 首批正常启动：调 budgetGate('Fetch')（记 skipped 的 gate）判定整段跳过/放行；放行则在 await 前置 stageFetchRan=true。
  //  - 首批越线：只允许现有救护语义（FETCH-SALVAGE），不调用记账 gate → 不把 Fetch 写进 skipped。
  //  - 后续批次：用纯读 budgetGate.roomTo('Fetch') === 0 停止，绝不再次把 Fetch 写入 skip。
  // 9/01：mint 会在循环前写入 extracted，救护不得再看 extracted.length===0（否则静态余批被记账 gate 整跳）。
  const salvageFirst = !stageFetchRan && fetchTargets.length > 0 && budgetGate.roomTo('Fetch') === 0
  if (stageFetchRan) {
    // 后续批次：纯读停止（roomTo 无记账副作用），不再调用 budgetGate('Fetch')。
    if (budgetGate.roomTo('Fetch') === 0) { log('BUDGET-BREAK Fetch 余批跳过（首批已跑，roomTo=0 纯读停止，不记 budget_skipped:Fetch）'); break }
  } else if (!salvageFirst) {
    const gate = budgetGate('Fetch')
    if (!gate.ok) { log('BUDGET-BREAK Fetch 余批跳过，用已完成批次结果'); break }
    stageFetchRan = true  // 首批正常启动：await 前置 one-time 状态（预算账本已钉在「已运行」）
  } else {
    log('FETCH-SALVAGE 已过 Fetch 死线但执行救护首批：抓前 ' + batch.length + ' 条 URL（保证非 0 摄入）')
  }
  const batchRes = await parallel(batch.map(src => () =>
    safeAgent(fetchPrompt(src, ctxP), { label: 'fetch:' + hostOf(src.url), phase: 'Fetch', schema: EXTRACT_SCHEMA, effort: 'low', timeoutMs: AGENT_TIMEOUT_MS }, 2)
      .then(ext => {
        if (!ext) return null
        src.sourceQuality = ext.sourceQuality
        src.publishDate = ext.publishDate
        src.claims = (ext.claims || []).map(c => ({ ...c, sourceUrl: src.url, sourceTitle: src.title, sourceQuality: ext.sourceQuality, date: src.date, board: src.board }))
        return src
      }).catch(e => ({ ...src, sourceQuality: 'unreliable', claims: [] }))
  ))
  extracted.push(...batchRes)
  if (salvageFirst) salvaged = true  // 抓完救护首批后置位：下一个循环迭代整批 break 跳出
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

const _voteBatch = (c, n, startIdx, timeoutMs) => parallel(Array.from({ length: n }, (_, v) => () => {
  const label = 'v' + (startIdx + v) + ':' + (c.claim || '').slice(0, 30)
  return safeAgentWithLadder(verifyPrompt(c, ctxP), { label, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'low', timeoutMs }, MODEL_LADDER, LADDER_BUDGET_MS).then(r => {
    BREAKER.record(!!r, label)
    return r
  })
}))
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
// 8/20 第十六项：vtimeout 取固定 AGENT_TIMEOUT_MS，与 room 无关；批间 BREAK 守护留在批次边界，不进入单代理超时。
// 缓冲保留以为末批（固定 360s）留空间；墙钟是软目标，尾批可超 TOTAL_LIMIT_MS（最坏：真死网关 report 重试 ≤2×SYNTHESIS_LIMIT_MS），由 report 自身 timeout + 降级兜底。
// 8/28 账本修复（镜像 Fetch 的 stageFetchRan 一次性状态）：救护/后续批次不再调有副作用的 budgetGate('Verify')——
// 只要首批正常跑过 or 救护首批跑过（voted 非空 / 有 claim 待核），就绝不把 Verify 误记成 budget_skipped:Verify。
// 否则会再现 8/27 的「claims_verified>0 却同时上报 budget_skipped:Verify」自相矛盾。
let stageVerifyRan = false  // 8/28 一次性状态：Verify 首批是否已正常启动（预算记账过 + 会在 await 前置位）
for (const batch of chunkArr(rankedClaims, VERIFY_BATCH)) {
  const salvage = !stageVerifyRan && voted.length === 0 && rankedClaims.length > 0 && budgetGate.roomTo('Verify') === 0
  if (stageVerifyRan) {
    // 后续批次：纯读停止（roomTo 无记账副作用），不再调用 budgetGate('Verify')。
    if (budgetGate.roomTo('Verify') === 0) { log('BUDGET-BREAK Verify 余批跳过（已跑首批，roomTo=0 纯读停止，不记 budget_skipped:Verify）'); break }
  } else if (salvage) {
    // 8/27 修复：Verify 死线已过但尚未跑任何批 → 救护首批（镜像 Fetch 的 FETCH-SALVAGE）
    // 保证非 0 核查——至少跑一批最高优先级 claim，避免整个 Verify 被跳过导致 report 缺输入。
    const salvageCount = Math.min(VERIFY_BATCH, rankedClaims.length)
    log('VERIFY-SALVAGE 已过 Verify 死线但执行救护首批：核查前 ' + salvageCount + ' 条最高优先级 claim（保证非 0 确认）')
    const vtimeout = AGENT_TIMEOUT_MS
    const salvageRes = await parallel(rankedClaims.slice(0, salvageCount).map(c => () => voteClaim(c, vtimeout)))
    voted.push(...salvageRes.filter(Boolean))
    break
  } else {
    const gate = budgetGate('Verify')
    if (!gate.ok) { log('BUDGET-BREAK Verify 余批跳过，用已完成批次结果'); break }
    stageVerifyRan = true  // 首批正常启动：await 前置 one-time 状态（预算账本已钉在「已运行」）
  }
  const vtimeout = AGENT_TIMEOUT_MS
  const batchRes = await parallel(batch.map(c => () => voteClaim(c, vtimeout)))
  voted.push(...batchRes.filter(Boolean))
}

const confirmedVerify = voted.filter(c => c.survives && claimWindow(c) !== 'out')
// ─── 8/23 第二十一项：双轨聚类主视图（verify→report 之间）───
// clustered = clusterClaims(confirmedVerify)：只聚类、不放行。多条目簇经 mergeCluster 合并成单一
// 编排同构主视图塞进 reportBody 的「已聚类」区（打标 [cluster 已合并 N 条]，精准供 report prompt 4.7 识别）；
// 被合并项仍保留在 confirmed 原样（report 收到"主视图 + 多视角原样"，同一事件只写 ONE 条、不同口径并陈）。
// 不传 clustered 给 ctxP——report prompt 输入契约（reportBody/refutedList/unverifiedList/missBlock/coverBlock）不变。
const clustered = clusterClaims(confirmedVerify)
const clusteredMerged = clustered.filter(cl => cl.items.length > 1).map(cl => mergeCluster(cl.items, DATE, null))
const clusteredBlock = clusteredMerged.length
  ? '## 已聚类（cluster 合并 ' + clusteredMerged.reduce((n, c) => n + c.mergedCount, 0) + ' 条→主视图）\n' + clusteredMerged.map((c, i) =>
      '\n[已聚类·' + (i + 1) + '] [cluster 已合并 ' + c.mergedCount + ' 条] ' + c.claim.split('\n').join(' / ') + '\n' +
      (c.summary ? '主视图摘要：' + c.summary + '\n' : '') +
      (c.sources && c.sources.length ? '来源：' + c.sources.join('、') : '')
    ).join('\n')
  : ''
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
const REPORT_DAY = normalizeDate(DATE)
const MAX_SEED_AGE_DAYS = 21
const _seedResult = filterSeedsByAge(KNOWN_MAJOR_OUT, REPORT_DAY, MAX_SEED_AGE_DAYS)
const freshSeeds = _seedResult.kept
for (const m of freshSeeds) _addMajor(m, 'labs')
if (REPORT_DAY == null) {
  log('SEED-AGE: 注入 ' + freshSeeds.length + ' / ' + KNOWN_MAJOR_OUT.length + ' 种子 · REPORT_DAY unknown → fail-open 全注入')
} else {
  const retired = _seedResult.retired
  const expired = retired.filter(r => r.reason === 'expired')
  const unparseable = retired.filter(r => r.reason === 'unparseable')
  let msg = 'SEED-AGE: 注入 ' + freshSeeds.length + ' / ' + KNOWN_MAJOR_OUT.length + ' 种子（' + retired.length + ' 退役'
  if (expired.length) msg += '，超期 ' + expired.length + '：' + expired.map(r => r.seed.name + ' ' + r.age + 'd').join('; ')
  if (unparseable.length) msg += '，日期不可解析 ' + unparseable.length + '：' + unparseable.map(r => r.seed.name + ' (' + JSON.stringify(r.raw) + ')').join('; ')
  msg += '，阈值 ' + MAX_SEED_AGE_DAYS + 'd）'
  log(msg)
}
confirmed.push(...majorOutClaims)
log('majorOut: ' + majorOutClaims.length + ' industry milestones injected into confirmed')

// ─── Coverage self-check (deterministic) ───
const boardClaimCount = new Map()
for (const s of sources) { s.claims.forEach(c => boardClaimCount.set(c.board, (boardClaimCount.get(c.board) || 0) + 1)) }
// labs 板块的公司三态由发现代理回报的 noNews 派生（其余公司视为"有动态或已达"）。
const noNewsSet = new Set()
for (const d of discoverRows) (d.noNews || []).forEach(k => noNewsSet.add(k))
// 分组发现失败判据（8/22 修复）：一个板只要「任一归属组失败（无返回）或返回的组自报 degraded」即 marked DE。
// 由 boards.mjs 的 computeBoardStates 统一计算——策略/融资/政策/安全/人 同属 media-en/media-cn 覆盖，同一失败组
// 不再只把独占板标红（safety/people），而是全部标记，避免"同组共享板静默 0 claims"（8/21 bug）。
const boardStates = computeBoardStates(discoverRows, boards.map(b => b.key), recoveredBoards)
const missingBoardKeys = [...boardStates].filter(([, s]) => s.missing).map(([k]) => k)
const coverage = boards.map(b => {
  const st = boardStates.get(b.key) || { degraded: false, missing: false }
  return {
    board: b.key, title: b.title,
    claims: boardClaimCount.get(b.key) || 0,
    urls: sources.filter(s => s.board === b.key).length,
    // 公司三态：板被按组标 fail（missing 且通常无 discover）→ 全 unreached；否则按 noNews 派生。
    // 兜底救回的板（recovered）不标 missing → 不全 unreached，按 noNews 派生（与有返回一致）。
    companiesChecked: b.companies ? b.companies.map(c => st.missing
      ? { name: c.name, state: 'unreached', evidence: 'no_discover_agent' }
      : { name: c.name, state: noNewsSet.has(c.name) ? 'no_news' : 'has_dynamic', evidence: 'labs' }) : null,
    degraded: st.degraded,   // 板级降级（任一组失败 或 有返回但自报降级 → 通道降级保留）
    recovered: !!st.recovered,  // 兜底救回（disc 失败但 harvest entries 补进）— 供覆盖自检/降级溯源
  }
})

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

// ─── Synthesize（report 是一次性昂贵代理；入口与总墙钟脱钩）───
phase('Synthesize')
// 8/17 原意：report 前先判总墙钟 + 探针，超限即降级防挂起。
// 8/30：探针从「否决权」降为「只观察」（8/29 单发 20s 探针超时曾把 9 条已确认内容整块降 raw）。
// 9/01 方案 D：入口也不再看 TOTAL_LIMIT_MS。前置切片和 = 总盘子，病态跑（8/31 Harvest 70min +
// Discover 129min）标定后会正确把旧 synthAllowed 打成 false——合成永远没份。治本：进入本阶段即
// 无条件尝试 report，只受 SYNTHESIS_LIMIT_MS（默认 600s）× reportTries 约束；探针无条件 advisory。
await probeGateway('report')  // advisory：探针失败仅留日志，不否决合成
const reportBody = (confirmed.length ? confirmed.map((c, i) =>
  // 8/17 第十二项：quote 截断 140 字降 report 输入体积——合成只需要点，引语全文由核查阶段保证；大幅压单请求 payload（挂起敏感度 + token）。
  '### ' + (c.isMajorOut ? '[窗口外·重大] ' : '') + '[' + i + '] ' + c.claim + '\nVote: ' + (c.isMajorOut ? '—（未投票，多源公认行业里程碑）' : (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount) + ' · Source: ' + c.sourceUrl + ' (' + c.sourceQuality + ') · Date: ' + (c.publishDate || c.date || '?') + '\nQuote: "' + c.quote.slice(0, 140) + (c.quote.length > 140 ? '…' : '') + '"\n')
  .join('\n')
  : '(无已确认声明)')
// 8/23 第二十一项：聚类主视图并列注入 reportBody 开头的「## 已聚类」区（report prompt 4.7 专门读取）——
// 仅当确认声明确有跨条可并簇项时出现；被合并 item 仍保留在 confirmed 原样（本块只做主视图提示，不删数据）。
// 8/23 分支合并复核修复：外层只拼「原始素材」分节头（由 reportPrompt/prompts.mjs 唯一提供），此处不再重复注入——
// clusteredBlock 自带「已聚类」头，拼接只接 \n\n 与 reportBody，避免 report 代理收到两个同名 H2。
const reportBodyWithCluster = clusteredBlock ? clusteredBlock + '\n\n' + reportBody : reportBody
const refutedList = killed.map(c => '- "' + c.claim + '" — ' + c.sourceUrl)
const unverifiedList = unverified.map(c => '- "' + c.claim + '" — ' + c.sourceUrl)
const coverBlock = coverage.map(c => '- ' + c.title + ': ' + c.claims + ' claims / ' + c.urls + ' sources' + (c.recovered ? ' [recovered]' : (c.degraded ? ' [degraded]' : '')) + (c.companiesChecked
  ? ' ; 公司覆盖(' + c.companiesChecked.length + '家): 有动态[' + c.companiesChecked.filter(x => x.state === 'has_dynamic').map(x => x.name).join('、') + '] 未发现动态[' + c.companiesChecked.filter(x => x.state === 'no_dynamic').map(x => x.name).join('、') + ']' + (c.companiesChecked.some(x => x.state === 'unreached') ? ' 未达[' + c.companiesChecked.filter(x => x.state === 'unreached').map(x => x.name).join('、') + ']' : '')
  : '')).join('\n')
const missLines = windowMisses.map(w => '- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note).join('\n')
const missBlock = windowMisses.length ? '\n## 窗口外参考（次要超窗项，须单列一节如实标注，不得混入正文）\n' + missLines : ''

// 8/27 修复 report_failed：confirmedVerify 全空 + tries=1 时 v4-flash 易 end_turn 无 StructuredOutput → null。
// 改为强化 prompt 收口（看 prompts.test）：report 代理必须调 StructuredOutput 工具才成功。
// 8/30 再次收紧：只要当日存在提取的任何 claim（能看到可写内容）就给 tries=2——一次 end_turn/网络抖动
// 不能把整份 report 打成 raw archive（8/29 实证：9 条已确认内容因 report 未跑完而全量降级）。
// 唯一的单次直出=当日全空（allClaims.length === 0），此时 nothing 可写，一次即可。
const reportTries = allClaims.length === 0 ? 1 : 2
const reportLadder = reportTries === 1 ? [MODEL_LADDER[0]] : MODEL_LADDER
const report = await safeAgentWithLadder(reportPrompt({
  ...ctxP, confirmedVerifyCount: confirmedVerify.length, majorOutCount: majorOutClaims.length,
  reportBody: reportBodyWithCluster, killedCount: killed.length, refutedList, unverifiedCount: unverified.length, unverifiedList, missBlock, coverBlock,
}), { label: 'report', phase: 'Synthesize', schema: REPORT_SCHEMA, timeoutMs: SYNTHESIS_LIMIT_MS }, reportLadder, LADDER_BUDGET_MS)
if (report) {
  BREAKER.record(true, 'report')
} else {
  BREAKER.record(false, 'report')
  log('REPORT-FAIL 模型阶梯全废，降级 raw archive')
}

// ─── md 确定性渲染（report 成功 → 完整版；失败 → 降级版）。render-md.mjs，不再有 mdWriter 代理。───
// report 成功 → md 必然成功（纯字符串拼接），md 产出不再受网关波动影响。
const degradedFlags = []
if (toolError > 0) degradedFlags.push('verify_agent_errors:' + toolError)
if (budgetDropped.length > 0) degradedFlags.push('fetch_budget_dropped:' + budgetDropped.length)
if (missingBoardKeys.length > 0) degradedFlags.push('discovery_degraded:missing_' + missingBoardKeys.join('+'))
else if (discoverRows.some(d => d.degraded)) degradedFlags.push('discovery_degraded')
if (recoveredBoards.size > 0) degradedFlags.push('discovery_recovered:' + [...recoveredBoards].join('+'))
if (budgetSkipped.length > 0) degradedFlags.push('budget_skipped:' + budgetSkipped.join('+'))
// 8/31 P1：断路器跳闸与墙钟饥饿都必须在产物里**可见**——8/31 那种 run 的病症（代理成批失败、
// 事件循环饱和让墙钟低估 4.7–7.6×）在 meta/md 里完全无痕，只能靠翻 4h 的 workflow 日志才发现。
if (BREAKER.open()) degradedFlags.push('breaker_open:' + BREAKER.reason())
if (WALL.observations > 0 && WALL.peakFactor > 1.5) degradedFlags.push('wallclock_starved:' + WALL.peakFactor.toFixed(1) + 'x')
// 8/23 第二十一项：linuxdo 组失败/降级 → linuxdo_degraded 独立降级旗标（no_cdp_host 跳过不算降级）。
const linuxdoFailedRows = discoverRows.filter(d => d.linuxdoFailed)
if (linuxdoFailedRows.length) degradedFlags.push('linuxdo_degraded' + (linuxdoFailedRows.some(d => d.linuxdoReason) ? ':' + linuxdoFailedRows.map(d => d.linuxdoReason).join('+').slice(0, 80) : ''))
if (ladderUsed.length > 0) degradedFlags.push('ladder_used:' + ladderUsed.join('+'))
if (ladderExhaustedStages.size) degradedFlags.push('ladder_exhausted:' + [...ladderExhaustedStages].join('+'))
// 9/01 方案 D：合成入口与总墙钟脱钩后，reportErr 只剩「代理真失败」一条路径
// （墙钟跳过路径删除——进入 Synthesize 即尝试 report）。
const reportErr = report ? null : 'report agent failed; reverting to raw archive'
if (reportErr) degradedFlags.push('report_failed')
// 归档 payload 数组（claimsJson 与降级 md 共用同一份同构数据，避免两处映射漂移）。
const confirmedOut = confirmed.map(c => ({ claim: c.claim, quote: c.quote, source: c.sourceUrl, sourceQuality: c.sourceQuality, date: c.publishDate || c.date, window: c.isMajorOut ? 'major-out' : claimWindow(c), vote: c.isMajorOut ? '—' : (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount, verifiedByVote: !c.isMajorOut, erroredCount: c.erroredCount || 0, confidence: (c.verdicts.filter(v => !v.refuted)[0] || {}).confidence || (c.isMajorOut ? 'high' : 'low') }))
const refutedOut = killed.map(c => ({ claim: c.claim, source: c.sourceUrl, vote: (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount, erroredCount: c.erroredCount || 0 }))
const unverifiedOut = unverified.map(c => ({ claim: c.claim, source: c.sourceUrl }))
const outOfWindowOut = outOfWindow.map(c => ({ claim: c.claim, source: c.sourceUrl, date: c.publishDate || c.date, vote: (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount, erroredCount: c.erroredCount || 0 }))
const md = report
  ? renderMarkdown({ date: DATE, window: WINDOW_LABEL, report, coverage, windowMisses, degraded: degradedFlags, meta: {
      date: DATE, window: WINDOW_LABEL,
      stats: { confirmed: confirmed.length, major_out: majorOutClaims.length, killed: killed.length, urls_fetched: sources.length, urls_discovered: discoverRows.reduce((n, d) => n + d.urls.length, 0) },
      generated_by: 'ai-daily (' + MODEL_LADDER[0] + ')',
    } })
  : renderDegradedMarkdown({ date: DATE, window: WINDOW_LABEL, confirmed: confirmedOut, refuted: refutedOut, coverage, windowMisses, degraded: degradedFlags, noNewsCompanies: noDynamicCompanies, reportError: reportErr })

const claimsJson = JSON.stringify({ date: DATE, window: WINDOW_LABEL, confirmed: confirmedOut, refuted: refutedOut, unverified: unverifiedOut, outOfWindow: outOfWindowOut }, null, 1)
// JSON 归档不再走 writer 代理（base64 转录会被 LLM 损坏，曾导致 control-char 非法 JSON + 每失败代理烧 260KB）。
// 改为：workflow 把 payload 原样返回 → 主会话用 Write 逐字节落盘（见下方 payloads 字段）。
const claimsPath = OUT + '/' + DATE + '.verified-claims.json'
const sourcesPath = OUT + '/' + DATE + '.sources.json'
const sourcesJson = JSON.stringify({ date: DATE, sources: sources.map(s => ({ url: s.url, title: s.title, board: s.board, found_via: s.found_via, sourceQuality: s.sourceQuality, publishDate: s.publishDate || s.date, claimCount: s.claims.length, confirmed: confirmed.filter(c => c.sourceUrl === s.url).length })) }, null, 1)
const artifacts = [claimsPath, sourcesPath]  // md 由 orchestrator 从 payloads.md 落盘，artifact 清单列 JSON（3 个见下）

const metaJson = JSON.stringify({
  date: DATE, window: { from: WFROM, to: WTO || DATE }, generated_by: 'ai-daily (' + MODEL_LADDER[0] + ')',
  boards: boards.length, urls_discovered: discoverRows.reduce((n, d) => n + d.urls.length, 0), urls_fetched: sources.length, claims_extracted: allClaims.length,
  claims_verified: voted.length, confirmed: confirmed.length, major_out: majorOutClaims.length, killed: killed.length, unverified: unverified.length, out_of_window_confirmed: outOfWindow.length,
  window_misses: windowMisses,
  url_dupes: dupes.length, fetches_dropped: budgetDropped.length, verify_agent_errors: toolError,
  // 8/27 Task 2 (dropped 明细可审计)：fetch_budget_dropped 只给总数，不够归因。
  // dropped_detail 给出"丢的到底是谁"的逐类账：linuxdo_cdp（预抓的帖/URL 被预算丢）、
  // static_fallback（静态兜底被丢）、其它（普通 discover 候选被丢）。
  dropped_detail: {
    linuxdo_cdp: linuxdoDropped,
    static_fallback: staticDropped,
    other: otherDropped,
  },
  // 8/23 第二十一项：linuxdo 抓取统计——linuxdo_posts = 抓到的帖子总数，linuxdo_open_posts = 按配额
  // 进 boardURLMap 的 URL 候选数（成功时补入）；linuxdo_degraded 是独立降级旗标（见 degradedFlags）。
  linuxdo_posts: discoverRows.filter(d => d.linuxdoTopics).reduce((n, d) => n + (d.linuxdoPosts || 0), 0),
  linuxdo_open_posts: discoverRows.filter(d => d.linuxdoTopics).reduce((n, d) => n + d.urls.length, 0),
  degraded: degradedFlags, report_error: reportErr,
  // 8/31 P1：墙钟标定与断路器的账。realm 唯一时钟是 tick 累加器，饱和下只低估——
  // wallclock_raw_s（累加器原始读数）与 wallclock_calibrated_s（标定后下界）之差即被吞掉的时间，
  // 配合宿主侧 run-daily.sh 的真实 epoch（P1-②）三方对账，才能判断闸门是真放行还是被骗放行。
  wallclock: {
    raw_s: Math.round(RUN_ELAPSED_RAW() / 1000),
    calibrated_s: Math.round(RUN_ELAPSED() / 1000),
    starvation_factor: Number(WALL.factor.toFixed(2)),
    peak_factor: Number(WALL.peakFactor.toFixed(2)),
    observations: WALL.observations,
  },
  breaker: { open: BREAKER.open(), reason: BREAKER.reason(), ...BREAKER.stats },
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