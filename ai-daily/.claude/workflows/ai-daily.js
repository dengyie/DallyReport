// ai-daily — Comprehensive AI daily report workflow.
// Deterministic 9-board × roster coverage → grok-search/X/RSS discovery →
// fetch+extract falsifiable claims → 3-vote adversarial verification →
// coverage self-check (script-computed) → synthesis → write artifacts to disk.
//
// Ported from the built-in deep-research harness, restructured to fix its
// coverage blind spots (LLM-free-generated angle queries, single search tool,
// whitelist-only big-company query) and to persist artifacts.

export const meta = {
  name: 'ai-daily',
  description: 'Comprehensive AI daily report — deterministic coverage, adversarial verification, cited, saved to disk',
  whenToUse: 'Run the daily AI news report for a date. Args: { date, window:{from,to}, outDir, boards?, maxFetch?, maxVerify? }',
  phases: [
    { title: 'Harvest', detail: 'Unique feeds fetched once into compact digests' },
    { title: 'Discover', detail: 'Boards mined via injected digest + grok-search X + WebSearch supplement' },
    { title: 'Fetch', detail: 'Extract falsifiable claims with quotes/dates' },
    { title: 'Verify', detail: '3-vote adversarial verification per claim' },
    { title: 'Synthesize', detail: 'Coverage self-check + report + write artifacts' },
  ],
}

// ─── Config ───
const VOTES_PER_CLAIM = 3
const REFUTATIONS_REQUIRED = 2
// 8/14 优化（速率优先）：源预算整体下调——数据源更少 → 大头阶段（fetch/verify）代理数约 -50%。
// MAX_FETCH 48→20、MAX_VERIFY 48→24、每板候选 URL 12→6；fetch 预算改为板间轮询公平分配（见下），保证晚序板块不被挤掉。
const MAX_FETCH = typeof args.maxFetch === 'number' && args.maxFetch > 0 ? args.maxFetch : 20
const MAX_VERIFY = typeof args.maxVerify === 'number' && args.maxVerify > 0 ? args.maxVerify : 24
const MAX_URLS_PER_BOARD = 6
// 单代理最大存活时长。deepseek 网关偶发"发了工具结果后模型再无回复"的静默卡死：
// 没有此上限时一个卡死代理会永久挡住整个 parallel/pipeline 闸门（实测 >10min 无产出）。
// 超时 → 视作 null → safeAgent 会用全新代理重试一次，而非无限等待。
// 默认 8 分钟：实测健康 discover 代理（8 次 X 搜索批量）约需 6 分钟，给足余量避免误杀；
// 更大跑（9 板、网关拥堵）用 agentTimeoutMs: 480000 或更高覆盖。
const AGENT_TIMEOUT_MS = typeof args.agentTimeoutMs === 'number' && args.agentTimeoutMs > 0 ? args.agentTimeoutMs : 480000

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

