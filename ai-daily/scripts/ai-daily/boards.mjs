// ai-daily 花名册与静态配置 — 与 workflow 内逐字节一致。真源；加厂商/改种子只改此文件。

// ─── Deterministic coverage: 9 boards × roster ───
export const BOARDS = [
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

export const OFFICIAL_FEEDS = [
  { url: 'https://openai.com/news/rss.xml', label: 'OpenAI News' },
  { url: 'https://www.anthropic.com/news', label: 'Anthropic News' },
  { url: 'https://x.ai/news', label: 'xAI News' },
  { url: 'https://research.google/blog/rss/', label: 'Google Research Blog' },
  { url: 'https://blogs.nvidia.com/feed/', label: 'NVIDIA Blog' },
  { url: 'https://ai.meta.com/blog/', label: 'Meta AI Blog' },
]

// 种子"重大超窗事实"（行业里程碑级公认事件，即使不在窗口也应出现在正文，标注 [窗口外·重大]）：
// 发现代理通过 majorOutOfWindow 字段上报更多此类事实。
export const KNOWN_MAJOR_OUT = [
  { name: 'OpenAI 预告 Astra 旗舰模型（解决 10 个长期开放数学难题）', date: '2026-08-02', note: 'OpenAI 公开预告下一个旗舰模型 Astra，宣称已解决 10 个长期开放数学难题，具体发布日期待官方确认（来源：多家媒体 2026-08-02，日期为预告日）。' },
  { name: 'DeepSeek V4-Pro 正式版上线（Agent 能力增强）', date: '2026-08-13', note: 'DeepSeek 官方 news 页登记 DeepSeek-V4-Pro 正式版上线 2026/08/13，App/网页/API 全面开放，强化 Agent 能力并引入分时段峰值定价；网易 08-16 报道印证 2026-08-17 价格生效（双源）。' },
]

// labs 花名册跨板块校正别名表：发现代理可能过报 no_news，已确认声明/来源标题命中别名即翻转 has_dynamic。
export const LABS_ALIASES = [
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
export const GROUPS_RAW = [
  { key: 'official', label: '官方实验室（OpenAI/Anthropic/xAI/Google/NVIDIA/Meta）', test: u => OFFICIAL_FEEDS.some(f => normURL(f.url) === normURL(u)) },
  { key: 'cn-media', label: '中文媒体（量子位/36氪）', test: u => /qbitai|36kr/i.test(u) },
  { key: 'en-media', label: '英文媒体（TechCrunch/The Verge）', test: u => /techcrunch|theverge/i.test(u) },
  { key: 'opensource', label: '开源/模型仓库（HuggingFace）', test: u => /huggingface/i.test(u) },
  { key: 'academic', label: '学术（arXiv）', test: u => /arxiv/i.test(u) },
]

// 分组发现（8/15 第九项优化）：labs / opensource / academic 单板专代理；6 个媒体/垂类板合并为
// media-cn 与 media-en 两组。
export const DISCOVER_GROUPS_ALL = [
  { key: 'labs', label: '头部实验室', boards: ['labs'], xBudget: 5 },
  { key: 'opensource', label: '开源与工具链', boards: ['opensource'], xBudget: 3 },
  { key: 'academic', label: '学术研究', boards: ['academic'], xBudget: 3 },
  { key: 'media-cn', label: '中文媒体（量子位/36氪）', boards: ['strategy', 'funding', 'policy', 'safety', 'people'],
    feeds: ['https://www.qbitai.com/', 'https://36kr.com/'], xBudget: 4 },
  { key: 'media-en', label: '英文媒体（TechCrunch/The Verge/qbitai）', boards: ['strategy', 'products', 'funding', 'policy'],
    feeds: ['https://techcrunch.com/category/artificial-intelligence/', 'https://www.theverge.com/ai-artificial-intelligence/', 'https://www.qbitai.com/'], xBudget: 4 },
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
 * @returns {Map<string,{degraded:boolean, missing:boolean}>}
 */
export const computeBoardStates = (rows, boardKeys) => {
  const returnedGroups = new Set((rows || []).map(r => r?.group?.key).filter(Boolean))
  const degradedGroups = new Set((rows || []).filter(r => r?.degraded).map(r => r.group.key))
  const m = new Map()
  for (const key of boardKeys) {
    const groups = groupKeyByBoard.get(key) || new Set()
    const anyReturned = [...groups].some(g => returnedGroups.has(g))
    const anyFailedGroup = [...groups].some(g => !returnedGroups.has(g))
    const anyDegradedGroup = [...groups].some(g => degradedGroups.has(g))
    const missing = groups.size > 0 && !anyReturned            // 所有归属组全部失败
    const degraded = anyFailedGroup || anyDegradedGroup          // 任一组失败 或 任一返回组自降级
    m.set(key, { degraded, missing })
  }
  return m
}

// normURL 在 date-utils.mjs；boards.mjs 的 GROUPS_RAW.test 闭包需要它，这里前向声明由 build.mjs 整时保证顺序。
// 直接 import 供 node 环境用；build.mjs inline 时剥掉 import 行（workflow 内 normURL 已在上文定义）。
import { normURL } from './date-utils.mjs'
