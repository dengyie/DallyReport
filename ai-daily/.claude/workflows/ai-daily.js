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
// ─── inline: url-polyfill ───
// workflow realm 缺失 URL 全局的最小 WHATWG URL polyfill（2026-08-22 实证根因）。
// Workflow 脚本 realm 无 URL（typeof URL==='undefined'），dedup._hostnameOf / render-md.buildCitationMap /
// render-md.citationBadges 的 `new URL(s)` 抛 ReferenceError 被 catch{continue/null} 静默吞：
//  → buildCitationMap 空 → 完整版 0 [n] 角标、0 参考来源节、全项 [行业公认·无单一链接] 兜底（8/22 两次 run 实证）。
// 本 polyfill 须在任何 inline 模块前注入（build MODULES 顺序：url-polyfill 第一）。
// 仅覆盖 pipeline 实际用到的 .href / .hostname / protocol；非 URL 输入抛 TypeError（保留各处 catch 语义）。
// 幂等：已存在全局 URL（node:test 直跑、或已注入）时不覆盖，保证宿主 URL 优先。
// href 返回构造时原输入字符串（规范 URL 已归一），保证 buildCitationMap 建图与 citationBadges 查图
// 用同一 polyfill、同一 key（map.get 命中）。

const installUrlPolyfill = () => {
  if (typeof globalThis === 'undefined') return false
  if (typeof globalThis.URL !== 'undefined') return false
  const MinURL = class URL {
    constructor(input) {
      const s = String(input)
      const m = s.match(/^(https?):\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i)
      if (!m) throw new TypeError('invalid url: ' + s)
      this._href = s
      this.protocol = m[1].toLowerCase() + ':'
      this.hostname = m[2].toLowerCase()
      this.pathname = m[3] || '/'
    }
    get href() { return this._href }
  }
  globalThis.URL = MinURL
  return true
}

// 模块加载即注入（workflow realm inline 后于顶部执行；node:test 已有全局 URL 则跳过）。
installUrlPolyfill()
// ─── inline: date-utils ───
// ai-daily 日期/URL/数组纯函数 — 与 workflow 内逐字节一致（claimWindow 改工厂注入，唯一签名变化）。