// ─── Schemas ───
const DISCOVER_SCHEMA = {
  type: 'object', required: ['urls', 'noNews'],
  properties: {
    urls: { type: 'array', maxItems: MAX_URLS_PER_BOARD, items: {
      type: 'object', required: ['url', 'title', 'found_via', 'date'],
      properties: { url: { type: 'string' }, title: { type: 'string' }, found_via: { type: 'string' }, date: { type: 'string' } },
    }},
    noNews: { type: 'array', items: { type: 'string' } },
    nearWindow: { type: 'array', items: { type: 'object', required: ['name', 'note'], properties: { name: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' } } } },
    majorOutOfWindow: { type: 'array', items: { type: 'object', required: ['name', 'date', 'note'], properties: { name: { type: 'string' }, date: { type: 'string' }, note: { type: 'string' } } } },
    degraded: { type: 'boolean' },
  },
}
const HARVEST_SCHEMA = {
  type: 'object', required: ['entries', 'recent'],
  properties: {
    entries: { type: 'array', maxItems: 15, items: {
      type: 'object', required: ['date', 'title', 'url'],
      properties: { date: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' } },
    }},
    recent: { type: 'array', maxItems: 4, items: {
      type: 'object', required: ['date', 'title', 'url', 'note'],
      properties: { date: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, note: { type: 'string' } },
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
// 落盘确认：writer 代理写完必须返回它实测到的路径与字节数，workflow 据此校验，杜绝"网关断流→假失败/假成功"。
const WRITE_RESULT_SCHEMA = {
  type: 'object', required: ['path', 'bytes'],
  properties: { path: { type: 'string' }, bytes: { type: 'number' }, note: { type: 'string' } },
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
const boards = BOARDS_SELECTED ? BOARDS.filter(b => BOARDS_SELECTED.has(b.key)) : BOARDS

// ─── Helpers ───
const URL_HOST_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\\]*@)?(?:www\.)?([^/:?#@\\]+)(?::\d+)?([^?#]*)/i
const normURL = u => { const m = String(u).match(URL_HOST_PATTERN); return m ? (m[1] + m[2].replace(/\/$/, '')).toLowerCase() : String(u).toLowerCase() }
const hostOf = u => (String(u || '').match(URL_HOST_PATTERN)?.[1] || 'unknown').toLowerCase()
const impRank = { central: 0, supporting: 1, tangential: 2 }
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }

// ─── Window gate + resilience helpers ───
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
const WIN_FROM = WFROM ? normalizeDate(WFROM) : null
const WIN_TO = normalizeDate(WTO || DATE)
const claimWindow = c => {
  const cands = [c.publishDate, c.date].map(normalizeDate).filter(x => x != null)
  if (!cands.length) return 'unknown'
  return cands.every(x => x >= WIN_FROM && x <= WIN_TO) ? 'in' : 'out'
}
const TRANSIENT = /(422|429|5\d\d|524|timeout|timed out|model not found|upstream|gateway|cloudflare)/i
const withDeadline = p => new Promise(resolve => {
  let done = false
  const settle = v => { if (!done) { done = true; clearTimeout(to); resolve(v) } }
  const to = setTimeout(() => { log('agent 超时 ' + Math.round(AGENT_TIMEOUT_MS / 1000) + 's 无产出 → 视为失败，将用全新代理重试'); settle(null) }, AGENT_TIMEOUT_MS)
  p.then(v => settle(v), () => settle(null))
})
const safeAgent = async (p, o, tries = 2) => {
  for (let i = 0; i < tries; i++) {
    let r = null
    try { r = await withDeadline(agent(p, o)) } catch (e) {
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
const chunkArr = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }

// 种子"重大超窗事实"（行业里程碑级公认事件，即使不在窗口也应出现在正文，标注 [窗口外·重大]）：
// 发现代理通过 majorOutOfWindow 字段上报更多此类事实。
const KNOWN_MAJOR_OUT = [
  { name: 'DeepSeek V4 Pro / V4 Flash 开源', date: '2026-07-31', note: 'MIT 协议开源，参数规模全球最大开源模型之一，社区广泛采用。' },
  { name: 'DeepSeek Harness 团队组建', date: '2026-07', note: 'DeepSeek 组建 Harness 团队，构建对标 Claude Code 的 agent 包装层（Model+Harness=Agent），桌面 agent 开发中。' },
  { name: 'Grok 4.6 发布', date: '2026-07下旬', note: 'xAI 发布 Grok 4.6 旗舰模型，客观事实（发布日期以 xAI 官方为准，此处为近似）。' },
]

log('Q: 生成 ' + WINDOW_LABEL + ' 窗口的 AI 日报（' + boards.length + ' 个板块）')

// ─── Phase Harvest: 每个唯一 feed 只抓一次 → 紧凑 digest → 注入 discover prompt ───
// 实测证据：让 discover 代理自己逐 feed 跑 fetch.js（labs 23 家 × 12KB 输出 + 中间推理轮），
// 单个 discover transcript 冲到 160-256KB。改为：主流程用独立 harvest 代理预抓唯一 feed 一次（去重
// 后 techcrunch/qbitai 等共享源只抓一遍，不再被 6 个板块各抓一遍），产出紧凑 digest 文本注入每个
// discover 的 prompt；discover 代理整个移除 fetch.js，上下文结构上封顶（= digest + 少量 X 搜索）。
const OFFICIAL_FEEDS = [
  { url: 'https://openai.com/news/rss.xml', label: 'OpenAI News' },
  { url: 'https://www.anthropic.com/news', label: 'Anthropic News' },
  { url: 'https://x.ai/news', label: 'xAI News' },
  { url: 'https://research.google/blog/rss/', label: 'Google Research Blog' },
  { url: 'https://blogs.nvidia.com/feed/', label: 'NVIDIA Blog' },
  { url: 'https://ai.meta.com/blog/', label: 'Meta AI Blog' },
]
const DENSE_FEEDS = new Set(['arxiv.org/list/cs.ai/recent', 'arxiv.org/list/cs.cl/recent', 'huggingface.co/papers'])
const feedMaxChars = feed => DENSE_FEEDS.has(normURL(feed.url)) ? 24000 : 12000
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
const HARVEST_PROMPT = feed =>
  '## 共享源 Harvest\n\n窗口：' + WINDOW_LABEL + '。抓取该共享新闻源并提炼紧凑摘要：\n\n' +
  '**Feed URL:** ' + feed.url + '\n\n' +
  '## 执行\n' +
  '1. 运行：cd ' + GROK_DIR + " && ./scripts/fetch.js --max-chars " + feedMaxChars(feed) + " '" + feed.url + "'\n" +
  '2. **只看返回的 sources 里的 url/title/date 卡片，不看 answer.text（模型旧知识，不可作新闻依据）。**\n' +
  '3. 保留日期落在 [' + WFROM + ', ' + (WTO || DATE) + '] 内的条目，最多 15 条，写入 entries（date/title/url，URL 写完整，标题保留关键信息）。日期拿不准的按页面/条目标注作最佳估计。\n' +
  '4. 日期在窗口前（窗口首日前约 7 天内）但属**重大发布/官宣**（行业里程碑级：旗舰模型、重大开源、重大战略）的，挑最多 4 条写入 recent（date/title/url/note，note 一句话说明为何重大）。普通旧新闻不写。\n' +
  '5. 抓取失败/空源/全部无关 → 返回 { entries: [], recent: [], failed: true }。\n' +
  '6. 纪律：严格使用命令里给定的 --max-chars，禁止改大或去掉；禁止传递 --full-path（防止泄露完整文件路径）；禁止读取 .cache/grok-search/outputs/ 下的任何完整文件；一次抓取一次返回，不反复重抓；不要逐条打开链接。\n\nStructured output only.'
const harvestResults = await parallel(uniqueFeeds.map(f => () =>
  safeAgent(HARVEST_PROMPT(f), { label: 'harv:' + hostOf(f.url), phase: 'Harvest', schema: HARVEST_SCHEMA }, 2)
    .then(r => r ? { feed: f, entries: (r.entries || []).slice(0, 15), recent: (r.recent || []).slice(0, 4), failed: !!r.failed } : { feed: f, entries: [], recent: [], failed: true })
))
const digestByKey = new Map()
for (const h of harvestResults) digestByKey.set(normURL(h.feed.url), h)
const digestForBoard = board => {
  const keys = []
  for (const f of (board.feeds || [])) keys.push(normURL(f))
  for (const c of (board.companies || [])) if (c.feed) keys.push(normURL(c.feed))
  if (board.key === 'labs') for (const f of OFFICIAL_FEEDS) keys.push(normURL(f.url))
  const parts = []
  for (const k of [...new Set(keys)]) {
    const h = digestByKey.get(k)
    if (!h) continue
    const head = '**' + (h.feed.label || h.feed.url) + '**（' + h.feed.url + '）'
    if (h.failed) { parts.push(head + ' — 抓取失败（可用 X 搜索/WebSearch 补）'); continue }
    const rows = (h.entries || []).map(e => '- [' + (e.date || '?') + '] ' + e.title + ' | ' + e.url).join('\n')
    const rec = (h.recent || []).length ? '\n  【近窗口·重大候选】' + h.recent.map(r => '[' + (r.date || '?') + '] ' + r.title + (r.note ? '（' + r.note + '）' : '') + ' | ' + r.url).join('\n  ') : ''
    parts.push(head + '\n' + (rows || '  （窗口内无条目）') + rec)
  }
  return parts.join('\n')
}
log('Harvest: ' + uniqueFeeds.length + ' unique feeds harvested → digests ready')

// ─── Phase Discover ───
phase('Discover')
const discovered = await pipeline(
  boards,
  board => agent('## 板块发现代理：' + board.title + '\n\n窗口：' + WINDOW_LABEL + '。为日报采集本板块窗口内可信可核实的新闻 URL。\n' +
    '⚠️ 关键纪律：搜索脚本的输出里 answer.text 是模型旧知识总结（训练截止点可能早于窗口！），绝不可作为新闻判断依据；只采信 sources 里的 URL 卡片（sources.grok / sources.merged 的 url/title/date）与下方**板块共享源摘要**（已由主流程预抓，可信）。官方渠道官宣的新模型/新发布通常不在模型知识里——要靠下方摘要与 X 官方源找到。\n\n' +
    '板块定义：\n' + JSON.stringify({ focus: board.focus, companies: board.companies || null, feeds: board.feeds || null, xHandles: board.xHandles || null }, null, 1) + '\n\n' +
    '## 板块共享源摘要（已预抓，直接采信；**禁止再运行 fetch.js**）\n' + digestForBoard(board) + '\n\n' +
    '## 执行\n' +
    '1)【主干·必做】通读上方共享源摘要，保留窗口 ' + WFROM + '~' + (WTO || DATE) + ' 内、有新闻价值的条目（标题/URL/日期已给全）。**不要运行 fetch.js**——feed 内容已内置于本 prompt。' +
    (board.key === 'labs' ? ' labs 板块必须逐家核厂商：先核对摘要里每家是否有动态；摘要未覆盖、或需 X 官宣确证的公司走第 2 步批量 X 搜索确认。' : '') + '\n' +
    '2)【X 搜索·补充】对摘要未覆盖、或需官方发布确证的公司/主题：cd ' + GROK_DIR + " && ./scripts/search.js --days 3 --no-extra --source-chars 300 --max-chars 5000 --responses-x-search --responses-allowed-x-handles '<handle,逗号,串联>' '<公司> 发布/官宣 '" + '；只看返回的 URL 卡片（sources 里的 url/title/date），不看 answer.text。**批量优先**：每次查询携带 4-6 个 allowed-x-handles（逗号串联）一次覆盖多家，labs 板块用 4-7 次批量查询覆盖所有摘要未覆盖的公司。\n' +
    '3)【WebSearch 补充】仍缺的：WebSearch `<公司/关键词> 新闻 ' + WTO + '`（不可用就跳过，勿失败）。\n' +
    '4) 只保留事件日期落在 [' + WFROM + ', ' + (WTO || DATE) + '] 内的；优先一手官方源；跳过无日期/明显陈旧/SEO/内容农场/常青帮助文档页。URL 写完整。\n' +
    '最多返回 ' + MAX_URLS_PER_BOARD + ' 条 url/title/found_via/date。labs 板块逐家核厂商——确认窗口内无任何动态的，把公司名放 noNews。' +
    '5) 若某公司本窗口无动态、但近 2 周内有重大发布/官宣/可信事实（如 DeepSeek V4 开源、Grok 4.6 发布、DeepSeek Harness 这类**行业客观公认事实**），将其列入 majorOutOfWindow（name/date/note），供日报正文以「[窗口外·重大]」标签呈现。注意：majorOutOfWindow 只放**客观事实**（非传闻、非推测），且必须是**行业里程碑级**——如果是普通更新或次要动态，放 nearWindow 供窗口外参考节引用即可。' +
    '6)【预算·硬性纪律】X 搜索 labs 板块 ≤8 次、其余板块 ≤6 次，一家一次尝试、无果即放 noNews、不反复深挖；WebSearch 全板块合计 ≤10 次，不可用即跳过、勿失败。**发现阶段禁止运行 fetch.js**。输出只保留用于抓取/核查的高置信候选，超过上限按重要性截断。' +
    'degraded 语义：仅当本板块的【主源/官方通道】整体一无所获（摘要 + X 搜索均返回零个可用 URL）时才置 true；个别补充源（GitHub trending、WebSearch、某一 X 搜索等）失败不算 degraded，正常返回即可。尽力用可用渠道，不要整任务失败。' +
    '\n\nStructured output only.',
    { label: 'disc:' + board.key, phase: 'Discover', schema: DISCOVER_SCHEMA }
  ).then(r => r ? { board: board.key, title: board.title, urls: r.urls || [], noNews: r.noNews || [], nearWindow: r.nearWindow || [], majorOutOfWindow: r.majorOutOfWindow || [], degraded: !!r.degraded } : null)
)

const discoverRows = (discovered.filter(Boolean))
log('Discover: ' + discoverRows.length + ' boards done, ' + discoverRows.reduce((n, d) => n + d.urls.length, 0) + ' raw URLs')

// ─── Dedup + fetch budget（板间公平）───
// 旧实现按 boards 顺序消耗全局 quota，预算收紧后 labs/strategy 会把 policy/safety/people 整体挤掉。
// 改为轮询分配：每轮每板块至多取 1 个未抓 URL，直到 MAX_FETCH 耗尽——保证 9 个板块雨露均沾。
const dupes = []
const budgetDropped = []
const seen = new Map()
let fetchSlots = MAX_FETCH
const fetchTargets = []
const boardURLs = discoverRows.map(row => ({ board: row.board, urls: row.urls.filter(u => u && u.url) }))
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
log('Dedup: ' + dupes.length + ' dupes, ' + budgetDropped.length + ' budget-dropped, fetching ' + fetchTargets.length)

// ─── Phase Fetch + Extract ───
phase('Fetch')
const FETCH_PROMPT = src =>
  '## Source Extractor\n\n窗口：' + WINDOW_LABEL + '。抓取并提取该来源的可证伪声明：\n' +
  '**URL:** ' + src.url + '\n**Title:** ' + src.title + '\n**Found via:** ' + src.board + ' / ' + src.found_via + '\n\n' +
  '## Task\n' +
  '1. 用 WebFetch 抓取页面。\n2. 判定来源质量：primary(官方/一手) / secondary(主流媒体报道) / blog / forum / unreliable。\n' +
  '3. 提取 2-3 条与本板块日报问题相关、可核实、具体的声明（非空泛结论）；每条必须带原文引语 quote（截取关键一句，≤40 字）、重要性 central/supporting/tangential。\n' +
  '4. 注明页面/事件日期 publishDate（YYYY-MM-DD 或 MM-DD）；无日期则空。\n' +
  '5. 页面较长时只精读与日报相关且日期在窗口内的部分，其余快速略读；抓取失败/付费墙/无关页面 → 返回 claims:[] 且 sourceQuality:"unreliable"。\n\nStructured output only.'

const extracted = []
const FETCH_BATCH = 6
for (const batch of chunkArr(fetchTargets, FETCH_BATCH)) {
  const batchRes = await parallel(batch.map(src => () =>
    safeAgent(FETCH_PROMPT(src), { label: 'fetch:' + hostOf(src.url), phase: 'Fetch', schema: EXTRACT_SCHEMA }, 2)
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
  for (const k of byResidual) {
    if (remainV <= 0) break
    const canTake = Math.min(claimsByBoard.get(k).length - quota.get(k), remainV)
    quota.set(k, quota.get(k) + canTake); remainV -= canTake
  }
  // 第二轮：把欠配板块让出的剩余额度，继续分配给超额（claim 多于配额）的板块，避免整个核查池浪费。
  for (const k of byResidual) {
    if (remainV <= 0) break
    const canTake = Math.min(claimsByBoard.get(k).length - quota.get(k), remainV)
    if (canTake > 0) { quota.set(k, quota.get(k) + canTake); remainV -= canTake }
  }
}
const rankedClaims = []
for (const k of boardKeysV) rankedClaims.push(...claimsByBoard.get(k).slice(0, quota.get(k)))
log('Verify: ' + rankedClaims.length + ' claims across ' + boardKeysV.length + ' boards [' + [...quota.entries()].map(e => e[0] + ':' + e[1]).join(' ') + '], ' + VOTES_PER_CLAIM + ' votes each')
phase('Verify')

const VERIFY_PROMPT = c =>
  '## 对抗性核查票 ' + '(voter)\n\n' +
  '请对下列声明持怀疑态度，尝试证伪。≥' + REFUTATIONS_REQUIRED + '/' + VOTES_PER_CLAIM + ' 票证伪即否决。\n\n' +
  '窗口：' + WINDOW_LABEL + '。\n\n## 声明\n' + '"' + c.claim + '"\n\n来源：' + c.sourceUrl + ' (' + c.sourceQuality + ')，页面日期：' + (c.publishDate || '未知') + '，条目标注日期：' + (c.date || '未知') + '\n引语："' + c.quote + '"\n\n## 清单\n' +
  '1. 声明是否被引语真正支撑，还是过度引申？\n2. 时效：**窗口为 [' + (WFROM || DATE) + ', ' + (WTO || DATE) + ']**。事件/发布日期明显在窗口外（数天前/数周前/上月）→ refuted=true；页面日期在窗口内但内容陈述的是旧事件，按**事件实际发生日**判定，日期明确超窗仍 → refuted=true；无法判定日期则不因时效否决。\n3. 来源质量与声明强度是否匹配？（惊人声明需一手源）\n4. 是否营销话术/吹嘘/标题党/论坛猜测？（→ refuted=true）\n\n5. **禁止使用 WebSearch/WebFetch 等外部搜索工具**——本核查只依据上面给出的引语/来源/日期/声明做内部一致性判断，外部搜索会烧掉大量 token。\n\n默认 refuted=true，除非证据充分支撑。\n\nStructured output only. Evidence 简短具体（≤80 字）。'

const MAX_VOTE_ROUNDS = 2
const voteClaim = async c => {
  const valid = []
  let agentFails = 0  // 真正的代理失败（null）数；与"够票早停"分开，避免把主动停算成 error
  for (let r = 0; r <= MAX_VOTE_ROUNDS && valid.length < VOTES_PER_CLAIM; r++) {
    const need = VOTES_PER_CLAIM - valid.length
    const round = await parallel(Array.from({ length: need }, (_, v) => () =>
      safeAgent(VERIFY_PROMPT(c), { label: 'v' + (valid.length + v) + ':' + c.claim.slice(0, 30), phase: 'Verify', schema: VERDICT_SCHEMA }, 2)
    ))
    agentFails += round.filter(x => !x).length
    valid.push(...round.filter(Boolean))
    if (valid.filter(x => x.refuted).length >= REFUTATIONS_REQUIRED) break
  }
  const refuted = valid.filter(x => x.refuted).length
  const errored = agentFails
  const survives = valid.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED
  const isRefuted = refuted >= REFUTATIONS_REQUIRED
  log((survives ? '✓' : isRefuted ? '✗' : '?') + ' ' + c.claim.slice(0, 46) + ' — ' + (valid.length - refuted) + '-' + refuted + (errored ? ' (' + errored + '×err)' : ''))
  return { ...c, verdicts: valid, refutedCount: refuted, erroredCount: errored, survives, isRefuted }
}
const voted = []
const VERIFY_BATCH = 6
for (const batch of chunkArr(rankedClaims, VERIFY_BATCH)) {
  const batchRes = await parallel(batch.map(c => () => voteClaim(c)))
  voted.push(...batchRes.filter(Boolean))
}

const confirmedVerify = voted.filter(c => c.survives && claimWindow(c) !== 'out')
const confirmed = [...confirmedVerify]  // copy：后续 major-out 注入不许污染 confirmedVerify 计数（REPORT_PROMPT 分开统计）
const outOfWindow = voted.filter(c => c.survives && claimWindow(c) === 'out')
const killed = voted.filter(c => c.isRefuted)
const unverified = voted.filter(c => !c.survives && !c.isRefuted)
const toolError = voted.filter(c => c.erroredCount >= 2).length
log('Verify done: ' + voted.length + ' → ' + confirmedVerify.length + ' verified, ' + killed.length + ' refuted, ' + unverified.length + ' unverified')

// ─── 重大超窗事实注入：行业里程碑级公认客观事件，即使不在窗口也需出现在正文 ───
const majorOutClaims = []
const _mkMajor = (m, board) => ({
  claim: m.name + '：' + m.note, quote: m.note, sourceUrl: '(多源公认)', sourceTitle: '行业客观公认事实',
  date: m.date, board: board, publishDate: m.date, sourceQuality: 'primary', importance: 'central',
  verdicts: [], refutedCount: 0, erroredCount: 0, survives: true, isRefuted: false, isMajorOut: true, vote: '—',
  // verifiedByVote:false —— [窗口外·重大] 未经过窗口内对抗投票，reportBody 统一渲染 Vote: —（未投票），不得冒充 3-0。
})
// 同一事实的关键词指纹（取公司/产品名）：发现代理上报与 KNOWN 种子若指同一事件只保留一份（取日期更具体者）。
const _majorKey = name => { const t = String(name).toLowerCase(); if (/deepseek\s*v4|v4\s*(pro|flash)/.test(t)) return 'deepseek-v4'; if (/harness/.test(t)) return 'deepseek-harness'; if (/grok\s*4\.6|4\.6/.test(t) && /grok/.test(t)) return 'grok-4.6'; return String(name).toLowerCase().replace(/\s+/g, '') }
const _addMajor = (m, board) => {
  const k = _majorKey(m.name)
  const ex = majorOutClaims.find(x => _majorKey(x.claim.split('：')[0]) === k)
  if (ex) {
    const exHasDay = /\d{4}-\d{2}-\d{2}/.test(ex.date || ''); const newHasDay = /\d{4}-\d{2}-\d{2}/.test(m.date || '')
    if (newHasDay && !exHasDay) { ex.date = m.date; ex.publishDate = m.date; ex.claim = m.name + '：' + m.note; ex.quote = m.note }
    return
  }
  majorOutClaims.push(_mkMajor(m, board))
}
for (const d of discoverRows) for (const m of (d.majorOutOfWindow || [])) if (m && m.name) _addMajor(m, d.board)
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
// 板块发现代理整体失败（无任何返回）→ 该板块降级，厂商标记"未达"而非默认"有动态"。
const failedBoardKeys = new Set(boards.map(b => b.key).filter(k => !discoverRows.some(d => d.board === k)))
const coverage = boards.map(b => ({
  board: b.key, title: b.title,
  claims: boardClaimCount.get(b.key) || 0,
  urls: sources.filter(s => s.board === b.key).length,
  companiesChecked: b.companies ? b.companies.map(c => failedBoardKeys.has(b.key)
    ? { name: c.name, state: 'unreached', evidence: 'no_discover_agent' }
    : { name: c.name, state: noNewsSet.has(c.name) ? 'no_news' : 'has_dynamic', evidence: 'labs' }) : null,
  degraded: discoverRows.some(d => d.board === b.key && d.degraded) || failedBoardKeys.has(b.key),
}))

// ─── labs 花名册跨板块校正：发现代理可能过报 no_news。
// 任一已确认窗口内声明/来源标题命中公司别名 → 翻转为 has_dynamic（report_match）───
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

// ─── Phase Synthesize + write artifacts ───
phase('Synthesize')
const reportBody = (confirmed.length ? confirmed.map((c, i) =>
  '### ' + (c.isMajorOut ? '[窗口外·重大] ' : '') + '[' + i + '] ' + c.claim + '\nVote: ' + (c.isMajorOut ? '—（未投票，多源公认行业里程碑）' : (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount) + ' · Source: ' + c.sourceUrl + ' (' + c.sourceQuality + ') · Date: ' + (c.publishDate || c.date || '?') + '\nQuote: "' + c.quote + '"\n')
  .join('\n')
  : '(无已确认声明)')
const refutedList = killed.map(c => '- "' + c.claim + '" — ' + c.sourceUrl)
const unverifiedList = unverified.map(c => '- "' + c.claim + '" — ' + c.sourceUrl)
const coverBlock = coverage.map(c => '- ' + c.title + ': ' + c.claims + ' claims / ' + c.urls + ' sources' + (c.degraded ? ' [degraded]' : '') + (c.companiesChecked
  ? ' ; 公司覆盖(' + c.companiesChecked.length + '家): 有动态[' + c.companiesChecked.filter(x => x.state === 'has_dynamic').map(x => x.name).join('、') + '] 未发现动态[' + c.companiesChecked.filter(x => x.state === 'no_dynamic').map(x => x.name).join('、') + ']' + (c.companiesChecked.some(x => x.state === 'unreached') ? ' 未达[' + c.companiesChecked.filter(x => x.state === 'unreached').map(x => x.name).join('、') + ']' : '')
  : '')).join('\n')
const missLines = windowMisses.map(w => '- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note).join('\n')
const missBlock = windowMisses.length ? '\n## 窗口外参考（次要超窗项，须单列一节如实标注，不得混入正文）\n' + missLines : ''

const REPORT_PROMPT =
  '## 日报终稿合成\n\n窗口：' + WINDOW_LABEL + '。生成中文 AI 日报。' + confirmedVerify.length + ' 条声明通过 ' + VOTES_PER_CLAIM + ' 票对抗核查，另有 ' + majorOutClaims.length + ' 条行业公认重大事实（[窗口外·重大]，非窗口内、未经投票，但可入正文）。\n\n' +
  '## 已确认声明\n' + reportBody + '\n' +
  (killed.length ? '\n## 被否决声明（供透明参考，不得写入正文）\n' + refutedList.join('\n') : '') +
  (unverified.length ? '\n## 未验证声明（核查代理故障，只能进“待核实”小节）\n' + unverifiedList.join('\n') : '') +
  missBlock +
  '\n## 覆盖自检\n' + coverBlock + '\n\n## 要求\n' +
  '1. 语义去重、合并——**跨板块重复内容只保留一处**（以更权威来源为准），其余删除；按板块组织成 sections（board/title/items）。\n2. 每条 item：title、summary(2-3句中文)、confidence(高/中/低 按多源与投票)、sources(URL数组)、vote。**title 前必须标注核查状态**：已核查 `[3-0✓]`、未核查 `[未核查]`、否决 `[否决✗]`、超窗重大 `[窗口外·重大]`。\n' +
  '3. 头条与执行摘要 execSummary(3-5句) 与 oneLiner **只能基于已核查或 [窗口外·重大] 条目**；未核查条目一律放入”待核实”小节，不得混入头条；被否决条目不得写入正文。[窗口外·重大] 条目可出现在正文和执行摘要中，但须如实标注标签。\n' +
  '4. caveats：注明弱来源、时间敏感、未核查项；openQuestions 2-4 个。\n5. 若存在窗口外参考（非重大超窗项），在日报末尾单列”## 📎 窗口外参考”一节如实引用。\n\nStructured output only.'

const report = await safeAgent(REPORT_PROMPT, { label: 'report', phase: 'Synthesize', schema: REPORT_SCHEMA }, 2)

// ─── mdWriter agent writes the report Markdown (Write tool, verified reliable) ───
// JSON 归档不再走 writer 代理：base64 转录会被 LLM 损坏（曾导致 control-char 非法 JSON + 每失败代理烧 260KB）。
// 3 个 JSON 的 payload 字符串原样放进本返回值的 payloads.{claims,sources,meta}，由主会话（orchestrator）用 Write 工具逐字节落盘。
const degradedFlags = []
if (toolError > 0) degradedFlags.push('verify_agent_errors:' + toolError)
if (budgetDropped.length > 0) degradedFlags.push('fetch_budget_dropped:' + budgetDropped.length)
if (discoverRows.some(d => d.degraded) || failedBoardKeys.size > 0) degradedFlags.push('discovery_degraded' + (failedBoardKeys.size ? ':missing_' + [...failedBoardKeys].join('+') : ''))
let artifacts = []
const writeFailures = []
let reportErr = null
if (report) {
  const reportJson = JSON.stringify({ date: DATE, window: WINDOW_LABEL, oneLiner: report.oneLiner, execSummary: report.execSummary, sections: report.sections, caveats: report.caveats, openQuestions: report.openQuestions, windowMisses, coverage }, null, 1)
  const mdPath = OUT + '/' + DATE + '-ai日报.md'
  const mdWriter = await safeAgent(
    '把下面的日报数据结构渲染成一份高质量中文 Markdown 日报，写入文件（用 Write 工具，绝对路径）：' + mdPath + '\n\n' +
    '格式要求：# 🤖 AI 日报 · ' + DATE + '\n> 覆盖 ' + WINDOW_LABEL + ' 窗口…\n## 📌 今日一句话\n## 📄 执行摘要\n对每个 board 一节：### <标题> 下逐条 item：**标题**（[核查状态如 3-0✓ 或 窗口外·重大] 可信度）— 2-3 句要点 — *来源: URL(s)*\n## ⚠️ 待核实（未核查条目集中在此，不得混入正文）\n## ⚠️ 未验证与局限\n## 📎 窗口外参考（若数据中有 windowMisses）\n## ❓ 开放问题\n## ✅ 覆盖自检（今天核了哪些厂商/板块，各板块动态数）\n\n数据：\n' + reportJson +
    '\n\n写完用 Bash 实测：wc -c 得字节数；若你产生过任何临时/中间文件（_decoded.bin 等）一并删除，只留目标 md。\n' +
    '返回 {"path":"' + mdPath + '","bytes":<实测字节数>}。Structured output only.',
    { label: 'write-report', phase: 'Synthesize', schema: WRITE_RESULT_SCHEMA }, 2
  )
  if (mdWriter && mdWriter.path === mdPath && mdWriter.bytes > 0) artifacts.push(mdPath)
  else { writeFailures.push(DATE + '-ai日报.md'); log('WRITE-FAIL md bytes=' + (mdWriter && mdWriter.bytes)) }
} else {
  reportErr = 'report agent failed; reverting to raw archive'
  writeFailures.push(DATE + '-ai日报.md')
}

const claimsJson = JSON.stringify({ date: DATE, window: WINDOW_LABEL,
  confirmed: confirmed.map(c => ({ claim: c.claim, quote: c.quote, source: c.sourceUrl, sourceQuality: c.sourceQuality, date: c.publishDate || c.date, window: c.isMajorOut ? 'major-out' : claimWindow(c), vote: c.isMajorOut ? '—' : (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount, verifiedByVote: !c.isMajorOut, confidence: (c.verdicts.filter(v => !v.refuted)[0] || {}).confidence || (c.isMajorOut ? 'high' : 'low') })),
  refuted: killed.map(c => ({ claim: c.claim, source: c.sourceUrl, vote: (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount })),
  unverified: unverified.map(c => ({ claim: c.claim, source: c.sourceUrl })),
  outOfWindow: outOfWindow.map(c => ({ claim: c.claim, source: c.sourceUrl, date: c.publishDate || c.date, vote: (c.verdicts.length - c.refutedCount) + '-' + c.refutedCount })) }, null, 1)
// JSON 归档不再走 writer 代理（base64 转录会被 LLM 损坏，曾导致 control-char 非法 JSON + 每失败代理烧 260KB）。
// 改为：workflow 把 payload 原样返回 → 主会话用 Write 逐字节落盘（见下方 payloads 字段）。
const claimsPath = OUT + '/' + DATE + '.verified-claims.json'
const sourcesPath = OUT + '/' + DATE + '.sources.json'
const sourcesJson = JSON.stringify({ date: DATE, sources: sources.map(s => ({ url: s.url, title: s.title, board: s.board, found_via: s.found_via, sourceQuality: s.sourceQuality, publishDate: s.publishDate || s.date, claimCount: s.claims.length, confirmed: confirmed.filter(c => c.sourceUrl === s.url).length })) }, null, 1)

// 写盘失败标记必须在 metaJson 序列化前填入，否则归档 meta.json 的 degraded 会漏记 write_failed。
if (writeFailures.length > 0) degradedFlags.push('write_failed:' + writeFailures.join('+'))

const metaJson = JSON.stringify({
  date: DATE, window: { from: WFROM, to: WTO || DATE }, generated_by: 'ai-daily (deepseek-v4-flash)',
  boards: boards.length, urls_discovered: discoverRows.reduce((n, d) => n + d.urls.length, 0), urls_fetched: sources.length, claims_extracted: allClaims.length,
  claims_verified: voted.length, confirmed: confirmed.length, major_out: majorOutClaims.length, killed: killed.length, unverified: unverified.length, out_of_window_confirmed: outOfWindow.length,
  window_misses: windowMisses,
  url_dupes: dupes.length, fetches_dropped: budgetDropped.length, verify_agent_errors: toolError,
  degraded: degradedFlags, report_error: reportErr,
  // md_written 仅计 workflow 内确认写盘的产物（md，0/1）；3 个 JSON 由主会话按 payloads 逐字节落盘，其成败在 skill 层记录。
  md_written: artifacts.length, artifacts_failed: writeFailures,
  coverage: coverage, noNews_companies: noDynamicCompanies, covered_elsewhere_companies: [...matchedCompany],
  unreached_companies: coverage.map(c => (c.companiesChecked || []).filter(x => x.state === 'unreached').map(x => x.name)).flat(),
}, null, 1)
const metaPath = OUT + '/' + DATE + '.meta.json'
// JSON 产物：md 由 mdWriter 代理落盘（Write 工具，已验证可靠）；3 个 JSON 统一由主会话从本返回值逐字节写入。
artifacts.push(claimsPath, sourcesPath, metaPath)

return {
  date: DATE, window: WINDOW_LABEL, outDir: OUT, artifacts,
  payloads: { claims: claimsJson, sources: sourcesJson, meta: metaJson },
  stats: { boards: boards.length, urls_discovered: discoverRows.reduce((n, d) => n + d.urls.length, 0), urls_fetched: sources.length, claims_extracted: allClaims.length, claims_verified: voted.length, confirmed: confirmed.length, major_out: majorOutClaims.length, killed: killed.length, unverified: unverified.length },
  headline: report ? report.oneLiner : null,
  summary: report ? report.execSummary : (confirmed.length ? 'synthesis failed; ' + confirmed.length + ' verified claims archived' : 'no confirmed claims'),
  coverage: coverage,
  artifacts_failed: writeFailures,
  degraded: degradedFlags,
}