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
// 切片和 = 9+8+8+5 = 30min 与 TOTAL_LIMIT_MS 对齐（8/19 第十五项调序：Harvest 增到 9、Discover 减到 8，
// 依据见 HARVEST_BUDGET_MS 前的注释——discover 换 Tavily 兜底提速，harvest 保留 442-800s 慢但有效的 crops）；
// 分配序：Harvest/Discover 留足慢但有效的包络，Verify 牺牲序最低。
// 8/17 全量实测（Harvest 5.2 / Discover 9.2 / Fetch 7.3 / Verify 9.1min）证明 30min 盘子装不下 50 代理健康包络（合计 30.8min）：
// 修复后健康跑尾部 Verify 被逐波重算硬停（尾部核查票如实降 unverified），墙钟由 Verify 死线缓冲严格钉在 ≤ TOTAL_LIMIT_MS。
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
const filterSeedsByAge = (seeds, reportDayNum, maxAgeDays) => {
  if (reportDayNum == null) return seeds
  return seeds.filter(s => {
    const day = normalizeDate(s.date)
    if (day == null) return false            // 无日期 → 超期剔除（调用方 SEED-AGE 日志可见）
    return daysBetween(day, reportDayNum) <= maxAgeDays
  })
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
    majorOutOfWindow: { type: 'array', items: { type: 'object', required: ['name', 'date', 'note'], properties: { name: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' } } } },
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

// ─── Deterministic coverage: 9 boards × roster ───
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
  { key: 'academic', title: '学术研究', focus: 'arXiv 新提交、HF Daily Papers 榜单、研究突破', feeds: ['https://arxiv.org/list/cs.AI/recent', 'https://arxiv.org/list/cs.CL/recent', 'https://huggingface.co/papers'] },
  { key: 'funding', title: '融资并购', focus: '融资轮次、估值、并购、投资动态', feeds: ['https://techcrunch.com/category/artificial-intelligence/', 'https://36kr.com/', 'https://www.qbitai.com/'] },
  { key: 'policy', title: '政策监管', focus: '政府/监管/法院/标准组织对 AI 的动作', feeds: ['https://techcrunch.com/category/artificial-intelligence/', 'https://www.qbitai.com/'] },
  { key: 'safety', title: '安全与伦理', focus: '对齐、安全、滥用、水印、系统卡、攻击事件', feeds: ['https://www.qbitai.com/', 'https://techcrunch.com/category/artificial-intelligence/'] },
  { key: 'people', title: '人才流动', focus: '重要人物离职/跳槽/创业/任命', feeds: ['https://www.qbitai.com/', 'https://techcrunch.com/category/artificial-intelligence/'] },
]

const OFFICIAL_FEEDS = [
  { url: 'https://openai.com/news/rss.xml', label: 'OpenAI News' },
  { url: 'https://www.anthropic.com/news', label: 'Anthropic News' },
  { url: 'https://x.ai/news', label: 'xAI News' },
  { url: 'https://research.google/blog/rss/', label: 'Google Research Blog' },
  { url: 'https://blogs.nvidia.com/feed/', label: 'NVIDIA Blog' },
  { url: 'https://ai.meta.com/blog/', label: 'Meta AI Blog' },
]

// 种子"重大超窗事实"（行业里程碑级公认事件，即使不在窗口也应出现在正文，标注 [窗口外·重大]）：
// 发现代理通过 majorOutOfWindow 字段上报更多此类事实。
const KNOWN_MAJOR_OUT = [
  { name: 'OpenAI 预告 Astra 旗舰模型（解决 10 个长期开放数学难题）', date: '2026-08-02', note: 'OpenAI 公开预告下一个旗舰模型 Astra，宣称已解决 10 个长期开放数学难题，具体发布日期待官方确认（来源：多家媒体 2026-08-02，日期为预告日）。' },
  { name: 'DeepSeek V4-Pro 正式版上线（Agent 能力增强）', date: '2026-08-13', note: 'DeepSeek 官方 news 页登记 DeepSeek-V4-Pro 正式版上线 2026/08/13，App/网页/API 全面开放，强化 Agent 能力并引入分时段峰值定价；网易 08-16 报道印证 2026-08-17 价格生效（双源）。' },
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
]

// normURL 在 date-utils.mjs；boards.mjs 的 GROUPS_RAW.test 闭包需要它，这里前向声明由 build.mjs inline 时保证顺序。
// 直接 import 供 node 环境用；build.mjs inline 时剥掉 import 行（workflow 内 normURL 已在上文定义）。
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

const _mkMajor = (m, board) => ({
  claim: m.name + '：' + m.note, quote: m.note, sourceUrl: '(多源公认)', sourceTitle: '行业客观公认事实',
  date: m.date, board: board, publishDate: m.date, sourceQuality: 'primary', importance: 'central',
  verdicts: [], refutedCount: 0, erroredCount: 0, survives: true, isRefuted: false, isMajorOut: true, vote: '—',
  // verifiedByVote:false —— [窗口外·重大] 未经过窗口内对抗投票，reportBody 统一渲染 Vote: —（未投票），不得冒充 3-0。
})

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

// 轮询公平分配 fetch 预算：每轮每板块至多取 1 个未抓 URL，直到 maxFetch 耗尽——保证晚序板块不被挤掉。
// boardURLMap: Map<boardKey, urlObj[]>（urlObj 带 url 字段；函数内补 board 字段）。
// 返回 { fetchTargets, dupes, budgetDropped }，与现行编排内逻辑逐字对齐。
const allocateFetchBudget = (boardURLMap, MAX_FETCH) => {
  const dupes = []
  const budgetDropped = []
  const seen = new Map()
  let fetchSlots = MAX_FETCH
  const fetchTargets = []
  const boardURLs = [...boardURLMap.entries()].map(([board, urls]) => ({ board, urls }))
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
        break  // 每板块每轮至多一个名额
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
// 墙钟仅为软目标——极端尾批可超 totalLimit 约 300s，由 synthAllowed 绝对闸门 + render-md 降级兜底。
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
  return budgetGate
}
// ─── inline: prompts ───
// ai-daily prompt 模板 — 与 workflow 内逐字节一致；闭包依赖收敛为 ctx 显式注入。
// ctx = { WINDOW_LABEL, WFROM, WTO, DATE, GROK_DIR, MAX_URLS_PER_BOARD, WEB_BUDGET_TOTAL, WEB_BUDGET_PER, feedMaxChars }
// build.mjs inline 后在 workflow 顶部构造同名常量 ctx 传入。

const harvestPrompt = (g, ctx) =>
  '## 共享源 Harvest（批量 ' + g.key + '）\n\n窗口：' + ctx.WINDOW_LABEL + '。依次抓取下面每个 feed 并提炼紧凑摘要：\n\n' +
  g.feeds.map(f => '- **' + (f.label || f.url) + '**\n  URL: ' + f.url).join('\n') + '\n\n' +
  '## 执行（对每个 feed 必须独立执行抓取，逐条做出来再进入下一个）\n' +
  g.feeds.map((f, i) =>
    'Step ' + (i + 1) + '：cd ' + ctx.GROK_DIR + " && ./scripts/fetch.js --max-chars " + ctx.feedMaxChars(f) + " '" + f.url + "'\n" +
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
    '5) 若某公司/主题本窗口无动态、但近 2 周内有重大发布/官宣/可信事实（如 DeepSeek V4 开源、Grok 4.6 发布、DeepSeek Harness 这类**行业客观公认事实**），将其列入 majorOutOfWindow（name/date/note），供日报正文以「[窗口外·重大]」标签呈现。注意：majorOutOfWindow 只放**客观事实**（非传闻、非推测），且必须是**行业里程碑级**——如果是普通更新或次要动态，放 nearWindow 供窗口外参考节引用即可。' +
    '6)【预算·硬性纪律】X 搜索本组 ≤' + g.xBudget + ' 次，一家/一个主题一次尝试、无果即放过、不反复深挖；WebSearch 全流水合计 ≤' + ctx.WEB_BUDGET_TOTAL + ' 次、本组 ≤' + ctx.WEB_BUDGET_PER + ' 次，不可用即跳过、勿失败。**发现阶段禁止运行 fetch.js**，也禁止 WebFetch 连续深挖单公司官网新闻页（官网正文抓取是 fetch 阶段职责，发现阶段只需给出 URL 候选；官网首页一次快速确认至多 1 次）。输出只保留用于抓取/核查的高置信候选，超过上限按重要性截断。' +
    'degraded 语义：仅当本（组/板块）的【主源/官方通道】整体一无所获（摘要 + X 搜索均返回零个可用 URL）时才置 true；个别补充源（GitHub trending、WebSearch、某一 X 搜索等）失败不算 degraded，正常返回即可。尽力用可用渠道，不要整任务失败。' +
    '\n\nStructured output only.'
}

const fetchPrompt = (src, ctx) =>
  '## Source Extractor\n\n窗口：' + ctx.WINDOW_LABEL + '。抓取并提取该来源的可证伪声明：\n' +
  '**URL:** ' + src.url + '\n**Title:** ' + src.title + '\n**Found via:** ' + src.board + ' / ' + src.found_via + '\n\n' +
  '## Task\n' +
  '1. 用 WebFetch 抓取页面。\n2. 判定来源质量：primary(官方/一手) / secondary(主流媒体报道) / blog / forum / unreliable。\n' +
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
  '## 日报终稿合成\n\n窗口：' + ctx.WINDOW_LABEL + '。生成中文 AI 日报。' + ctx.confirmedVerifyCount + ' 条声明通过对抗核查（首查双票、分歧升补 1 票，≥' + ctx.REFUTATIONS_REQUIRED + ' 票否决即 kill，语义不变），另有 ' + ctx.majorOutCount + ' 条行业公认重大事实（[窗口外·重大]，非窗口内、未经投票，但可入正文）。\n\n' +
  '## 已确认声明\n' + ctx.reportBody + '\n' +
  (ctx.killedCount ? '\n## 被否决声明（供透明参考，不得写入正文）\n' + ctx.refutedList : '') +
  (ctx.unverifiedCount ? '\n## 未验证声明（核查代理故障，只能进“待核实”小节）\n' + ctx.unverifiedList : '') +
  ctx.missBlock +
  '\n## 覆盖自检\n' + ctx.coverBlock + '\n\n## 要求\n' +
  '0. **禁止调用任何工具**（禁 WebFetch、WebSearch、Read、curl 及一切工具调用）——本输入已含上游核查的全部结论与逐字引语，你只需**纯推理合成**；一旦发起任何工具调用即视为本次合成失败。\n1. 语义去重、合并——**跨板块重复内容只保留一处**（以更权威来源为准），其余删除；按板块组织成 sections（board/title/items）。\n2. 每条 item：title、summary(2-3句中文)、confidence(高/中/低 按多源与投票)、sources(URL数组)、vote。**title 前必须标注核查状态**：已核查 `[3-0✓]`、未核查 `[未核查]`、否决 `[否决✗]`、超窗重大 `[窗口外·重大]`。\n' +
  '3. 头条与执行摘要 execSummary(3-5句) 与 oneLiner **只能基于已核查或 [窗口外·重大] 条目**；未核查条目一律放入”待核实”小节，不得混入头条；被否决条目不得写入正文。[窗口外·重大] 条目可出现在正文和执行摘要中，但须如实标注标签。\n' +
  '4. caveats：注明弱来源、时间敏感、未核查项；openQuestions 2-4 个。\n5. 若存在窗口外参考（非重大超窗项），在日报末尾单列”## 📎 窗口外参考”一节如实引用。\n\nStructured output only.'
// ─── inline: render-md ───
// ai-daily 确定性 md 渲染 — mdWriter 代理的替代。
// report 成功 → renderMarkdown（完整版）；report 失败 → renderDegradedMarkdown（降级版，原冒烟 compose 脚本正式化）。
// 两者输出都进 payloads.md 由 orchestrator 逐字节落盘，md 产出不再受网关波动影响。

const CONF_ZH = { high: '高', medium: '中', low: '低' }

const itemLine = it =>
  '- **' + it.title + '**（' + (it.vote ? '`' + it.vote + '` ' : '') + '可信度 ' + (CONF_ZH[it.confidence] || it.confidence) + '）— ' + it.summary +
  (it.sources && it.sources.length ? ' — *来源: ' + it.sources.join(' , ') + '*' : '')

// 完整版：report 代理产出 sections 后的确定性排版。
// 输入即现行 mdWriter prompt 里 reportJson 的同构数据。
const renderMarkdown = ({ date, window, report, coverage, windowMisses, degraded }) => {
  const L = []
  L.push('# 🤖 AI 日报 · ' + date)
  L.push('')
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
  for (const sec of report.sections || []) {
    L.push('### ' + sec.title)
    L.push('')
    for (const it of sec.items || []) L.push(itemLine(it))
    L.push('')
  }
  if (report.caveats && report.caveats.length) {
    L.push('## ⚠️ 未验证与局限')
    L.push('')
    for (const c of report.caveats) L.push('- ' + c)
    L.push('')
  }
  if (windowMisses && windowMisses.length) {
    L.push('## 📎 窗口外参考')
    L.push('')
    for (const w of windowMisses) L.push('- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note)
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
  return L.join('\n')
}

// 降级版：report 代理失败时由编排数据确定性合成（核查真实、来源可溯、major-out 如实标注）。
// 即 8/18 冒烟 compose 脚本的正式化——不再是编排器临时孤儿，而是契约产物。
const renderDegradedMarkdown = ({ date, window, confirmed, refuted, coverage, windowMisses, degraded, noNewsCompanies, reportError }) => {
  const S = s => String(s || '').replace(/\s+/g, ' ').trim()
  const vote = x => x.verifiedByVote ? '✓ 投票 ' + x.vote : '◇ 未投票'
  const src = x => String(x.source || '').replace(/^https?:\/\//, '').split('/')[0]
  const em = x => (x.window === 'in' ? '**窗口内**' : '**[窗口外·重大]**') + '（' + (x.date || '?') + '）'
  const inW = (confirmed || []).filter(x => x.window === 'in')
  const maj = (confirmed || []).filter(x => x.window === 'major-out')
  const L = []
  L.push('# 🤖 AI 日报 · ' + date)
  L.push('')
  L.push('> 覆盖 ' + window + ' 窗口 · 生成器 ai-daily（deepseek-v4-flash）')
  L.push('> 原始数据存档：`' + date + '.verified-claims.json` / `sources.json` / `meta.json`')
  L.push('')
  L.push('## ⚠️ 本日报为**降级合成版**（report 代理未产出）')
  L.push('')
  L.push('降级原因：' + (reportError || 'report agent failed') + '。以下正文由编排器据已核查归档**逐条合成**：核查真实（对抗式 2+1 票）、来源可溯、`[窗口外·重大]` 如实标注。未经合成代理润色。')
  L.push('')
  if (degraded && degraded.length) { L.push('**降级标记**：`' + degraded.join('`、`') + '`'); L.push('') }
  L.push('## 窗口内已核查（' + inW.length + ' 条，对抗式投票确认）')
  L.push('')
  for (const x of inW) L.push('- **' + S(x.claim) + '**\n  - ' + vote(x) + ' · 来源：' + src(x) + '（' + (x.sourceQuality || '?') + '）· ' + (x.date || '?') + (x.erroredCount ? ' · ⚠️' + x.erroredCount + ' 票错误' : ''))
  L.push('')
  L.push('## [窗口外·重大] 行业里程碑注入（' + maj.length + ' 条，非窗口内、未经投票、如实标注）')
  L.push('')
  for (const x of maj) L.push('- ' + S(x.claim) + '（' + (x.date || '?') + '）')
  L.push('')
  if (refuted && refuted.length) {
    L.push('## 曾提案但被对抗式核查否决（' + refuted.length + ' 条）')
    L.push('')
    for (const x of refuted) L.push('- ~~' + S(x.claim) + '~~ → 否决 ' + x.vote + '（' + src(x) + '）' + (x.erroredCount ? ' · ⚠️' + x.erroredCount + ' 票错误' : ''))
    L.push('')
  }
  if (windowMisses && windowMisses.length) {
    L.push('## 📎 窗口外参考')
    L.push('')
    for (const w of windowMisses) L.push('- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note)
    L.push('')
  }
  L.push('## ✅ 覆盖矩阵')
  L.push('')
  L.push('| 板块 | 标题 | 覆盖 claim 数 | 备注 |')
  L.push('|---|---|---|---|')
  for (const b of coverage || []) {
    const note = b.board === 'labs'
      ? (noNewsCompanies && noNewsCompanies.length ? '无动态：' + noNewsCompanies.join('、') : (b.degraded ? 'degraded' : ''))
      : (b.degraded ? 'degraded' : '')
    L.push('| ' + b.board + ' | ' + b.title + ' | ' + b.claims + ' | ' + note + ' |')
  }
  L.push('')
  return L.join('\n')
}

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
// Verify 累计死线在切片和后另减 VERIFY_INFLIGHT_BUFFER_MS：为最后一批在飞票（固定 360s）预留空间，
// 墙钟仅为软目标——极端尾批可超 TOTAL_LIMIT_MS 约 300s，由 Synthesize 绝对闸门 + render-md 降级兜底。
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
const { fetchTargets, dupes, budgetDropped } = allocateFetchBudget(boardURLMap, MAX_FETCH)
log('Dedup: ' + dupes.length + ' dupes, ' + budgetDropped.length + ' budget-dropped, fetching ' + fetchTargets.length)

// ─── Phase Fetch + Extract ───
phase('Fetch')
const extracted = []
const FETCH_BATCH = 6
for (const batch of chunkArr(fetchTargets, FETCH_BATCH)) {
  if (!budgetGate('Fetch').ok) { log('BUDGET-BREAK Fetch 余批跳过，用已完成批次结果'); break }
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
// 8/20 第十六项：vtimeout 取固定 AGENT_TIMEOUT_MS，与 room 无关；批间 BREAK 仍每批重算 budgetGate('Verify')
// （下循环首行）——墙钟守护留在批次边界，不进入单代理超时。缓冲保留以为末批（固定 360s）留空间；墙钟是软目标，尾批可超 TOTAL_LIMIT_MS 约 300s，由 synthAllowed 绝对闸门兜底。
for (const batch of chunkArr(rankedClaims, VERIFY_BATCH)) {
  const gate = budgetGate('Verify')
  if (!gate.ok) { log('BUDGET-BREAK Verify 余批跳过，用已完成批次结果'); break }
  const vtimeout = AGENT_TIMEOUT_MS
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
const REPORT_DAY = normalizeDate(DATE)
const MAX_SEED_AGE_DAYS = 21
const freshSeeds = filterSeedsByAge(KNOWN_MAJOR_OUT, REPORT_DAY, MAX_SEED_AGE_DAYS)
const agedOut = KNOWN_MAJOR_OUT.length - freshSeeds.length
for (const m of freshSeeds) _addMajor(m, 'labs')
log('SEED-AGE: 注入 ' + freshSeeds.length + ' / ' + KNOWN_MAJOR_OUT.length + ' 种子（' + agedOut + ' 超期退役，阈值 ' + MAX_SEED_AGE_DAYS + 'd）' + (REPORT_DAY == null ? ' · REPORT_DAY unknown → fail-open 全注入' : ''))
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
}), { label: 'report', phase: 'Synthesize', schema: REPORT_SCHEMA, timeoutMs: 600000 }, 1) : null

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