const URL_HOST_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\\]*@)?(?:www\.)?([^/:?#@\\]+)(?::\d+)?([^?#]*)/i
const normURL = u => { const m = String(u).match(URL_HOST_PATTERN); return m ? (m[1] + m[2].replace(/\/$/, '')).toLowerCase() : String(u).toLowerCase() }
const hostOf = u => (String(u || '').match(URL_HOST_PATTERN)?.[1] || 'unknown').toLowerCase()

const pad2 = n => String(n).padStart(2, '0')
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const normalizeDate = s => {
  if (!s) return null
  const str = String(s).trim()
  let m
  if ((m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return +(m[1] + pad2(+m[2]) + pad2(+m[3]))
  if ((m = str.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/))) return +(m[1] + pad2(+m[2]) + pad2(+m[3]))
  if ((m = str.match(/^(\d{4})(\d{2})(\d{2})/))) return +m[0]
  if ((m = str.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/))) return +(m[3] + pad2(+m[1]) + pad2(+m[2]))
  const mm = MONTHS[str.slice(0, 3).toLowerCase()]
  if (mm) {
    if ((m = str.match(/(\d{1,2}),?\s*(\d{4})/))) return +(m[2] + pad2(mm) + pad2(+m[1]))
    if ((m = str.match(/(\d{4}),?\s+(\d{1,2})/))) return +(m[1] + pad2(mm) + pad2(+m[2]))
  }
  return null
}

// 工厂化：现行 claimWindow 闭包依赖全局 WIN_FROM/WIN_TO，模块化后显式注入。返回的函数语义逐字不变。
const makeClaimWindow = (WIN_FROM, WIN_TO) => c => {
  const cands = [c.publishDate, c.date].map(normalizeDate).filter(x => x != null)
  if (!cands.length) return 'unknown'
  return cands.every(x => x >= WIN_FROM && x <= WIN_TO) ? 'in' : 'out'
}

// 日历天数差（reportDay − seedDay；正=seed 早于 report）。YYYYMMDD 数值→天数。
// 纯算术、无 Date.now()/new Date()——Workflow realm 安全（realm 禁 Date）。
const daysBetween = (seedDayNum, reportDayNum) => {
  const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const dom = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  const dayNum = (y, m, d) => { let n = 0; for (let Y = 1970; Y < y; Y++) n += isLeap(Y) ? 366 : 365; for (let M = 1; M < m; M++) n += dom(y, M); return n + d }
  const p = n => ({ y: Math.floor(n / 10000), m: Math.floor(n / 100) % 100, d: n % 100 })
  const a = p(seedDayNum), b = p(reportDayNum)
  return dayNum(b.y, b.m, b.d) - dayNum(a.y, a.m, a.d)
}

// age gate：种子距 report 超 maxAgeDays，或日期不可解析（normalizeDate→null）→ 剔除。
// fail-open：reportDateNum == null（未知）返回原数组，不因 gate 清空 major-out 节。
// 8/24 修复：区分「日期不可解析」与「超期」两种 retire 原因——retireReasons 数组供调用方分别日志。
const filterSeedsByAge = (seeds, reportDayNum, maxAgeDays) => {
  if (reportDayNum == null) return { kept: seeds, retired: [] }
  const kept = [], retired = []
  for (const s of seeds) {
    const day = normalizeDate(s.date)
    if (day == null) { retired.push({ seed: s, reason: 'unparseable', raw: s.date }); continue }
    const age = daysBetween(day, reportDayNum)
    if (age > maxAgeDays) { retired.push({ seed: s, reason: 'expired', age, max: maxAgeDays }); continue }
    kept.push(s)
  }
  return { kept, retired }
}

const chunkArr = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
// ─── inline: schemas ───
// ai-daily schemas — 与 workflow 内逐字节一致（WRITE_RESULT_SCHEMA 已随 mdWriter 代理删除）。
// 真源；build.mjs 剥 export inline 进 workflow。

const DISCOVER_SCHEMA = {
  type: 'object', required: ['urls', 'noNews'],
  properties: {
    // urlsMax 放宽到 10 供合组媒体代理使用（单板代理由 prompt 限 6）；board 为媒体组必填的归属板块。
    urls: { type: 'array', maxItems: 10, items: {
      type: 'object', required: ['url', 'title', 'found_via', 'date'],
      properties: { url: { type: 'string' }, title: { type: 'string' }, found_via: { type: 'string' }, date: { type: 'string' }, board: { type: 'string' } },
    }},
    noNews: { type: 'array', items: { type: 'string' } },
    nearWindow: { type: 'array', items: { type: 'object', required: ['name', 'note'], properties: { name: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' } } } },
    // majorOutOfWindow url 可选（2026-08-22 B.2）：有官方/一手可溯源页才带，无则不带（降级 C 兜底标 [行业公认·无单一链接]）。
    majorOutOfWindow: { type: 'array', items: { type: 'object', required: ['name', 'date', 'note'], properties: { name: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' }, url: { type: 'string' } } } },
    degraded: { type: 'boolean' },
  },
}
// 批量 Harvest schema：一个代理可覆盖多 feed，每条条目带 feed 字段（来源 Feed URL，原样回填）供归栈。
const HARVEST_SCHEMA = {
  type: 'object', required: ['entries', 'recent'],
  properties: {
    entries: { type: 'array', maxItems: 100, items: {
      type: 'object', required: ['date', 'title', 'url'],
      properties: { date: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, feed: { type: 'string' } },
    }},
    recent: { type: 'array', maxItems: 30, items: {
      type: 'object', required: ['date', 'title', 'url', 'note'],
      properties: { date: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, note: { type: 'string' }, feed: { type: 'string' } },
    }},
    failed: { type: 'boolean' },
  },
}
const EXTRACT_SCHEMA = {
  type: 'object', required: ['claims', 'sourceQuality'],
  properties: {
    sourceQuality: { enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
    publishDate: { type: 'string' },
    claims: { type: 'array', maxItems: 3, items: {
      type: 'object', required: ['claim', 'quote', 'importance'],
      properties: { claim: { type: 'string' }, quote: { type: 'string' }, importance: { enum: ['central', 'supporting', 'tangential'] } },
    }},
  },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['refuted', 'evidence', 'confidence'],
  properties: {
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    confidence: { enum: ['high', 'medium', 'low'] },
  },
}
const REPORT_SCHEMA = {
  type: 'object', required: ['oneLiner', 'execSummary', 'sections', 'caveats', 'openQuestions'],
  properties: {
    oneLiner: { type: 'string' },
    execSummary: { type: 'string' },
    sections: { type: 'array', items: {
      type: 'object', required: ['board', 'title', 'items'],
      properties: {
        board: { type: 'string' }, title: { type: 'string' },
        items: { type: 'array', items: {
          type: 'object', required: ['title', 'summary', 'confidence', 'sources'],
          properties: {
            title: { type: 'string' }, summary: { type: 'string' }, confidence: { enum: ['high', 'medium', 'low'] },
            // 2026-08-22 C.3 收口：status 枚举字面量（render 依赖精确值判定；容错在 render 侧做，源头仍须规范）。
            status: { enum: ['已核查 2-0', '已核查 2-1', '[窗口外·重大]', '未核查', '已否决'] },
            sources: { type: 'array', items: { type: 'string' } }, vote: { type: 'string' },
          },
        }},
      },
    }},
    caveats: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}
// ─── inline: boards ───
// ai-daily 花名册与静态配置 — 与 workflow 内逐字节一致。真源；加厂商/改种子只改此文件。

// ─── Deterministic coverage: 10 boards × roster ───
const BOARDS = [
  { key: 'labs', title: '头部实验室·新模型', focus: '旗舰实验室本周新模型、新版本、重大模型能力发布（必须逐家核）', degradeNotes: 'X/Grok、OpenAI 等官方 X 通道优先；WebSearch 不可用时以官方渠道覆盖为主。',
    companies: [
      { name: 'OpenAI',        x: 'OpenAI' },
      { name: 'Google DeepMind', x: 'GoogleDeepMind', feed: 'https://research.google/blog/rss/' },
      { name: 'Anthropic',     x: 'AnthropicAI',      feed: 'https://www.anthropic.com/news' },
      { name: 'xAI',           x: 'xai',              feed: 'https://x.ai/news' },
      { name: 'NVIDIA',        x: 'NVIDIA_AI',        feed: 'https://blogs.nvidia.com/feed/' },
      { name: 'Meta AI',       x: 'AIatMeta',         feed: 'https://ai.meta.com/blog/' },
      { name: 'Amazon AWS',    x: 'AWSNewsBlog' },
      { name: 'Apple',         x: 'Apple' },
      { name: 'Microsoft',     x: 'MSFTResearch' },
      { name: 'Mistral',       x: 'MistralAI' },
      { name: 'Cohere',        x: 'CohereAI' },
      { name: 'DeepSeek',      x: 'deepseek_ai' },
      { name: 'Alibaba Qwen',  x: 'Alibaba_Qwen' },
      { name: 'Moonshot Kimi', x: 'MoonshotAI' },
      { name: 'MiniMax',       x: 'MiniMax_AI' },
      { name: 'Baidu',         x: 'BaiduResearch' },
      { name: 'Tencent',       x: 'Tencent_AI_Lab' },
      { name: 'ByteDance',     x: 'ByteDance' },
      { name: 'Zhipu GLM',     x: 'zhipu_ai' },
      { name: 'StepFun',       x: 'StepFun' },
      { name: 'Kuaishou',      x: 'Kuaishou' },
      { name: 'Midjourney',    x: 'midjourney' },
      { name: 'Stability AI',  x: 'StabilityAI' },
    ] },
  { key: 'strategy', title: '重磅头条·战略', focus: '重大战略/资本/基础设施新闻：大额融资平台、星际之门类项目、并购、行业地位变动', feeds: ['https://www.qbitai.com/', 'https://techcrunch.com/category/artificial-intelligence/'] },
  { key: 'products', title: '产品与硬件', focus: '消费级 AI 产品、AI 硬件、设备发布、机器人、新品落地', feeds: ['https://techcrunch.com/category/artificial-intelligence/', 'https://www.theverge.com/ai-artificial-intelligence/', 'https://www.qbitai.com/'] },
  { key: 'opensource', title: '开源与工具链', focus: '开源权重发布、HF 趋势、GitHub 趋势、Agent 框架与工具', feeds: ['https://huggingface.co/blog/feed.xml', 'https://huggingface.co/papers'], xHandles: ['huggingface', 'OpenSourceModels'] },
  { key: 'academic', title: '学术研究', focus: 'arXiv 新提交、HF Daily Papers 论文、研究突破', feeds: ['https://export.arxiv.org/api/query?search_query=%28cat%3Acs.AI+OR+cat%3Acs.CL%29+AND+submittedDate%3A%5B{{WFROM}}0000+TO+{{WTO}}2359%5D&start=0&max_results=50', 'https://huggingface.co/papers'] },
  { key: 'funding', title: '融资并购', focus: '融资轮次、估值、并购、投资动态', feeds: ['https://techcrunch.com/category/artificial-intelligence/', 'https://36kr.com/', 'https://www.qbitai.com/'] },
  { key: 'policy', title: '政策监管', focus: '政府/监管/法院/标准组织对 AI 的动作', feeds: ['https://techcrunch.com/category/artificial-intelligence/', 'https://www.qbitai.com/'] },
  { key: 'safety', title: '安全与伦理', focus: '对齐、安全、滥用、水印、系统卡、攻击事件', feeds: ['https://www.qbitai.com/', 'https://techcrunch.com/category/artificial-intelligence/'] },
  { key: 'people', title: '人才流动', focus: '重要人物离职/跳槽/创业/任命', feeds: ['https://www.qbitai.com/', 'https://techcrunch.com/category/artificial-intelligence/'] },
  // 8/23 第二十一项：linuxdo 前沿快讯板（登录态 CDP 独立发现组产物落此板，urls 进 Fetch/Verify 既有流水线）
  { key: 'linuxdo', title: 'linux.do 前沿快讯', focus: 'linux.do 论坛前沿快讯（登录态，同窗最新 AI 帖子）', feeds: ['https://linux.do/c/news/34'] },
]

const OFFICIAL_FEEDS = [
  { url: 'https://openai.com/news/rss.xml', label: 'OpenAI News' },
  { url: 'https://www.anthropic.com/news', label: 'Anthropic News' },
  { url: 'https://x.ai/news', label: 'xAI News' },
  { url: 'https://research.google/blog/rss/', label: 'Google Research Blog' },
  { url: 'https://blogs.nvidia.com/feed/', label: 'NVIDIA Blog' },
  { url: 'https://ai.meta.com/blog/', label: 'Meta AI Blog' },
]

// 种子“重大超窗事实”（行业里程碑级公认事件，即使不在窗口也应出现在正文，标注 [窗口外·重大]）：
// 发现代理通过 majorOutOfWindow 字段上报更多此类事实。
// 种子 url 全量强制（2026-09-01 P5）：每项必须带官方一手页可溯源；纯媒体口径不收录。
// Astra 为媒体口径预告 + 已超 21d 门禁，2026-09-01 退役。
// 命名约束（P5 实测锁定）：DeepSeek 系新名必须用连字符（DeepSeek-V4-Flash-Vision-Exp）——
// 空格形式会命中既有 deepseek-v4 指纹 key 被 makeAddMajor 静默去重（dedup.mjs majorKey 实测 09-01）。
const KNOWN_MAJOR_OUT = [
  { name: 'DeepSeek V4-Pro 正式版上线（Agent 能力增强）', date: '2026-08-13', note: 'DeepSeek 官方 news 页登记 DeepSeek-V4-Pro 正式版上线 2026/08/13，App/网页/API 全面开放，强化 Agent 能力并引入分时段峰值定价；网易 08-16 报道印证 2026-08-17 价格生效（双源）。', url: 'https://api-docs.deepseek.com/news/' },
  { name: 'DeepSeek-V4-Flash-Vision-Exp 多模态实验模型上线', date: '2026-08-21', note: 'DeepSeek 官方 news 页 2026/08/21 登记 V4-Flash-Vision-Exp 多模态实验模型：文本侧对齐 V4-Flash（Agent/推理/代码），多模态 Agent 基准较主流模型跃升、逼近前沿旗舰；图片 token 化 ≤384 且按 V4-Flash 定价计费；同日 API 支持 Chat/Messages/Responses，Files API 与 DeepSeek Harness 0.1.1 同步支持。（官方一手页溯源）', url: 'https://api-docs.deepseek.com/news/news260821' },
  { name: 'Anthropic 发布 Model Hardware Standard 研究预览（Agent 操纵物理设备）', date: '2026-08-27', note: 'Anthropic 官方 news 页 2026/08/27 发布 Model Hardware Standard 研究预览：为 Agent 安全并行操作显微仪器/液态处理器/机械臂定义共享规范；Anthropic 与 HHMI Janelia 合作、集成耗时从周/月压缩到小时级，研究发布。（官方一手页溯源）', url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview' },
  { name: 'Anthropic 扩大科学家支持（1 万免费席位 + 5× 高级计划）', date: '2026-08-27', note: 'Anthropic 官方 news 页 2026/08/27 公布科学家支持扩展：科研界 1 万免费 Claude 席位 + 5× 额度高级计划（$15/月）、AI for Science 从生物学扩展出更广学科。（官方一手页溯源）', url: 'https://www.anthropic.com/news/expanding-support-for-scientists' },
]

// labs 花名册跨板块校正别名表：发现代理可能过报 no_news，已确认声明/来源标题命中别名即翻转 has_dynamic。
const LABS_ALIASES = [
  ['OpenAI', ['OpenAI']], ['Google DeepMind', ['Google', 'DeepMind']], ['Anthropic', ['Anthropic', 'Claude']],
  ['xAI', ['xAI', 'Grok']], ['NVIDIA', ['NVIDIA', '英伟达']], ['Meta AI', ['Meta', 'Facebook']],
  ['Amazon AWS', ['AWS', 'Amazon Web Services']], ['Apple', ['Apple']], ['Microsoft', ['Microsoft', '微软']],
  ['Mistral', ['Mistral']], ['Cohere', ['Cohere']], ['DeepSeek', ['DeepSeek', '深度求索']],
  ['Alibaba Qwen', ['Qwen', '通义']], ['Moonshot Kimi', ['Kimi', '月之暗面']], ['MiniMax', ['MiniMax']],
  ['Baidu', ['Baidu', '百度']], ['Tencent', ['Tencent', '腾讯', '混元']], ['ByteDance', ['ByteDance', '字节', '豆包']],
  ['Zhipu GLM', ['GLM', '智谱']], ['StepFun', ['StepFun', '阶跃']], ['Kuaishou', ['Kuaishou', '快手']],
  ['Midjourney', ['Midjourney', 'MJ']], ['Stability AI', ['Stability', 'StabilityAI', 'Stable Diffusion']],
]

// 批量 Harvest 分组（8/15 第九项优化）：14 个独立 feed 并行代理 → 5 个分组代理。
const GROUPS_RAW = [
  { key: 'official', label: '官方实验室（OpenAI/Anthropic/xAI/Google/NVIDIA/Meta）', test: u => OFFICIAL_FEEDS.some(f => normURL(f.url) === normURL(u)) },
  { key: 'cn-media', label: '中文媒体（量子位/36氪）', test: u => /qbitai|36kr/i.test(u) },
  { key: 'en-media', label: '英文媒体（TechCrunch/The Verge）', test: u => /techcrunch|theverge/i.test(u) },
  { key: 'opensource', label: '开源/模型仓库（HuggingFace）', test: u => /huggingface/i.test(u) },
  { key: 'academic', label: '学术（arXiv）', test: u => /arxiv/i.test(u) },
]

// 分组发现（8/15 第九项优化）：labs / opensource / academic 单板专代理；6 个媒体/垂类板合并为
// media-cn 与 media-en 两组。
const DISCOVER_GROUPS_ALL = [
  { key: 'labs', label: '头部实验室', boards: ['labs'], xBudget: 5 },
  { key: 'opensource', label: '开源与工具链', boards: ['opensource'], xBudget: 3 },
  { key: 'academic', label: '学术研究', boards: ['academic'], xBudget: 3 },
  { key: 'media-cn', label: '中文媒体（量子位/36氪）', boards: ['strategy', 'funding', 'policy', 'safety', 'people'],
    feeds: ['https://www.qbitai.com/', 'https://36kr.com/'], xBudget: 4 },
  { key: 'media-en', label: '英文媒体（TechCrunch/The Verge/qbitai）', boards: ['strategy', 'products', 'funding', 'policy'],
    feeds: ['https://techcrunch.com/category/artificial-intelligence/', 'https://www.theverge.com/ai-artificial-intelligence/', 'https://www.qbitai.com/'], xBudget: 4 },
  // 8/23 第二十一项：linuxdo 接入——独立发现组，走 9222 登录态 Chrome 抓 news/34.json（Discover 阶段每页
  // 跑前调 fetchLinuxDoNews34）；产出 URL 进 Fetch/Verify 既有流水线，不改动对抗投票/状态机。组仅在
  // boardKeysSel 含 linuxdo 时激活；linuxdoCdpHost 为 null（默认）时组保留但 urls=[] 不降级（命令行/手动补跑
  // 默认不启用时板不崩）。boards 数组与 groupKeyByBoard 反向映射均运行时从本表派生，无需手改映射表。
  { key: 'linuxdo', label: 'linux.do 前沿快讯（登录态 CDP）', boards: ['linuxdo'], feeds: [], xBudget: 3,
    cdp: true, cdpPage: 'https://linux.do/c/news/34.json' },
]

// ─── 板级降级判定（按板归属组统一，8/22 修复）───
// 背景 bug（8/21 全量实测）：media-cn 组失败（disc:media-cn null → DISCOVER-FAIL）时，
//   只有 media-cn 独占的 safety/people 被判 failed（missing_*），而同样被 media-cn 覆盖、
//   但有 media-en 兜底的 strategy/funding/policy 既不被标 missing 也不被标 [degraded]——同一失败组共享板全静默。
// 修复：板 degraded = 任一归属组失败（无返回）或 返回的组自报 degraded；
//       板 missing   = 所有归属组全部无返回（无任何发现覆盖）。
//   media-cn 失败 → strategy/funding/policy/safety/people 全 degraded；missing 只留 safety/people。

// 板 → 归属组 key 集（从 DISCOVER_GROUPS_ALL 反向建立；单板组/独立组也是一组）
const groupKeyByBoard = new Map()
for (const g of DISCOVER_GROUPS_ALL) for (const b of g.boards) {
  if (!groupKeyByBoard.has(b)) groupKeyByBoard.set(b, new Set())
  groupKeyByBoard.get(b).add(g.key)
}

/**
 * 计算每个选中板的降级状态（纯函数，供覆盖自检/降级上报）。
 * @param {Array<{group:{key:string}, degraded?:boolean}>} rows 发现组返回行（safeAgent.then 产物；失败组无行）
 * @param {string[]} boardKeys 参与判定的板块 key 列表（通常 = boards.map(b=>b.key)，冒烟可子集）
 * @param {Iterable<string>} [recoveredKeys] 兜底救回的板（disc 失败但 harvest entries 已补进 boardURLMap，8/22 第二十项）
 * @returns {Map<string,{degraded:boolean, missing:boolean, recovered?:boolean}>}
 */
const computeBoardStates = (rows, boardKeys, recoveredKeys) => {
  const returnedGroups = new Set((rows || []).map(r => r?.group?.key).filter(Boolean))
  const degradedGroups = new Set((rows || []).filter(r => r?.degraded).map(r => r.group.key))
  const recoveredSet = recoveredKeys ? new Set(recoveredKeys) : new Set()
  const m = new Map()
  for (const key of boardKeys) {
    const groups = groupKeyByBoard.get(key) || new Set()
    const anyReturned = [...groups].some(g => returnedGroups.has(g))
    const anyFailedGroup = [...groups].some(g => !returnedGroups.has(g))
    const anyDegradedGroup = [...groups].some(g => degradedGroups.has(g))
    const inRecovery = recoveredSet.has(key)
    // recovered 仅当该板确属失败/降级路径（有失败组 或 返回组自降级）才标——成功板误传 recoveredKeys 不打标记。
    const recovered = inRecovery && (anyFailedGroup || anyDegradedGroup)
    // missing = 所有归属组全部失败 且 未被兜底救回（兜底补了 URL 即有覆盖，不再标 missing/unreached）。
    // degraded = 任一组失败 或 返回组自降级；兜底救回仍属「通道失败」→ 保留 degraded 供如实降级上报。
    const missing = groups.size > 0 && !anyReturned && !inRecovery
    const degraded = anyFailedGroup || anyDegradedGroup
    m.set(key, { degraded, missing, ...(recovered ? { recovered: true } : {}) })
  }
  return m
}

// normURL 在 date-utils.mjs；boards.mjs 的 GROUPS_RAW.test 闭包需要它，这里前向声明由 build.mjs 整时保证顺序。
// 直接 import 供 node 环境用；build.mjs inline 时剥掉 import 行（workflow 内 normURL 已在上文定义）。

// 静态兜底源（2026-08-26 新增）：discover 全失败 + harvest-fallback 仍空 → 注入精选一级/官方新闻页
// URL（板块首页/官方 news 索引，常驻可抓）。found_via 标 'static-fallback'。仅代理面通道挂掉时兜底。
// 约定：URL 常驻可靠更新、无登录墙、非 SEO/内容农场；索引页允许（fetch 后按窗口过滤）。
const STATIC_FALLBACK_SOURCES = [
  { board: 'labs',       url: 'https://www.anthropic.com/news',  title: 'Anthropic 官方 News' },
  { board: 'labs',       url: 'https://openai.com/news/',     title: 'OpenAI News' },
  { board: 'labs',       url: 'https://x.ai/news',           title: 'xAI News' },
  { board: 'labs',       url: 'https://blogs.nvidia.com/blog/', title: 'NVIDIA Blog' },
  { board: 'labs',       url: 'https://research.google/blog/', title: 'Google Research Blog' },
  { board: 'opensource', url: 'https://huggingface.co/blog', title: 'Hugging Face Blog' },
  { board: 'opensource', url: 'https://github.com/trending?since=daily', title: 'GitHub Trending' },
  { board: 'academic',   url: 'https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&start=0&max_results=20', title: 'arXiv cs.AI 最新' },
  { board: 'strategy',   url: 'https://techcrunch.com/category/artificial-intelligence/', title: 'TechCrunch AI' },
  { board: 'products',   url: 'https://www.theverge.com/ai-artificial-intelligence/', title: 'The Verge AI' },
  { board: 'funding',    url: 'https://techcrunch.com/category/artificial-intelligence/', title: 'TechCrunch AI（融资）' },
  { board: 'policy',     url: 'https://www.qbitai.com/', title: '量子位（政策）' },
  { board: 'safety',     url: 'https://www.qbitai.com/', title: '量子位（安全）' },
  { board: 'people',     url: 'https://www.qbitai.com/', title: '量子位（人才）' },
]
// ─── inline: dedup ───
// ai-daily 指纹去重 + 轮询公平分配 — 三个历史 bug 在此固化（测试锁定）。

// 同一事实的关键词指纹（取公司/产品名）：发现代理上报与 KNOWN 种子若指同一事件只保留一份。
// 顺序锁定：hassabis 必须在 jeff-dean 前（8/16 bug：含两人的条目被误并入 jeff-dean）。
const majorKey = name => {
  const t = String(name).toLowerCase()
  if (/v4\s*(pro|flash)|(?:deepseek|深度求索)\s*v4/.test(t)) return 'deepseek-v4'
  if (/harness/.test(t)) return 'deepseek-harness'
  if (/grok\s*4\.6|4\.6/.test(t) && /grok/.test(t)) return 'grok-4.6'
  if (/muse\s*glimmer/.test(t)) return 'muse-glimmer'
  if (/hassabis|哈萨比斯/.test(t)) return 'hassabis'
  if (/jeff\s*dean|杰夫/.test(t)) return 'jeff-dean'
  if (/gemini/.test(t)) return 'gemini'
  // 8/16 实测补漏：GPT-5.6 与 Fable 联手攻克悬置 25 年数学难题，两个发现组表述不同走不进兜底指纹 → 重复入稿。
  if (/gpt-?5\.6/.test(t) && /fable/.test(t) && /数学|math/.test(t)) return 'gpt5.6-math'
  // 兜底：剥离括号限定词后按实体指纹合并
  return String(name).toLowerCase().replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '')
}

// hostname 提取（本地实现，不 import render-md——render-md 是末模块，会循环依赖）。
// 种子带可选 url 字段：有 url 的 major-out 项 sourceUrl 是真 URL → buildCitationMap 正常编号挂 [n] 角标。
// (与 render-md buildCitationMap 的 hostname 逻辑复刻一致；两模块都不 import 对方)
const _hostnameOf = s => {
  try { return new URL(s).hostname } catch { return null }
}

const _mkMajor = (m, board) => {
  const host = _hostnameOf(m.url)
  return {
    claim: m.name + '：' + m.note, quote: m.note,
    sourceUrl: m.url || '(多源公认)',
    sourceTitle: host || '行业客观公认事实',
    date: m.date, board: board, publishDate: m.date, sourceQuality: 'primary', importance: 'central',
    verdicts: [], refutedCount: 0, erroredCount: 0, survives: true, isRefuted: false, isMajorOut: true, vote: '—',
    // verifiedByVote:false —— [窗口外·重大] 未经过窗口内对抗投票，reportBody 统一渲染 Vote: —（未投票），不得冒充 3-0。
  }
}

// 工厂返回 _addMajor(m, board)，语义同现行：全 claim 与首段各测一次指纹（8/16 xAI 前缀 bug 修复）；日期更具体者覆盖。
const makeAddMajor = majorOutClaims => (m, board) => {
  const k = majorKey(m.name)
  const ex = majorOutClaims.find(x => majorKey(x.claim || '') === k || majorKey(String(x.claim || '').split('：')[0]) === k)
  if (ex) {
    const exHasDay = /\d{4}-\d{2}-\d{2}/.test(ex.date || ''); const newHasDay = /\d{4}-\d{2}-\d{2}/.test(m.date || '')
    if (newHasDay && !exHasDay) { ex.date = m.date; ex.publishDate = m.date; ex.claim = m.name + '：' + m.note; ex.quote = m.note }
    return
  }
  majorOutClaims.push(_mkMajor(m, board))
}

// 静态候选优先：把 found_via==='static-fallback' 的项移到数组前部，组内保持原顺序；返回新数组，
// 不修改输入数组与项对象。8/27 Fetch 预算书账：静态源（官方新闻页）在预算紧张时优先摄入，
// 保证 discover 全失败 + harvest 兜底缺时，静态兜底 URL 仍能先进 Fetch 配额（而非被排在普通候选中
// 挤到 budgetDropped）。只排序不增减项——不承诺恢复 budgetDropped 项，MAX_FETCH 是总上限。
const preferStaticFirst = targets => {
  const statics = []
  const others = []
  for (const t of targets) (t && t.found_via === 'static-fallback' ? statics : others).push(t)
  return statics.concat(others)
}

// 轮询公平分配 fetch 预算：每轮每板块至多取 1 个未抓 URL，直到 maxFetch 耗尽——保证晚序板块不被压占。
// boardURLMap: Map<boardKey, urlObj[]>（urlObj 带 url 字段；函数内补 board 字段）。
// 8/27 Task 1：可选 prefer 通道——found_via 命中 preferFoundVia（默认 ['linuxdo-cdp','static-fallback']）
// 的候选先于轮询占位（去重后按 cap=⌊MAX_FETCH×preferShare⌋ 封顶，单板墙量配额不能吃光整个预算），
// 剩余 slots 仍走既有轮询公平。**默认行为与旧版逐字节一致**（无 prefer 候选时此阶段为 no-op）。
// 用途：linux-do 预抓内容（linuxdo-cdp）与静态兜底（static-fallback）是"已投入资源、应当消费"的候选，
// 之前与普通候选混池轮询，会被其他板块的轮询名额挤到 budgetDropped（8/26 实测 fetch_budget_dropped:45
// 中大量是预抓的 linux.do 帖子）。prefer 通道保证它们在预算紧张时仍真实进入 Fetch/Verify。
// 返回 { fetchTargets, dupes, budgetDropped }，与现行编排内逻辑逐字对齐。
const allocateFetchBudget = (boardURLMap, MAX_FETCH, opts) => {
  const dupes = []
  const budgetDropped = []
  const seen = new Map()
  const fetchTargets = []
  const prefer = new Set((opts && opts.preferFoundVia) || ['linuxdo-cdp', 'static-fallback'])
  const preferShare = (opts && typeof opts.preferShare === 'number') ? opts.preferShare : 0.5
  // prefer 通道封顶：floor(MAX_FETCH × preferShare)，单板墙量配额不能吃光整个预算。
  // preferShare=0 → 封顶 0 → 通道整体关闭（回退纯轮询）；默认 0.5。
  const preferCap = MAX_FETCH <= 0 ? 0 : Math.floor(MAX_FETCH * Math.min(1, Math.max(0, preferShare)))
  const boardURLs = [...boardURLMap.entries()].map(([board, urls]) => ({ board, urls }))

  // Phase 1 — prefer：吃下命中 prefer 的候选（去重、封顶到 preferCap）。preferCap=0 时本阶段整体关闭。
  //
  // 8/31 P2 修复：改**按通道轮询**分配，不再「板间先到先得」。
  // 旧版按 boardURLMap 插入序逐板吃满 preferCap：template 中 linuxdo CDP 预块的 discoverResults.push
  // 早于普通组（`batch.filter(g => !g.cdp)`）→ linuxdo 带 24 个候选排第一 → preferCap=8 全被它吃光，
  // static-fallback 只能回轮询里挤。8/31 实证 `linuxdo-cdp 进配额 10（丢弃 14）` 而 `static_fallback:5` 全丢。
  // 而 ROI 是**倒挂**的：静态 2 席 → 3 claims（techcrunch 1 confirmed）；linuxdo 9 席 → 3 claims
  // （仅 1 帖有产出，另 8 席 claimCount 0、quality unreliable）→ 静态单席产出是 linuxdo 的 4.5×。
  // MAX_FETCH 12→16 的上调把 preferCap 6→8，旧逻辑下等于又白送 linuxdo 两席。
  //
  // 新语义：preferCap 在**实际有候选的通道**间等分（round-robin 逐轮每通道取 1），任一通道用不满的
  // 余量自然流给其它通道（轮询到无候选即跳过）——既给每条通道保底下限，又不浪费配额。
  // 通道内仍按板轮询（每轮每板至多 1），保持板间公平。
  if (preferCap > 0) {
    // 通道 → 该通道的候选队列（按板轮询序展开：第 1 轮各板首个候选、第 2 轮各板次个……）
    const queues = new Map()
    for (const via of prefer) queues.set(via, [])
    let maxLen = 0
    for (const b of boardURLs) maxLen = Math.max(maxLen, b.urls.length)
    for (let i = 0; i < maxLen; i++) {
      for (const b of boardURLs) {
        const u = b.urls[i]
        if (!u || !prefer.has(u.found_via)) continue
        queues.get(u.found_via).push({ u, board: b.board })
      }
    }
    // 只保留真有候选的通道参与等分（否则空通道会白占份额）
    const live = [...queues.entries()].filter(([, q]) => q.length).map(([via, q]) => ({ via, q, i: 0 }))
    let progressedPrefer = live.length > 0
    while (progressedPrefer && fetchTargets.length < preferCap) {
      progressedPrefer = false
      for (const ch of live) {
        if (fetchTargets.length >= preferCap) break
        // 取该通道下一个未被去重吃掉的候选（每轮每通道至多 1 席）
        while (ch.i < ch.q.length) {
          const { u, board } = ch.q[ch.i++]
          const key = normURL(u.url)
          if (seen.has(key)) continue
          seen.set(key, true); u.board = board
          fetchTargets.push(u); progressedPrefer = true
          break
        }
      }
    }
  }

  let fetchSlots = MAX_FETCH - fetchTargets.length
  let progressed = true
  while (progressed && fetchSlots > 0) {
    progressed = false
    for (const b of boardURLs) {
      if (fetchSlots <= 0) break
      for (const u of b.urls) {
        const key = normURL(u.url)
        if (seen.has(key)) continue
        seen.set(key, true); u.board = b.board
        fetchTargets.push(u); fetchSlots--; progressed = true
        break // 每板每轮至多一个名额
      }
    }
  }
  for (const b of boardURLs) for (const u of b.urls) if (!seen.has(normURL(u.url))) budgetDropped.push({ url: u.url, board: b.board })
  const keyCount = new Map()
  for (const b of boardURLs) for (const u of b.urls) { const k = normURL(u.url); keyCount.set(k, (keyCount.get(k) || 0) + 1) }
  for (const b of boardURLs) for (const u of b.urls) { const k = normURL(u.url); if ((keyCount.get(k) || 0) > 1) { dupes.push({ url: u.url, board: b.board }); keyCount.set(k, 0) } }
  return { fetchTargets, dupes, budgetDropped }
}
// ─── inline: budget ───
// ai-daily 阶段墙钟预算 — 第十四项语义的可测试化。
// 切片(BUDGET_MS)是用户输入、累计死线(PHASE_DEADLINES)是内部状态，混用即 bug（见 memory ai-daily-budget-deadline-semantics）。

// 累计死线：各阶段切片相加；Verify 在切片和后另减 verifyInflightBuffer（为最后一批在飞票固定 AGENT_TIMEOUT_MS 留空间），
// 墙钟仅为软目标——极端尾批可超 totalLimit；合成入口与 totalLimit 脱钩，由 report 自身 timeout 约束 + render-md 降级兜底。
const computePhaseDeadlines = ({ harvest, discover, fetch, verify, verifyInflightBuffer, totalLimit }) => ({
  Harvest: harvest,
  Discover: harvest + discover,
  Fetch: harvest + discover + fetch,
  Verify: harvest + discover + fetch + verify - verifyInflightBuffer,
  Synthesize: totalLimit,
})

// 工厂：elapsedFn 注入时钟（workflow 里 _wallMs 累加器，测试里 mock）——realm 时钟限制的正确解耦点。
// onSkip(stage) 回调用于 budgetSkipped 记账 + log；同一 stage 越线只记一次（由调用方 includes 判断，见 workflow）。
const makeBudgetGate = (deadlines, elapsedFn, onSkip) => {
  const skipped = []
  const budgetGate = stage => {
    const e = elapsedFn()
    const dl = deadlines[stage]
    const ok = e <= dl
    if (!ok && !skipped.includes(stage)) { skipped.push(stage); if (onSkip) onSkip(stage, e, dl) }
    return { ok, roomMs: Math.max(0, dl - e) }
  }
  budgetGate.skipped = skipped  // 暴露记账数组供 degraded 标记读取（对应现行 budgetSkipped）
  // 8/26 修复（Discover 慢代理不得拖垮 Fetch）：纯读「距某累计死线的剩余」，无副作用——
  // 不写 skipped、不调 onSkip。供批边界决策（如 Discover 起跑前查是否应压住新批保住 Fetch 时段），
  // 而不像 budgetGate('Fetch') 那样在阶段未真正越线时误记 budget_skipped。
  budgetGate.roomTo = stage => Math.max(0, deadlines[stage] - elapsedFn())
  return budgetGate
}
// ─── inline: wallclock ───
// ai-daily 墙钟标定 + 计数型断路器 — 8/31 P1 修复。
//
// 背景（8/31 生产 run wf_e14b2828-ff5 实证）：workflow realm 无 Date.now/performance，唯一时钟是
// `setTimeout(_tick, 250)` 自递归累加器 `_wallMs`——它计的是**tick 发生次数 × 250ms**，不是真实
// 经过时间。54 个代理 + 26 次 stall 把事件循环压满 → tick 被饿死 → 累加器**只会低估，永不高估**：
//   检查点        真实经过    累计死线   低估倍率
//   Fetch gate     6981s      1500s     ≥4.7×
//   Verify gate   11514s      1740s     ≥6.6×
//   synthAllowed  13604s      1800s     ≥7.6×
// 后果：4h13m 的 run 里零 BUDGET-SKIP/BUDGET-BREAK，30min 软目标形同不存在，AGENT_TIMEOUT_MS
// 一起失效（名义 360s 的 fetch 代理实跑 1926/1951/2914s）。
//
// 关键观察：**定时器本身是可信的真实时间证据**。setTimeout(ms) 不会早于 ms 真实毫秒触发；
// 事件循环饱和只让它**晚**触发。所以当一个名义 ms 的 withDeadline 真的超时了，我们就掌握了
// 「真实经过 ≥ ms」这一硬事实；把它与同窗口的累加器增量 d 相比，即得饥饿倍率 ms/d。
// 这让 realm 内**可以**推出真实墙钟的下界，30min 承诺重新变得可执行（不再只能靠宿主侧看门狗）。

// ── 饥饿倍率 ──
// realMs：已被定时器证实的真实经过下界；accumDeltaMs：同一窗口内累加器的增量。
// 累加器只会低估 → 倍率下界 = realMs / accumDeltaMs，且恒 ≥1（健康时 ≈1）。
// accumDeltaMs ≤ 0（tick 完全饿死）时无从取比值，返回 null 交调用方忽略该次观测。
const starvationFactor = (realMs, accumDeltaMs) => {
  if (!(realMs > 0) || !(accumDeltaMs > 0)) return null
  return Math.max(1, realMs / accumDeltaMs)
}

/**
 * 标定墙钟：包住 raw 累加器，用定时器观测校正其低估。
 * @param {() => number} rawElapsed 原始累加器读数（workflow 里 RUN_ELAPSED）
 * @param {{maxFactor?:number}} opts maxFactor 封顶防单次异常观测把倍率放飞（默认 20）
 * @returns {{elapsed, observe, factor, peakFactor, observations}}
 *   elapsed()  校正后的经过毫秒，**单调不减**（时间绝不倒流，即便倍率回落）
 *   observe(realMs, accumDeltaMs) 记一次标定观测（withDeadline 超时 / 周期标定器各调一次）
 *   factor     最新观测倍率（网关恢复可回落）
 *   peakFactor 本 run 见过的最高倍率（旗标/审计用，回落不抹）
 */
const makeCalibratedElapsed = (rawElapsed, opts) => {
  const maxFactor = (opts && typeof opts.maxFactor === 'number' && opts.maxFactor > 0) ? opts.maxFactor : 20
  let factor = 1
  let peakFactor = 1
  let floor = 0
  let observations = 0
  const elapsed = () => {
    const v = rawElapsed() * factor
    // 单调闸：倍率回落（网关恢复健康）时读数不得倒退，否则已越线的阶段会「复活」。
    if (v > floor) floor = v
    return floor
  }
  return {
    elapsed,
    observe: (realMs, accumDeltaMs) => {
      const f = starvationFactor(realMs, accumDeltaMs)
      if (f === null) return factor
      observations++
      // 取最新观测（受 maxFactor 封顶）：饱和缓解时倍率应当能回落，
      // 而 elapsed() 的单调闸已保证读数不倒退——两者配合既跟得上变化又不会时间倒流。
      factor = Math.min(maxFactor, f)
      if (factor > peakFactor) peakFactor = factor
      return factor
    },
    get factor() { return factor },
    get peakFactor() { return peakFactor },
    get observations() { return observations },
  }
}

/**
 * 计数型断路器：不依赖时钟，纯靠**失败/停滞计数**决定是否放弃后续昂贵阶段。
 * 8/31 实证 Harvest 烧 70min、Discover 再烧 129min，而此间失败信号早已密集出现——
 * 计数信号在饱和下依然准确（与墙钟不同，它不会被事件循环饿死），是最后一道可靠闸门。
 *
 * @param {{consecutive?:number, total?:number}} opts 跳闸阈值
 *   consecutive 连续失败数（默认 3）；total 累计失败数（默认 5）
 * @returns {{record, open, reason, stats}}
 *   record(ok, label) 记一次代理结果（ok=false 即失败/超时/null 产出）
 *   open() 是否已跳闸；reason() 跳闸原因串（未跳闸为 null）
 */
const makeCircuitBreaker = opts => {
  // 0 是合法阈值（关闭该跳闸条件），不得用 `|| 3` 把 0 吞成默认。
  const maxConsecutive = (opts && typeof opts.consecutive === 'number') ? opts.consecutive : 3
  const maxTotal = (opts && typeof opts.total === 'number') ? opts.total : 5
  let consecutive = 0
  let failures = 0
  let successes = 0
  let reason = null
  return {
    record: (ok, label) => {
      if (ok) { successes++; consecutive = 0 } else {
        failures++; consecutive++
        if (!reason) {
          // ≤0 = 关闭该条件（consecutive:0 + total:0 → 断路器永不跳闸）。
          if (maxConsecutive > 0 && consecutive >= maxConsecutive) reason = 'consecutive_failures:' + consecutive + (label ? '@' + label : '')
          else if (maxTotal > 0 && failures >= maxTotal) reason = 'total_failures:' + failures + (label ? '@' + label : '')
        }
      }
      return !reason
    },
    open: () => !!reason,
    reason: () => reason,
    get stats() { return { failures, successes, consecutive } },
  }
}
// ─── inline: fallback ───
// ai-daily discover 兜底构造器 — 纯函数，供 template inline 与测试直调。
// 8/22 第二十项：disc 失败的组，从 harvest 已抓到的 digestByKey entries 补 URL 候选进 boardURLMap，
// 不重跑代理（省墙钟、不烧 token）。本模块抽出兜底构造逻辑为纯函数，消除"测试复刻修复逻辑"的 forward-test 缺陷
// （测试直调此函数，断言真实兜底行为，而非 grep 模板源码）。
//
// 依赖注入（template inline 后这些都在闭包内可见）：normURL、claimWindow。
// claimWindow = makeClaimWindow(...) 返回的函数 c => 'in'|'out'|'unknown'，判 !== 'out'（含 in 与无日期 unknown）。

/**
 * 从 harvest digest 构造兜底 URL 候选。
 * @param {Map} digestByKey key=normURL(feed.url) → {feed, entries, recent, failed}
 * @param {Array<{key:string,boards:string[],feeds?:string[]}>} failedGroups discover 失败的组
 * @param {(c:{date?:string})=>string} claimWindow 窗口判定函数（!== 'out' 即纳入）
 * @param {(u:string)=>string} normURL URL 归一化（去 query/hash，与 digestByKey 存键一致）
 * @returns {{fallbackByUrl:Array, recoveredBoards:Set<string>}}
 *   fallbackByUrl 每项 {url,title,date,board,found_via:'harvest-fallback'}；recoveredBoards 记救回的板。
 */
const buildFallback = (digestByKey, failedGroups, claimWindow, normURL) => {
  const fallbackByUrl = []
  const recoveredBoards = new Set()
  for (const g of failedGroups || []) {
    // srcUrls：合组走 g.feeds（硬编码组源），单板组从组 boards 派生订阅源（feeds+companies feed+labs 官方源）。
    // 注意：srcUrls 的来源由调用方（template）构造后传入更合适，但为保持纯函数自包含，这里接收 failedGroups
    // 已带 srcUrls 的形态——template 在调用前把 srcUrls 预算进 g（见 template inline 版本，下方兼容 g.feeds）。
    // 防御：把 g 归一成安全形态——srcUrls/feeds 必须真数组，boards 必须数组，缺省 `[]`——防 8/24 run 兜底入口
    // 对非数组/非可迭代 inputs 抛 "Spread ... iterable requires [Symbol.iterator] to be a function" 打穿整轮日报。
    if (!g || typeof g !== 'object') continue
    const srcUrls = Array.isArray(g.srcUrls) ? g.srcUrls : Array.isArray(g.feeds) ? g.feeds : []
    const gBoards = Array.isArray(g.boards) ? g.boards : []
    if (!srcUrls.length || !gBoards.length) continue
    for (const su of [...new Set(srcUrls.map(normURL))]) {
      const h = digestByKey instanceof Map ? digestByKey.get(su) : null
      if (!h || h.failed) continue
      // feed.boards 是该 feed 被订阅的全部板（feedMap 记录）；与失败组 boards 求交 = 真正归属板。
      // 防御：boards 可能是 Set 或数组；非可迭代值（null/数字/对象）视为空，绝不 spread——命中即整组跳过，不打穿整轮日报。
      const rawBoards = h.feed && h.feed.boards
      let feedBoards = []
      if (rawBoards && typeof rawBoards[Symbol.iterator] === 'function') {
        feedBoards = [...rawBoards].filter(b => g.boards.includes(b))
      }
      // 空交集说明该 feed 不属于当前失败组的任何板（冒烟子集：feed 订阅板被 BOARDS_SELECTED 过滤掉）。
      // 跳过该 entry 更诚实，不制造错误归属（首板被灌满、真实板 0 claim）。
      if (!feedBoards.length) continue
      for (const e of (Array.isArray(h.entries) ? h.entries : [])) {
        if (!(e && e.url && typeof e.url === 'string' && claimWindow({ date: e.date }) !== 'out')) continue
        for (const b of feedBoards) {
          fallbackByUrl.push({ url: e.url, title: e.title || e.url, date: e.date, board: b, found_via: 'harvest-fallback' })
          recoveredBoards.add(b)
        }
      }
    }
  }
  return { fallbackByUrl, recoveredBoards }
}
// ─── inline: prompts ───
// ai-daily prompt 模板 — 与 workflow 内逐字节一致；闭包依赖收敛为 ctx 显式注入。
// ctx 字段（按消费方分组）：
//   常量:    WINDOW_LABEL, WFROM, WTO, DATE, GROK_DIR, MAX_URLS_PER_BOARD, WEB_BUDGET_TOTAL, WEB_BUDGET_PER, feedMaxChars
//   discover: BOARDS, digestForBoard, digestForFeeds
//   verify:   VOTES_PER_CLAIM, REFUTATIONS_REQUIRED
//   report:   reportBody, coverBlock, missBlock, confirmedVerifyCount, killedCount, majorOutCount,
//             unverifiedCount, unverifiedList, refutedList
// build.mjs inline 后在 workflow 顶部构造同名常量 ctx 传入。

const harvestPrompt = (g, ctx) =>
  '## 共享源 Harvest（批量 ' + g.key + '）\n\n窗口：' + ctx.WINDOW_LABEL + '。依次抓取下面每个 feed 并提炼紧凑摘要：\n\n' +
  g.feeds.map(f => '- **' + (f.label || f.url) + '**\n  URL: ' + f.url).join('\n') + '\n\n' +
  '## 执行（对每个 feed 必须独立执行抓取，逐条做出来再进入下一个）\n' +
  g.feeds.map((f, i) =>
    'Step ' + (i + 1) + '：cd ' + ctx.GROK_DIR + " && ./scripts/fetch.js --max-chars " + ctx.feedMaxChars(f) + " --provider " + (/export\.arxiv\.org\/api\/query/i.test(f.url) ? 'direct' : 'auto') + " '" + f.url + "'\n" +
    '   **arXiv 官方 API 源：输出为 Atom XML（`<entry>` 为单篇，含 title/summary/updated/id 链接）。feed 字段必须用**本条目的来源 Feed URL（原样，勿改）**。**\n' +
    '   **只看返回 sources 里的 url/title/date 卡片，不看 answer.text（模型旧知识，不可作新闻依据）。**\n' +
    '   保留日期落在 [' + ctx.WFROM + ', ' + (ctx.WTO || ctx.DATE) + '] 内的条目，最多 15 条写入 entries；这些条目必须带 feed 字段 = **本条目的来源 Feed URL（原样，勿改）**，否则无法归栈。\n' +
    '   日期在窗口前（窗口首日前约 7 天内）但属**重大发布/官宣**（行业里程碑级）的，挑最多 4 条写入 recent（同样带 feed 字段，note 一句话说明为何重大）。普通旧新闻不写。\n' +
    '   该 feed 抓取失败/空源/全部无关 → 跳过它继续下一个，不要中断整组。'
  ).join('\n') + '\n' +
  '汇总：entries/recent 是**全部 feed 的合集**（每条带各自 feed 标签）。所有 feed 均失败才置 failed:true；部分失败则继续正常返回其余。\n' +
  '纪律：严格使用命令里给定的 --max-chars，禁止改大或去掉；禁止传递 --full-path（防止泄露完整文件路径）；禁止读取 .cache/grok-search/outputs/ 下的任何完整文件；每个 feed 只抓一次，不反复重抓；不要逐条打开链接。\n\nStructured output only.'

// discoverPrompt 需要 BOARDS/digestForBoard/digestForFeeds（编排层函数），通过 ctx 传入：
// ctx.BOARDS / ctx.digestForBoard / ctx.digestForFeeds 由 workflow 编排层提供。
const discoverPrompt = (g, ctx) => {
  const bds = g.boards.map(k => ctx.BOARDS.find(b => b.key === k))
  const multi = bds.length > 1
  const coverLine = multi
    ? '本代理负责以下 ' + bds.length + ' 个板块（每条 URL 必须标 board，选本组板块之一）：\n' + bds.map(b => '- **' + b.key + '**（' + b.title + '）：' + b.focus).join('\n')
    : '板块定义：\n' + JSON.stringify({ focus: bds[0].focus, companies: bds[0].companies || null, feeds: bds[0].feeds || null, xHandles: bds[0].xHandles || null }, null, 1)
  const digestBlock = multi ? ctx.digestForFeeds(g.feeds) : ctx.digestForBoard(bds[0])
  return '## 板块发现代理' + (multi ? '（合组：' + g.label + '）' : '：' + bds[0].title) + '\n\n窗口：' + ctx.WINDOW_LABEL + '。为日报采集窗口内可信可核实的新闻 URL。\n' +
    '⚠️ 关键纪律：搜索脚本的输出里 answer.text 是模型旧知识总结（训练截止点可能早于窗口！），绝不可作为新闻判断依据；只采信 sources 里的 URL 卡片（sources.grok / sources.merged 的 url/title/date）与下方**共享源摘要**（已由主流程预抓，可信）。官方渠道官宣的新模型/新发布通常不在模型知识里——要靠下方摘要与 X 官方源找到。\n\n' +
    '⚠️ 收口框架（最终唯一出口——先记住这条再做下面的步骤）：本代理的最终动作**只能是调用 StructuredOutput 工具**返回 { urls, noNews, nearWindow, majorOutOfWindow, degraded }。思考过程中即使已得出全部 URL 与结论，**最后一步也是调用该工具，而不是 end_turn 输出文字解释**。任何"我在思考里已想清楚，现在说明一下结论"的文字输出都算失败——主流程判定为 null，本组所属板块整组降级、0 claim。正确流程：执行下方 1-6 步 → 调一次 StructuredOutput 工具填齐字段 → 结束。禁止在工具调用前先打一段总结文字。\n\n' +
    coverLine + '\n\n' +
    '## 共享源摘要（已预抓，直接采信；**禁止再运行 fetch.js**）\n' + digestBlock + '\n\n' +
    '## 执行\n' +
    '1)【主干·必做】通读上方共享源摘要，保留窗口 ' + ctx.WFROM + '~' + (ctx.WTO || ctx.DATE) + ' 内、有新闻价值的条目（标题/URL/日期已给全）。**不要运行 fetch.js**——feed 内容已内置于本 prompt。' +
    (multi ? ' 按新闻主题给每条 URL 标归属板块 board（融资→funding / 监管法院标准→policy / 安全滥用水印→safety / 人事任命流动→people / 消费产品硬件→products / 战略资本基建→strategy）。' : (bds[0].key === 'labs' ? ' labs 板块必须逐家核厂商：先核对摘要里每家是否有动态；摘要未覆盖、或需 X 官宣确证的公司走第 2 步批量 X 搜索确认。' : ' 板块重点与摘要未覆盖的主题走第 2 步 X 搜索确认。')) + '\n' +
    '【空摘要快速降级】若上方共享源摘要全部为空/全部"抓取失败"（0 条 entries），说明 harvest 阶段未抓到任何 feed——此时 X 搜索 ≤2 次（本组 2 次，labs 3 次）仍无可用 URL 卡片，**立即返回 urls:[] + degraded:true**，不再尝试 WebSearch/WebFetch/多次 X 搜索。空摘要时死磕搜索只会烧 token 和墙钟，快速降级让主流程如实标记 missing_*。\n' +
    '2)【X 搜索·补充】对摘要未覆盖、或需官方发布确证的公司/主题：cd ' + ctx.GROK_DIR + " && ./scripts/search.js --days 3 --extra 4 --source-chars 300 --max-chars 5000 --responses-x-search --responses-allowed-x-handles '<handle,逗号,串联>' '<公司/主题> 发布/官宣 '" + '；只看返回的 URL 卡片（**优先 sources.grok，其次 sources.extra/sources.merged** 里的 url/title/date，只看 str 非空卡片），不看 answer.text。**批量优先**：每次查询携带 4-6 个 allowed-x-handles（逗号串联）一次覆盖多家/多主题，' + (multi ? '跨板块共用。' : 'labs 板块用 5 次以内批量查询覆盖所有摘要未覆盖的公司。') + ' 本组 X 搜索 ≤' + g.xBudget + ' 次。\n' +
    '3)【WebSearch 补充】仍缺的：WebSearch `<公司/关键词> 新闻 ' + ctx.WTO + '`（全流水合计 ≤' + ctx.WEB_BUDGET_TOTAL + ' 次、本组 ≤' + ctx.WEB_BUDGET_PER + ' 次；不可用就跳过，勿失败）。\n' +
    '4) 只保留事件日期落在 [' + ctx.WFROM + ', ' + (ctx.WTO || ctx.DATE) + '] 内的；优先一手官方源；跳过无日期/明显陈旧/SEO/内容农场/常青帮助文档页。URL 写完整。\n' +
    '最多返回 ' + (multi ? 10 : ctx.MAX_URLS_PER_BOARD) + ' 条 url/title/found_via/date' + (multi ? ' + board（必填，本组板块之一）' : '') + '。' + (bds[0].key === 'labs' ? 'labs 板块逐家核厂商——确认窗口内无任何动态的，把公司名放 noNews。' : '') +
    '5) 若某公司/主题本窗口无动态、但近 2 周内有重大发布/官宣/可信事实（如 DeepSeek V4 开源、Grok 4.6 发布、DeepSeek Harness 这类**行业客观公认事实**），将其列入 majorOutOfWindow（name/date/note），供日报正文以「[窗口外·重大]」标签呈现。注意：majorOutOfWindow 只放**客观事实**（非传闻、非推测），且必须是**行业里程碑级**——如果是普通更新或次要动态，放 nearWindow 供窗口外参考节引用即可。若该事实有可溯源的官方/一手 URL，尽量在 `url` 字段带上（可选，无则不带）。' +
    '6)【预算·硬性纪律】X 搜索本组 ≤' + g.xBudget + ' 次，一家/一个主题一次尝试、无果即放过、不反复深挖；WebSearch 全流水合计 ≤' + ctx.WEB_BUDGET_TOTAL + ' 次、本组 ≤' + ctx.WEB_BUDGET_PER + ' 次，不可用即跳过、勿失败。**发现阶段禁止运行 fetch.js**，也禁止 WebFetch 连续深挖单公司官网新闻页（官网正文抓取是 fetch 阶段职责，发现阶段只需给出 URL 候选；官网首页一次快速确认至多 1 次）。输出只保留用于抓取/核查的高置信候选，超过上限按重要性截断。' +
    'degraded 语义：仅当本（组/板块）的【主源/官方通道】整体一无所获（摘要 + X 搜索均返回零个可用 URL）时才置 true；个别补充源（GitHub trending、WebSearch、某一 X 搜索等）失败不算 degraded，正常返回即可。尽力用可用渠道，不要整任务失败。' +
    '\n\n⚠️ 最终收口（呼应开头条目）：执行完上述步骤后，立即调用 StructuredOutput 工具返回结构化对象。**严禁 end_turn 返回纯文本**——这是最常见的失败模式（思考里说"我来调用 StructuredOutput"却以文字结束）。调工具即结束，勿在工具调用前/后铺垫文字。Structured output only.'
}

const fetchPrompt = (src, ctx) =>
  '## Source Extractor\n\n窗口：' + ctx.WINDOW_LABEL + '。抓取并提取该来源的可证伪声明：\n' +
  '**URL:** ' + src.url + '\n**Title:** ' + src.title + '\n**Found via:** ' + src.board + ' / ' + src.found_via + '\n\n' +
  '## Task\n' +
  '1. 用 WebFetch 抓取页面。\n' +
  '⚠️ **禁止截图/图片输入**：本模型仅支持文本输入。禁止使用 Playwright 截图、禁止用图片方式读页面——使用 WebFetch 文本抓取。传入图片/screenshot 会直接导致 400 模型报错（Model only supports text input）。\n' +
  '2. 判定来源质量：primary(官方/一手) / secondary(主流媒体报道) / blog / forum / unreliable。\n' +
  '3. 提取 2-3 条与本板块日报问题相关、可核实、具体的声明（非空泛结论）；每条必须带原文引语 quote（**逐字抄录支撑该声明的完整原句，≤220 字，且必须包含声明中的全部具体细节——日期/数字/机构名/对比结论**，只截 40 字短句会导致核查票无据可依而误否决）、重要性 central/supporting/tangential。\n' +
  '4. 注明页面/事件日期 publishDate（YYYY-MM-DD 或 MM-DD）；无日期则空。\n' +
  '5. 页面较长时只精读与日报相关且日期在窗口内的部分，其余快速略读；抓取失败/付费墙/无关页面 → 返回 claims:[] 且 sourceQuality:"unreliable"。\n\nStructured output only.'

// verifyPrompt 需要 VOTES_PER_CLAIM/REFUTATIONS_REQUIRED，经 ctx 传入。
const verifyPrompt = (c, ctx) =>
  '## 对抗性核查票 ' + '(voter)\n\n' +
  '请对下列声明持怀疑态度，尝试证伪。≥' + ctx.REFUTATIONS_REQUIRED + '/' + ctx.VOTES_PER_CLAIM + ' 票证伪即否决。\n\n' +
  '窗口：' + ctx.WINDOW_LABEL + '。\n\n## 声明\n' + '"' + c.claim + '"\n\n来源：' + c.sourceUrl + ' (' + c.sourceQuality + ')，页面日期：' + (c.publishDate || '未知') + '，条目标注日期：' + (c.date || '未知') + '\n引语："' + c.quote + '"\n\n## 清单\n' +
  '1. 引语是**逐字抄录的完整支撑句**（契约要求覆盖声明全部细节——日期/数字/机构/对比）。声明中的细节凡能在引语中逐字溯源即视为被支撑；仅当声明断言明显超出引语范围（引语只谈 X 却断言 Y）才算过度引申。引语不是全文≠证据不足，勿因引语未铺陈全背景而否决。\n2. 时效：**窗口为 [' + (ctx.WFROM || ctx.DATE) + ', ' + (ctx.WTO || ctx.DATE) + ']**。事件/发布日期明显在窗口外（数天前/数周前/上月）→ refuted=true；页面日期在窗口内但内容陈述的是旧事件，按**事件实际发生日**判定，日期明确超窗仍 → refuted=true；无法判定日期则不因时效否决。\n3. 来源质量与声明强度是否匹配？（惊人声明需一手源）\n4. 是否营销话术/吹嘘/标题党/论坛猜测？（→ refuted=true）\n\n5. **禁止使用 WebSearch/WebFetch 等外部搜索工具**——本核查只依据上面给出的引语/来源/日期/声明做内部一致性判断，外部搜索会烧掉大量 token。\n\n默认 refuted=true，除非证据充分支撑。\n\nStructured output only. Evidence 简短具体（≤80 字）。'

// reportPrompt 需要编排层预拼的 reportBody/refutedList/unverifiedList/missBlock/coverBlock 与统计数，经 ctx 传入。
const reportPrompt = ctx =>
  "## 日报终稿 —— 新闻编辑简报\n\n窗口：" + ctx.WINDOW_LABEL + "。下面是一篇 AI 日报的原始素材：" + ctx.confirmedVerifyCount + " 条已核查声明（对抗式 2+1 票验证），" + ctx.majorOutCount + " 条行业公认重大事实（[窗口外·重大]，超窗未投票但可入正文）。\n\n" +
  "你的任务：把它们写成一篇**真正可读的中文 AI 日报**。\n\n" +
  "## 原始素材\n" + ctx.reportBody + "\n" +
  (ctx.killedCount ? "\n## 被否决声明（不写入正文）\n" + ctx.refutedList : "") +
  (ctx.unverifiedCount ? "\n## 未验证声明（核查代理故障，只能进“待核实”小节）\n" + ctx.unverifiedList : "") +
  ctx.missBlock +
  "\n## 覆盖自检\n" + ctx.coverBlock + "\n\n## 编辑要求\n" +
  "0. **禁止调用任何工具**（禁 WebFetch、WebSearch、Read、curl 及一切工具调用）——只做纯推理合成；一旦发起工具调用即视为失败。\n" +
  "**✅ 收口纪律（最终唯一出口）**：本代理的最终动作**只能是调用 StructuredOutput 工具**返回结构化对象 { sections, oneLiner, execSummary, caveats, openQuestions }。思考过程中即使已得出全部结论、或素材为空（无已确认声明、仅少量未核查/超窗项），**最后一步也是调用 StructuredOutput 工具，而不是 end_turn 输出文字总结**。任何「我在思考里已经理清，现在用文字说明」的 end_turn 都算失败——主流程判定为 null，整篇日报降级为退化快讯。素材再少也要调用工具——哪怕返回 oneLiner 一句话 + sections 空数组 + execSummary 一句话，也必须通过 StructuredOutput 工具返回。\n\n" +
  "1. **先筛选，再写稿**：通读全部素材，选出今天**真正值得报道的 2-3 条头条**。头条优先序：**新模型发布 > 模型能力重大突破 > 技术里程碑 > 开源重磅发布 > 研究突破 > 监管/官宣**。**融资/并购/收费/估值/商业动态永远不进头条**，只进对应板块正文。其余素材按板块归类，不重要的（小更新/营销话术/旧闻重复）**直接 discard 不进正文**。宁缺毋滥。\n\n" +
  "2. **oneLiner（今日一句话）**：用一句话概括今天 AI 行业**技术层面**最重要的事——新模型、新能力、新突破，不是商业新闻。如果今天没有技术头条，才退而求其次选战略/产品新闻。\n\n" +
  "3. **execSummary（执行摘要）**：3-5 句，按技术重要性排序，写成一个连贯段落（不是分点列项）。每句对应一条重要新闻，写清楚谁做了什么+结果。\n\n" +
  "4. **sections / items**：\n" +
  "   - title：**新闻式标题**（≤25字，主语+动词+结果/数字，例：GLM-5.3 开源，Coding 能力接近 Fable 5）。**不要前置 [窗口外·重大]/[2-0✓] 等标签**，不要长从句，不要括号解释。**按 status 分轨**：已核查项（`已核查 2-0`/`已核查 2-1`）title 可用肯定动词（发布、上线、开源、收购、突破）直接陈述事实；未核查项（`[窗口外·重大]`/`未核查`）title **必须**用不确定度措辞（「据报」「传」「称」「预告」「据媒体」之一开头或嵌入），**禁止**用「发布」「上线」「完成」「正式」「确认」等肯定完成态词——标题与正文 summary 的不确定度纪律（4.5）必须一致，不能标题断言事实而正文又改口。例：`据报 xAI 发布 Grok 4.6，聚焦长时 Agent`（未核查）；`LFM2.5 草稿模型推理提速 3.18 倍`（已核查 2-1）。\n" +
  "   - summary：**一段新闻正文**（2-3 句），写清楚发生了什么、为什么重要，不是重复 title。\n" +
  "   - status：核查状态，**必须**是以下枚举之一（机器消费、精确匹配，不加括号/空格变体）：`已核查 2-0` / `已核查 2-1` / `[窗口外·重大]` / `未核查` / `已否决`。窗口外重大项**必须**写 `[窗口外·重大]`（含方括号）；（render 会按该值在标题后加徽标，写错字面量会漏标未核查徽标）\n" +
  "   - 多个 sources 时只保留最权威的 1-2 个 URL。\n\n" +
  "4.5. **不确定度如实标注**（与 AI.md 风格一致）：summary 中若素材存在不确定性（单源/社区传闻/灰度状态/未官方确认），用「有用户称」「据讨论」「现有资料未说明」「暂不能确认」等措辞如实标注，不假装确定性；社区传闻与官方动态须用不同措辞区分。**对 status 为 `[窗口外·重大]` 或 `未核查` 的 item（未经窗口内对抗投票验证），summary 必须用不确定度措辞（「据报」「有媒体称」「宣称」「待官方确认」「暂不能确认」之一）描述其事项，禁止用「已解决」「完成」「正式发布」「确认」等肯定完成态措辞**。已核查项（status 为 `已核查 2-0`/`已核查 2-1`）有 vote 支撑，可正常陈述。社区传闻与官方动态须用不同措辞区分。\n\n" +
  "4.6. **窗口外参考节由编排器统一渲染**：素材里「## 窗口外参考」的**次要超窗项（nearWindow）不要自己合成进 sections**——不要写独立的「窗口外参考」section，也不要把这些条目拼进任何板块 item；编排器会在文末统一渲染「## 📎 窗口外参考」节。你只负责**窗口内** + **[窗口外·重大]（major-out）** 的合成。分工与 discover 阶段一致：major-out（行业里程碑级客观事实）进正文并带 `[窗口外·重大]` 状态；nearWindow（普通更新/次要动态）只供参考节引用。\n\n" +
  "4.7.【聚类纪律】素材里「## 原始素材」开头的**「## 已聚类」区**（源自 fetch 阶段、被编排器标 `[cluster 已合并 N 条]` 的合并主视图）：\n" +
  "  - 同一事件出现于多条已聚类素材 → 只写 ONE 条标题正文，其他绝不重复（不并排、不\"此外\"再造一条）。若不同条沿用不同口径数字，直接写\"M 为 X、N 为 Y，口径不一\"，不再分别作文。\n" +
  "  - 判定两条是同一事件的双重标准（全部满足）：①共享 ≥1 个实体 token（组织/人名）；②日期同域（≥2 天内）；③数字字段重叠（含数量级）。\n" +
  "  - 判定后你的摘要正文即为主合并 + 数字/口径自然呈现（如 4.25GW/$150-200B/$600B/$105B 并陈）。\n\n" +
  "5. **板块组织**：不要机械按来源分板。**labs（新模型/模型能力）板块如果有内容，必须放在第一个板块**。如果某板块今天无重要新闻，该板块可以不出现在正文（但保留 coverage 自检）。重磅新闻放在最靠前的板块下。\n\n" +
  "3.2. **数字口径**：同事件多条素材数字口径不一（如 4.25GW/$150-200B/$600B/$105B）时，直接并陈不同口径、不各自成条、提醒勿相加。\n\n" +
  "6. **caveats**：注明弱来源/厂商口径/时间敏感。openQuestions 2-4 个。\n\n" +
  "7. 如果素材大部分是超窗重大项（major-out）而窗口内几乎为空，则 oneLiner 和 execSummary 如实反映这一情况，优先报道 major-out 中最重要的 1-2 条。\n\n" +
  "Structured output only. 输出格式：{ sections, oneLiner, execSummary, caveats, openQuestions } 其中 sections 为 [{ board, title, items: [{ title, summary, confidence, sources, vote, status }] }]"
// ─── inline: render-md ───
// ai-daily 确定性 md 渲染 — mdWriter 代理的替代。
// report 成功 → renderMarkdown（完整版）；report 失败 → renderDegradedMarkdown（降级版，原冒烟 compose 脚本正式化）。
// 两者输出都进 payloads.md 由 orchestrator 逐字节落盘，md 产出不再受网关波动影响。
// 2026-08-22 风格优化（spec 2026-08-22-ai-daily-report-style-design.md）：
//   A. 来源角标化（buildCitationMap + 正文 [n] + 末尾「### 参考来源」节）
//   B. renderMarkdown 可选 meta → Obsidian frontmatter + 素材窗口横幅 + 低素材提示
//   D. 降级版修 reportError 硬编码 + 来源角标化 + windowMisses 与 major-out 去重

// workflow realm 缺失 URL 全局的最小 polyfill（见 url-polyfill.mjs；build inline 后自动注入）。
// node:test 直跑时全局 URL 已存在，installUrlPolyfill 幂等跳过。
installUrlPolyfill()
// 供 test/realm-url.test.mjs 模拟 realm（删 globalThis.URL）后重新注入用。
const setUrlPolyfillForRealm = () => { installUrlPolyfill() }

const CONF_ZH = { high: '高', medium: '中', low: '低' }

// C.3(2026-08-22): 状态标签规范化——把代理产出的 status 各种写法归一后判定是否「未核查」类（未经窗口内对抗投票）。
// 归一：全半角括号（[]()（）［］）→ 去掉、全角空白→半角、两端去空白、去内部空白、去全角·→. 后比较。
// 真值（标未核查徽标）：[窗口外·重大] / 窗口外·重大 / 窗口外重大 / 未核查；已核查/已否决不算。
const normalizeStatus = s => String(s || '')
  .replace(/[［【\[]/g, '[').replace(/[］】\]]/g, ']')  // 全角括号归一为半角
  .replace(/[（）]/g, '(').replace(/[）]/g, ')')
  .replace(/[\s]+/g, '')               // 去所有空白
  .replace(/[·．]/g, '·')              // 全角点·点归一半角
const isUncheckedStatus = s => {
  const n = normalizeStatus(s)
  return n === '[窗口外·重大]' || n === '窗口外·重大' || n === '窗口外重大' || n === '未核查'
}

// 跨 section 唯一 URL 引用图：按「首次出现序」给每个唯一 URL 分配 1-based 编号（spec A.1）。
// 非 URL 来源（如 (多源公认)）不参与编号——正文不挂角标、不进参考列表。
// 返回 { map: Map<href, n>, list: [{ n, url, title }] }；list 即「### 参考来源」节的数据源，title 取 hostname。
const buildCitationMap = sections => {
  const map = new Map()
  const list = []
  const hostname = s => { try { return new URL(s).hostname } catch { return s } }
  for (const sec of sections || []) {
    for (const it of (sec.items || [])) {
      for (const s of (it.sources || [])) {
        let url
        try { url = new URL(s).href } catch { continue }
        if (!map.has(url)) {
          map.set(url, list.length + 1)
          list.push({ n: list.length + 1, url, title: hostname(url) })
        }
      }
    }
  }
  return { map, list }
}

// item/claim 的来源 → 该条正文末尾的角标串，如 ' [1][3]'（按编号升序、跨来源去重）。
// 无 URL 来源或图里无对应 → ''（不挂角标）。
const citationBadges = (sources, citeMap) => {
  if (!sources || !sources.length || !citeMap) return ''
  const ns = []
  for (const s of sources) {
    let url
    try { url = new URL(s).href } catch { continue }
    const n = citeMap.map.get(url)
    if (n != null) ns.push(n)
  }
  if (!ns.length) return ''
  return ' ' + [...new Set(ns)].sort((a, b) => a - b).map(n => '[' + n + ']').join('')
}

const itemBlock = (it, citeMap) => {
  const tag = it.status ? ' `' + it.status + '`' : ''
  const conf = (CONF_ZH[it.confidence] || it.confidence) ? '可信度：' + (CONF_ZH[it.confidence] || it.confidence) : ''
  const badges = citationBadges(it.sources, citeMap)
  // B.5: sources 存在但全是非 URL 文字描述（buildCitationMap 没给编号）→ 诚实标注无单一链接
  const hasSrc = it.sources && it.sources.length > 0
  const noUrl = hasSrc && !badges
  // C.2: 未核查项（status 为 [窗口外·重大] 或 未核查）→ 机器徽标双保险，不依赖代理措辞。
  // C.3(2026-08-22): 状态标签容错——8/22 生产 run 实证 major-out 条目 status 有 `[窗口外·重大]`/`窗口外重大`
  // （无方括号）等写法，精确匹配漏判 6/7 条。规范化（去 []／""、空白、全半角）后统一判定，真值走正常。
  const unchecked = isUncheckedStatus(it.status)
  const tail = badges + (noUrl ? ' [行业公认·无单一链接]' : '') + (unchecked ? ' *[未核查·待证实]*' : '')
  const lines = []
  lines.push('**' + it.title + '**' + tag)
  lines.push('')
  lines.push(it.summary + tail + (conf ? '\n\n*' + conf + '*' : ''))
  return lines.join('\n')
}

// 完整版 optionally 带 meta 时输出 Obsidian frontmatter（spec B.1）。字段全来自 meta，无新数据。
const frontmatterLines = (meta, date, window) => {
  if (!meta) return []
  const st = meta.stats && typeof meta.stats === 'object' ? meta.stats : {}
  const num = v => (typeof v === 'number' ? v : null)
  const L = ['---']
  L.push('date: ' + (meta.date || date))
  L.push('window: ' + (meta.window || window))
  L.push('generator: ai-daily')
  L.push('model: deepseek-v4-flash')
  L.push('tags: [日报, AI]')
  const statsParts = []
  if (num(st.confirmed) != null) statsParts.push('confirmed:' + st.confirmed)
  if (num(st.major_out) != null) statsParts.push('major_out:' + st.major_out)
  if (num(st.killed) != null) statsParts.push('killed:' + st.killed)
  if (num(st.urls_fetched) != null) statsParts.push('urls_fetched:' + st.urls_fetched)
  if (statsParts.length) L.push('stats: {' + statsParts.join(', ') + '}')
  L.push('---')
  return L
}

// 完整版：report 代理产出 sections 后的确定性排版。
// 输入即现行 mdWriter prompt 里 reportJson 的同构数据。
// meta 为可选参数：{ date, window, stats:{confirmed,major_out,killed,urls_fetched,urls_discovered}, generated_by, degraded }；
// 缺失时退化（无 frontmatter/横幅），向后兼容旧调用。
const renderMarkdown = ({ date, window, report, coverage, windowMisses, degraded, meta }) => {
  const L = []
  for (const fl of frontmatterLines(meta, date, window)) L.push(fl)
  L.push('# 🤖 AI 日报 · ' + date)
  L.push('')
  // 素材窗口横幅（meta 提供时，标题后、覆盖行前，AI.md 风格）。N=当日素材(窗口内 confirmed)，M=近几日来源(全部 urls_discovered)。
  const st = meta && meta.stats && typeof meta.stats === 'object' ? meta.stats : {}
  if (meta) {
    const N = typeof st.confirmed === 'number' ? st.confirmed : null
    const M = typeof st.urls_discovered === 'number' ? st.urls_discovered : (typeof meta.urls_discovered === 'number' ? meta.urls_discovered : null)
    if (N != null || M != null) {
      L.push('> **素材窗口**：当日素材 ' + (N != null ? N : '?') + ' 条；近几日来源 ' + (M != null ? M : '?') + ' 条。')
    }
    const hard = (typeof st.confirmed === 'number' ? st.confirmed : 0) + (typeof st.major_out === 'number' ? st.major_out : 0)
    if (hard < 8) L.push('> ⚠️ **低素材提示**：当日硬源不足 8 条，正文以近期趋势为主，请注意时效。')
  }
  L.push('> 覆盖 ' + window + ' 窗口 · 生成器 ai-daily（deepseek-v4-flash）' + (degraded && degraded.length ? ' · 降级标记：`' + degraded.join('`、`') + '`' : ''))
  L.push('')
  L.push('## 📌 今日一句话')
  L.push('')
  L.push(report.oneLiner)
  L.push('')
  L.push('## 📄 执行摘要')
  L.push('')
  L.push(report.execSummary)
  L.push('')
  const citeMap = buildCitationMap(report && report.sections)
  // 8/23 第二十一项：事件驱动分节——无内容的板块整体不出现（信息熵契约：不摆空骨架）。
  for (const sec of report.sections || []) {
    const items = (sec.items || []).filter(Boolean)
    if (!items.length) continue
    L.push('### ' + sec.title)
    L.push('')
    for (const it of items) { L.push(itemBlock(it, citeMap)); L.push('') }
    L.push('')
  }
  if (report.caveats && report.caveats.length) {
    L.push('## ⚠️ 未验证与局限')
    L.push('')
    for (const c of report.caveats) L.push('- ' + c)
    L.push('')
  }
  // 层 1 去重：过滤已在 report.sections items 标题中出现的窗口外项（对齐降级版 D.3，2026-08-22）。
  const majFromSections = (report.sections || []).flatMap(s => s.items || []).map(it => ({ claim: it.title }))
  const windowMissesDedup = windowMisses ? dedupWindowMisses(windowMisses, majFromSections) : []
  if (windowMissesDedup.length) {
    L.push('## 📎 窗口外参考')
    L.push('')
    for (const w of windowMissesDedup) L.push('- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note)
    L.push('')
  }
  if (report.openQuestions && report.openQuestions.length) {
    L.push('## ❓ 开放问题')
    L.push('')
    for (const q of report.openQuestions) L.push('- ' + q)
    L.push('')
  }
  L.push('## ✅ 覆盖自检')
  L.push('')
  for (const c of coverage || []) {
    L.push('- **' + c.title + '**：' + c.claims + ' claims / ' + c.urls + ' sources' + (c.degraded ? ' `[degraded]`' : ''))
  }
  L.push('')
  // 参考来源节（md 末尾，AI.md 风格 [n] → 编号参考列表，跨 section 全文唯一）
  if (citeMap.list.length) {
    L.push('### 参考来源')
    L.push('')
    for (const c of citeMap.list) L.push('- [' + c.n + '] [' + c.title + '](<' + c.url + '>)')
    L.push('')
  }
  return L.join('\n')
}

// 降级版：report 代理失败时由编排数据确定性合成——可读快讯，不再是原始数据转储。
// 8/22 改为新闻快讯风格：按窗口内/窗口外/否决分节，每条 claim 写为完整句子，附加核查徽标；
// 2026-08-22 再改：来源角标化对齐完整版 + 修 reportError 硬编码 + windowMisses 与 major-out 去重。

// windowMisses 去重：过滤已在 major-out 出现的 name（spec D.3）。
// 判定：完全包含 或 共享区分性拉丁实体 token（如 Grok、Qwen3.8-27B）——8/21 实况「Grok 4.6 in Copilot」与「Qwen3.8-27B edge model」即靠实体 token 命中。
const STOP_TOKENS = new Set(['news', 'note', 'report', 'model', 'models', 'open', 'new', 'blog', 'post', 'api', 'app', 'apps', 'ai', 'pro', 'free', 'beta', 'tool', 'tools', 'official', 'release', 'update'])
const tokenize = s => (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9.%\-]*/g) || []).filter(t => t.length >= 4 && !STOP_TOKENS.has(t))
const dedupWindowMisses = (windowMisses, maj) => {
  if (!windowMisses.length || !maj.length) return windowMisses
  const majClaims = maj.map(m => String(m.claim || '').replace(/\s+/g, ' ').trim())
  const majTokens = new Set()
  for (const c of majClaims) for (const t of tokenize(c)) majTokens.add(t)
  return windowMisses.filter(w => {
    const name = String(w.name || '').trim()
    if (!name) return true
    if (majClaims.some(c => c.includes(name))) return false
    if (tokenize(name).some(t => majTokens.has(t))) return false
    return true
  })
}

const renderDegradedMarkdown = ({ date, window, confirmed, refuted, coverage, windowMisses, degraded, noNewsCompanies, reportError }) => {
  const S = s => String(s || '').replace(/\s+/g, ' ').trim()
  const voteTag = x => x.verifiedByVote ? '`✓' + (x.vote || '?') + '`' : '`◇' + (x.vote || '?') + '`'
  // 降级版来源形态为单 URL x.source（非数组），统一走 buildCitationMap 角标化（spec D.2）。
  const citeMap = buildCitationMap([
    { items: (confirmed || []).map(x => ({ sources: x.source ? [x.source] : [] })) },
    { items: (refuted || []).map(x => ({ sources: x.source ? [x.source] : [] })) },
  ])
  const badge = x => citationBadges(x.source ? [x.source] : [], citeMap)
  const inW = (confirmed || []).filter(x => x.window === 'in')
  // 8/24 修复：maj 过滤改为 `x.window !== 'in'`——此前只收 'major-out'，window 为 'out'/'unknown'
  // 的已确认项既不进 inW 也不进 maj，静默丢失。现在非 in 的已确认项都归入窗口外节，不再消失。
  const maj = (confirmed || []).filter(x => x.window !== 'in')
  // 修 reportError 硬编码（spec D.1）：null/空不抹成 'report agent failed'，如实描述。
  const reason = reportError ? String(reportError).replace(/\s+/g, ' ').trim() : 'report 代理未产出完整版合成结构'
  const L = []
  L.push('# 🤖 AI 日报 · ' + date)
  L.push('')
  L.push('> 覆盖 ' + window + ' 窗口 · 生成器 ai-daily（deepseek-v4-flash）' + (degraded && degraded.length ? ' · 降级标记：`' + degraded.join('`、`') + '`' : ''))
  L.push('')
  L.push('## ⚠️ 本日报为**降级快讯**（report 合成代理未产出，由编排器据已核查归档拼合）')
  L.push('')
  L.push('降级原因：' + reason + '。以下内容依核查结果逐条拼合，无合成代理润色编排。')
  L.push('')
  L.push('### 窗口内新闻（' + inW.length + ' 条，对抗式核查确认）')
  L.push('')
  for (const x of inW) {
    L.push('- ' + voteTag(x) + ' ' + S(x.claim) + badge(x) + ' — *（' + (x.sourceQuality || '?') + '）*' + (x.erroredCount ? ' ⚠️' + x.erroredCount + ' 票异常' : ''))
  }
  L.push('')
  if (maj.length) {
    L.push('### 窗口外·已确认（' + maj.length + ' 条，未经窗口内投票）')
    L.push('')
    for (const x of maj) {
      L.push('- ' + S(x.claim) + '（' + (x.date || '?') + '）')
    }
    L.push('')
  }
  if (refuted && refuted.length) {
    L.push('### 已否决的提案（' + refuted.length + ' 条，对抗式核查未通过）')
    L.push('')
    for (const x of refuted) {
      L.push('- ~~' + S(x.claim) + '~~ → 否决 `' + (x.vote || '?') + '`' + badge(x) + (x.erroredCount ? ' ⚠️' + x.erroredCount + ' 票异常' : ''))
    }
    L.push('')
  }
  const wm = dedupWindowMisses(windowMisses || [], maj)
  if (wm.length) {
    L.push('### 📎 窗口外参考')
    L.push('')
    for (const w of wm) L.push('- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note)
    L.push('')
  }
  L.push('### ✅ 覆盖矩阵')
  L.push('')
  L.push('| 板块 | 标题 | 覆盖 claim 数 | 备注 |')
  L.push('|---|---|---|---|')
  for (const b of coverage || []) {
    // 8/23 第二十一项：事件驱动分节——无 claims 且无 URL 来源且公司三态均为空态之外的板：空矩阵行不渲染。
    // 8/23 I1 复核修复：模板 8/22 第二十项 labs 花名册跨板块校正已把全部 no_news 翻转为 no_dynamic，
    // render 时 no_news 永不出现。若枚举仍缺 no_dynamic，经校正的板（0 claims、0 urls、公司全
    // no_dynamic）会被误判成空行跳过——「已核查这些公司、当日均无动态」的覆盖自检信息（无动态 备注列）
    // 静默丢失（amnesia 类）。枚举补 'no_dynamic' → 该行保留渲染。真正空行仍是
    // 「0 claims 且无 urls 且无任何公司三态信息」（无 companiesChecked 或全空态）。
    // 8/31 P3 修复①：`degraded` 板即使 0 claims / 0 urls / 无公司三态也**保留行**。此前它们被
    // 当空行跳过——8/31 生产 run 里 opensource/academic/funding/policy/safety/people 六个 degraded
    // 的 0/0 板整行消失，10 板矩阵只剩 4 行，读者无法区分「查过·当日无新闻」与「压根没查到」。
    // 通道失败本身就是必须上报的覆盖事实，不是「无内容」。
    if (!b.degraded && (b.claims || 0) === 0 && !(b.urls || 0) && !(b.companiesChecked || []).some(c => ['has_dynamic', 'no_news', 'unreached', 'no_dynamic'].includes(c.state))) continue
    // 8/31 P3 修复②：degraded 与「无动态花名册」**并存渲染**（`degraded · 无动态：…`）。此前 labs 的
    // 三元在 noNewsCompanies 非空时直接替换掉 degraded 标记 → md 写「无动态：OpenAI、Google DeepMind…」
    // 而 meta 里 labs degraded=True、根本没有通道真正查过 OpenAI = 假确信（把「没查到」印成「查过无事」）。
    const notes = []
    if (b.degraded) notes.push('degraded')
    if (b.board === 'labs' && noNewsCompanies && noNewsCompanies.length) notes.push('无动态：' + noNewsCompanies.join('、'))
    L.push('| ' + b.board + ' | ' + b.title + ' | ' + b.claims + ' | ' + notes.join(' · ') + ' |')
  }
  L.push('')
  if (citeMap.list.length) {
    L.push('### 参考来源')
    L.push('')
    for (const c of citeMap.list) L.push('- [' + c.n + '] [' + c.title + '](<' + c.url + '>)')
    L.push('')
  }
  return L.join('\n')
}
// ─── inline: cluster ───
// ai-daily 确定性聚类（verify → report 之间的纯函数去重，2026-08-23 第二十一项）。
// 只做"主视图"聚类不放行：被合并的冗余 item 仍保留在 confirmed/claimsJson 归档，cluster 只影响
// reportBody 的「已聚类」呈现与正文去重（report prompt 4.7 纪律据此写）。
// clusterTokenize/clusterStopTokens 与 render-md 同款（正则 `/[a-z0-9][a-z0-9.%\-]*/g`、长度≥4、过滤
// clusterStopTokens），但**必须用不同词法名**——build.mjs 整文件 inline 会让 render-md 的同名未导出
// `tokenize`/`STOP_TOKENS` 与本文件的导出在同一顶层作用域 → 宿主 new Function 加载必抛
// `Identifier 'tokenize' has already been declared` SyntaxError（产物 C1 溃败；node --check 是假绿）。
// 双轨各自留副本（render-md 内 dedupWindowMisses 是私有函数、用户明令不改，不抽公共模块），仅为改名。

// 8/23 C1 复核修复：原名 STOP_TOKENS/tokenize 与 render-md 顶层同名冲突 → 改 clusterStopTokens/clusterTokenize。
const clusterStopTokens = new Set(['news', 'note', 'report', 'model', 'models', 'open', 'new', 'blog', 'post', 'api', 'app', 'apps', 'ai', 'pro', 'free', 'beta', 'tool', 'tools', 'official', 'release', 'update', 'announce', 'launch', 'said'])
const clusterTokenize = s => (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9.%\-]*/g) || []).filter(t => t.length >= 4 && !clusterStopTokens.has(t))

// 聚为 unordered 对：a 与 b 的 claim/claims 任一共享 ≥1 token 即成对。
// keyOf/unionTokens 供 clusterClaims 内部使用：claim 优先，次 title。
const unionTokens = c => new Set([...(c.claim ? clusterTokenize(c.claim) : []), ...(c.title ? clusterTokenize(c.title) : [])])

/**
 * 把共享实体 token 的声明聚成簇。
 * @param {Array} claims 声明数组，每项可含 claim/title/summary/sources/status/quote 等
 * @returns {Array<{key:string, items:Array}>} 簇：key 取首条 title/claim，items 为簇内声明（原样）
 * 确定性：按输入序首现注册 token，无随机性。
 */
const clusterClaims = claims => {
  if (!claims || !Array.isArray(claims)) return []
  const clusters = []
  const seen = new Map()   // token → cluster index（首现注册）
  for (const c of claims) {
    const ts = unionTokens(c)
    let idx = -1
    for (const t of ts) if (seen.has(t)) { idx = seen.get(t); break }
    if (idx < 0) {
      clusters.push({ key: c.title || c.claim, items: [c] })
      for (const t of ts) if (!seen.has(t)) seen.set(t, clusters.length - 1)
      continue
    }
    clusters[idx].items.push(c)
    for (const t of ts) if (!seen.has(t)) seen.set(t, idx)
  }
  return clusters
}

// 数字口径冲突由 report prompt 4.7 / 3.2 在文案层处置（聚类层不主动判定——保守设计，YAGNI）。
// 保留 detectNumericConflict 导出供 test 锁定保守语义，但 mergeCluster 不再消费其返回值（死分支已清理）。
const detectNumericConflict = items => false

const distinctByClaim = claims => { const m = new Map(); for (const c of claims) m.set((c.claim || '').trim(), c); return [...m.values()] }

const honestMergeSummary = items => {
  // 取 items 摘要拼接（中文顿号分隔）。数字口径冲突由 report prompt 4.7/3.2 文案层处置，聚类层不标注。
  const parts = items.map(c => (c.summary || c.quote || '').trim()).filter(Boolean)
  if (!parts.length) return ''
  return parts.join('；')
}

/**
 * 合并同一簇：nodup 计算 -> 数字冲突解析 -> merge。
 * 返回编排同构输入（claim/title/summary/sources/status 齐），report prompt 依然只吃原始 resolved 输入。
 * @param {Array} items 同一簇的声明（原样，可能含重复 claim）
 * @param {string} [dateLabel] 保留位（合并主视图可带日期标注）
 * @param {Object} [majorOutMap] 保留位（major-out 映射，本实现不使用）
 * @returns {Object} { ...首条, claim: key, summary, sources, status?, mergedCount, numericConflict? }
 */
const mergeCluster = (items, dateLabel, majorOutMap) => {
  const total = items.length
  const distinct = distinctByClaim(items)
  const key = distinct.map(c => c.claim || c.title).join('\n')   // 编排 key（信息熵契约新 claim）
  const sources = [...new Set(distinct.flatMap(c => c.sources || []))]
  const vote = distinct[0] && distinct[0].status ? distinct[0].status : null
  const summary = honestMergeSummary(distinct)
  const out = { ...distinct[0], claim: key, summary, sources, ...(vote ? { status: vote } : {}), mergedCount: total }
  return out
}
// ─── inline: linuxdo ───
// ai-daily linux.do 登录态抓取（2026-08-23 第二十一项 §A）——纯导出零调用模块，自身零副作用。
// 背景（已核实）：Cloudflare cf_clearance 绑定浏览器 TLS 指纹，裸 fetch 必 403，唯一可靠客户端是
// 9222 真 Chrome（登录态）。经 CDP 开启临时标签 → 等 .json 文档在 Chrome 内渲染为 body 文本 → 读回。
// 两条路径都覆盖：环境已有 globalThis.WebSocket（Node v26 是 function）→ 真 WebSocket 走
// Runtime.evaluate 轮询 body.innerText；无 WebSocket 全局（workflow realm 降级保险）→ CDP HTTP-only
// polling（每片轮询等价于"关旧标签+开新标签+读 body"的幂等快照）。
// 不启动任何进程；fetch/AbortSignal/setTimeout/WebSocket 都是环境已有全局，直接引用。
// build.mjs 只能把纯 float/纯导出 inline 进产物（workflow realm 自包含），本文件满足该约束。

const CDP_DEFAULTS = {
  cdpHost: '127.0.0.1:9222',
  maxPages: 4,          // news/34.json 分页安全上限（多为 1-3 页）
  perPageDeep: 3,       // 每页首页 JSON 字段已带 1 段文本摘要，topic 深抓仅少量(3)
  requestTimeoutMs: 15000,
  pollIntervalMs: 500,
  pollMaxMs: 15000,
}

// 判断当前环境是否有真 WebSocket（Node v26 全局即 function；workflow realm 无 → HTTP polling 保险路径）。
const hasW = () => (typeof globalThis !== 'undefined' && 'WebSocket' in globalThis) || typeof WebSocket === 'function'

// CDP HTTP：开标签 → 读 body 文本 → 关标签。
// 真 WebSocket：Runtime.evaluate 轮询 body.innerText（复用用户另一生成器的 polling 形态）。
// 无 WebSocket（workflow realm）：CDP HTTP-only polling——每片轮询都等价于"关旧标签+开新标签+读 body"的幂等快照。
// 关闭 CDP 临时标签（浏览器 tab，非仅 debugger Socket）——WS 路径必须补这步，否则每个被抓 URL 都泄漏一个标签到用户 9222 Chrome。
async function closeTab(host, targetId) {
  try { await fetch(`http://${host}/json/close/${targetId}`, { method: 'PUT', signal: AbortSignal.timeout(3000) }) } catch {}
}

async function readBodyText(host, url) {
  const res = await fetch(`http://${host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(CDP_DEFAULTS.requestTimeoutMs) })
  // 8/23 复核修复：/json/new 非 2xx 时 target 未建立、无标签可关，直接 throw（无泄漏，无需 closeTab）。
  if (!res.ok) throw new Error('open-tab HTTP ' + res.status)
  // 8/23 复核边界说明（pre-existing 不可达路径，非本修复缺口）：CDP 对 200 必回含 id 的 target JSON，
  // 故 target.id 解析失败/缺失只存在于理论中——若真发生，该 tab 将无法定位关闭（拿不到 id 就关不掉）。
  // 同理 json/new 请求被 AbortSignal 中断时服务端可能已建 tab 而客户端拿不到 targetId。两者均被
  // try 前抛错/退出路径挡在"已建 tab 且拿得到 id"之外，其余任何路径下方的 finally 一概兜住。
  const target = await res.json()
  const targetId = target.id
  try {
    const wsUrl = target.webSocketDebuggerUrl
    let text = null
    if (hasW()) {
      // 真 WebSocket：轮询内文取 JSON。
      const ws = new WebSocket(wsUrl)
      await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => { ws.close(); no(new Error('ws open')) } })
      let n = 0; const pend = new Map()
      ws.onmessage = e => { const v = JSON.parse(e.data); if (v.id && pend.has(v.id)) { pend.get(v.id)(v); pend.delete(v.id) } }
      const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++n
        pend.set(id, res)
        ws.send(JSON.stringify({ id, method, params }))
        // 超时防挂起：CDP 不回匹配 id 的消息时 reject + 清理 pend（挂起会卡住 readBodyText、finally 不触发）
        setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('cdp send timeout: ' + method)) } }, CDP_DEFAULTS.requestTimeoutMs)
      })
      await send('Runtime.enable')
      for (let i = 0; i < Math.ceil(CDP_DEFAULTS.pollMaxMs / CDP_DEFAULTS.pollIntervalMs); i++) {
        const { result } = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : null', returnByValue: true })
        const v = result?.result?.value
        if (v && String(v).trimStart().startsWith('{')) { text = v; break }
        await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
      }
      ws.close()
    } else {
      // 无 WebSocket 全局（workflow realm）：CDP HTTP-only polling — 每片轮询都等价于
      // "关旧标签+开新标签+读 body"的幂等快照。
      await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
      for (let i = 0; i < Math.ceil(CDP_DEFAULTS.pollMaxMs / CDP_DEFAULTS.pollIntervalMs); i++) {
        try {
          const r2 = await fetch(`http://${host}/json/${targetId}`, { signal: AbortSignal.timeout(3000) })
          if (r2.ok) { const j = await r2.json(); if (j.innerText) { text = j.innerText; break } }
        } catch { /* poll */ }
        await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
      }
    }
    return text && String(text).trimStart().startsWith('{') ? text : null
  } finally {
    // 8/23 复核修复：唯一关闭点用 finally 收敛 —— WS open 失败 / 中途抛错 / send 挂起超时被
    // withDeadline 化前（workflow 召唤层）都能兜到底。只关本函数 json/new 自己开的 targetId，
    // 绝不误关用户其它标签；关失败 try/catch 吞掉（标签已读完，关不上不影响抓取结果）。
    await closeTab(host, targetId)
  }
}

// 深抓单帖：GET https://linux.do/t/<id>.json 官方 JSON 接口（JSON 文档在 Chrome 内直接渲染为文本）。
async function deepFetchTopic(host, id) {
  return readBodyText(host, 'https://linux.do/t/' + id + '.json')
}

/**
 * 抓取 linux.do 前沿快讯（news/34）分页，返回 posts。CDP 走 9222 登录态 Chrome。
 * @param {{cdpHost?:string}} opts cdpHost 为 127.0.0.1:9222 形式；缺省 → ok:false 不降级
 * @returns {{ok:boolean, degraded:boolean, reason:string, pages:number, topics:number, posts:Array}}
 *   posts 每项 { id, title, url, date, snippet, likeCount }
 * no_cdp_host → ok:false 不降级（调用方选择不启用，板不崩）；其余失败 → ok:false + degraded:true。
 */
async function fetchLinuxDoNews34({ cdpHost } = {}) {
  const out = { ok: true, degraded: false, reason: '', pages: 0, topics: 0, posts: [] }
  if (!cdpHost) { out.ok = false; out.reason = 'no_cdp_host'; return out }
  try {
    for (let page = 1; page <= CDP_DEFAULTS.maxPages; page++) {
      const raw = await readBodyText(cdpHost, 'https://linux.do/c/news/34.json?page=' + page)
      const topics = extractTopicsFromJson(raw)
      if (!topics || !topics.length) break   // 空页即到底，不再翻
      out.pages++; out.topics += topics.length
      // 首页字段已带 topic excerpt（<200 字）→ 不算深抓；只对最前 perPageDeep 条补深抓正文片段。
      for (const t of topics.slice(0, CDP_DEFAULTS.perPageDeep)) {
        const deep = await deepFetchTopic(cdpHost, t.id)
        const postText = extractPostTextFromJson(deep)
        if (postText) t.snippet = postText.slice(0, 2400)
      }
      out.posts.push(...topics)
    }
    if (out.topics === 0) { out.ok = false; out.degraded = true; out.reason = 'empty_pages' }
  } catch (e) {
    out.ok = false; out.degraded = true; out.reason = String(e && e.message || e).slice(0, 120)
  }
  return out
}

// --- 轻量解析：从 Discourse JSON 提取 { id, title, url, date, snippet, likes } ---
function extractTopicsFromJson(raw) {
  if (!raw) return null
  let obj; try { obj = JSON.parse(String(raw).trim()) } catch { return null }
  if (!obj?.topic_list?.topics?.length) return null
  return obj.topic_list.topics.map(t => ({
    id: t.id, title: t.title, url: 'https://linux.do/t/' + t.id,
    date: t.created_at ? t.created_at.slice(0, 10) : '', snippet: t.excerpt || '', likeCount: t.like_count || 0,
  }))
}

function extractPostTextFromJson(raw) {
  if (!raw) return null
  let obj; try { obj = JSON.parse(String(raw).trim()) } catch { return null }
  const c = obj?.post_stream?.posts
  const rawStr = c && c[0]?.cooked ? String(c[0].cooked).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return rawStr || null
}

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
    log('safeAgent retry ' + (i + 1) + ' ' + (o.label || '?') + ' (null agent)')
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
  if (BREAKER.open()) {
    log('BREAKER-OPEN Discover 余批跳过（' + BREAKER.reason() + '，代理失败计数 ' + JSON.stringify(BREAKER.stats) + '）→ 直连 static-fallback → Fetch')
    break
  }
  // 8/23 第二十一项：linuxdo 组是独立发现通道（走 9222 登录态 Chrome 抓 news/34.json），非代理。
  // 在该批并行代理前同步抓取——成功 → posts 按配额塞进组返回行（board 标 linuxdo，URL 进 Fetch/Verify
  // 既有流水线）；失败 → 组返回行标 degraded（linuxdo_degraded 进降级旗标）；no_cdp_host（默认）→
  // LINUXDO-SKIP + urls:[] 不降级（板不崩）。date 参数可空：抓取只取最新分页，不强依赖日期窗口。
  for (const g of batch) {
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
    // 按 linuxdoMaxSources 配额把预抓 posts 转成组返回行 URL 候选（latest posts 在前，配额轮换截至）。
    const srcs = LDP.posts.slice(0, LINUXDO_MAX_SOURCES).map(p => ({
      url: p.url, title: p.title, found_via: 'linuxdo-cdp', date: p.date || DATE, board: 'linuxdo',
    }))
    discoverResults.push({ group: g, boards: g.boards, urls: srcs, noNews: [], nearWindow: [], majorOutOfWindow: [], degraded: false, linuxdoTopics: LDP.topics, linuxdoPosts: LDP.posts.length })
  }
  // 8/23 C2 复核修复：cdp 组已在上方预块处理并 push（CDP 抓取不进普通发现代理）；此处只跑普通组，
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
// 8/27 静态候选排序：static-fallback 项前置——预算紧张时优先摄入静态兜底（官方内容页）。
fetchTargets = preferStaticFirst(fetchTargets)
// 诚实书账：staticCount 只统计已经进入 fetchTargets 的项（已在 allocation 内获配额），
// 不统计被预算丢弃（budgetDropped）或未进入配额的候选——不虚报未获配额的静态候选。
const staticCount = fetchTargets.filter(t => t.found_via === 'static-fallback').length
if (staticCount > 0) log('STATIC-FALLBACK quota: ' + staticCount + ' 条静态兜底 URL 已获 fetch 配额并前置（fetchTargets 内实计）')
// 首批大小取 max(FETCH_BATCH, staticCount)：静态项已全进 fetchTargets，要一并装进首批（不绕过 MAX_FETCH）。
// 后续批次按 FETCH_BATCH 分批（静态项只入首批，余批保持既有并发上限）。
// 静态注入不在 discoverRows.urls → urls_discovered 账本不变（boardURLMap 仅从 discoverRows 派生）。
const FETCH_BATCH = 6
const FETCH_FIRST_BATCH = Math.max(FETCH_BATCH, staticCount)
const fetchBatches = []
if (fetchTargets.length) fetchBatches.push(fetchTargets.slice(0, FETCH_FIRST_BATCH))
for (let i = FETCH_FIRST_BATCH; i < fetchTargets.length; i += FETCH_BATCH) fetchBatches.push(fetchTargets.slice(i, i + FETCH_BATCH))

// ─── Phase Fetch + Extract ───
phase('Fetch')
const extracted = []
let stageFetchRan = false  // 8/27 一次性状态：Fetch 首批是否已正常启动（预算记账过 + 会在 await 前置位）
let salvaged = false  // 8/26 修复：救护首批已标记——余批整批 break，不再碰 budgetGate('Fetch')，避免把已抓过批的 Fetch 误记成「整段跳过」
for (const batch of fetchBatches) {
  if (salvaged) break  // 救护首批已跑：余批不再处理（budgetGate('Fetch') 不再被调用 → budgetSkipped 不记 Fetch）
  // 8/27 预算书账（stageFetchRan 一次性）：
  //  - 首批正常启动：调 budgetGate('Fetch')（记 skipped 的 gate）判定整段跳过/放行；放行则在 await 前置 stageFetchRan=true。
  //  - 首批越线：只允许现有救护语义（FETCH-SALVAGE），不调用记账 gate → 不把 Fetch 写进 skipped。
  //  - 后续批次：用纯读 budgetGate.roomTo('Fetch') === 0 停止，绝不再次把 Fetch 写入 skip。
  const salvageFirst = extracted.length === 0 && fetchTargets.length > 0 && budgetGate.roomTo('Fetch') === 0
  if (stageFetchRan) {
    // 后续批次：纯读停止（roomTo 无记账副作用），不再调用 budgetGate('Fetch')。
    if (budgetGate.roomTo('Fetch') === 0) { log('BUDGET-BREAK Fetch 余批跳过（首批已跑，roomTo=0 纯读停止，不记 budget_skipped:Fetch）'); break }
  } else if (!salvageFirst) {
    const gate = budgetGate('Fetch')
    if (!gate.ok) { log('BUDGET-BREAK Fetch 余批跳过，用已完成批次结果'); break }
    stageFetchRan = true  // 首批正常启动：await 前置 one-time 状态（预算账本已钉在「已运行」）
  } else {
    log('FETCH-SALVAGE 已过 Fetch 死线但执行救护首批：抓前 ' + Math.min(Math.max(FETCH_BATCH, staticCount), batch.length) + ' 条 URL（保证非 0 摄入）')
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
const report = await safeAgent(reportPrompt({
  ...ctxP, confirmedVerifyCount: confirmedVerify.length, majorOutCount: majorOutClaims.length,
  reportBody: reportBodyWithCluster, killedCount: killed.length, refutedList, unverifiedCount: unverified.length, unverifiedList, missBlock, coverBlock,
}), { label: 'report', phase: 'Synthesize', schema: REPORT_SCHEMA, timeoutMs: SYNTHESIS_LIMIT_MS }, reportTries)

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
      generated_by: 'ai-daily (deepseek-v4-flash)',
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
  date: DATE, window: { from: WFROM, to: WTO || DATE }, generated_by: 'ai-daily (deepseek-v4-flash)',
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