// ai-daily prompt 模板 — 与 workflow 内逐字节一致；闭包依赖收敛为 ctx 显式注入。
// ctx = { WINDOW_LABEL, WFROM, WTO, DATE, GROK_DIR, MAX_URLS_PER_BOARD, WEB_BUDGET_TOTAL, WEB_BUDGET_PER, feedMaxChars }
// build.mjs inline 后在 workflow 顶部构造同名常量 ctx 传入。

export const harvestPrompt = (g, ctx) =>
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
export const discoverPrompt = (g, ctx) => {
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

export const fetchPrompt = (src, ctx) =>
  '## Source Extractor\n\n窗口：' + ctx.WINDOW_LABEL + '。抓取并提取该来源的可证伪声明：\n' +
  '**URL:** ' + src.url + '\n**Title:** ' + src.title + '\n**Found via:** ' + src.board + ' / ' + src.found_via + '\n\n' +
  '## Task\n' +
  '1. 用 WebFetch 抓取页面。\n2. 判定来源质量：primary(官方/一手) / secondary(主流媒体报道) / blog / forum / unreliable。\n' +
  '3. 提取 2-3 条与本板块日报问题相关、可核实、具体的声明（非空泛结论）；每条必须带原文引语 quote（**逐字抄录支撑该声明的完整原句，≤220 字，且必须包含声明中的全部具体细节——日期/数字/机构名/对比结论**，只截 40 字短句会导致核查票无据可依而误否决）、重要性 central/supporting/tangential。\n' +
  '4. 注明页面/事件日期 publishDate（YYYY-MM-DD 或 MM-DD）；无日期则空。\n' +
  '5. 页面较长时只精读与日报相关且日期在窗口内的部分，其余快速略读；抓取失败/付费墙/无关页面 → 返回 claims:[] 且 sourceQuality:"unreliable"。\n\nStructured output only.'

// verifyPrompt 需要 VOTES_PER_CLAIM/REFUTATIONS_REQUIRED，经 ctx 传入。
export const verifyPrompt = (c, ctx) =>
  '## 对抗性核查票 ' + '(voter)\n\n' +
  '请对下列声明持怀疑态度，尝试证伪。≥' + ctx.REFUTATIONS_REQUIRED + '/' + ctx.VOTES_PER_CLAIM + ' 票证伪即否决。\n\n' +
  '窗口：' + ctx.WINDOW_LABEL + '。\n\n## 声明\n' + '"' + c.claim + '"\n\n来源：' + c.sourceUrl + ' (' + c.sourceQuality + ')，页面日期：' + (c.publishDate || '未知') + '，条目标注日期：' + (c.date || '未知') + '\n引语："' + c.quote + '"\n\n## 清单\n' +
  '1. 引语是**逐字抄录的完整支撑句**（契约要求覆盖声明全部细节——日期/数字/机构/对比）。声明中的细节凡能在引语中逐字溯源即视为被支撑；仅当声明断言明显超出引语范围（引语只谈 X 却断言 Y）才算过度引申。引语不是全文≠证据不足，勿因引语未铺陈全背景而否决。\n2. 时效：**窗口为 [' + (ctx.WFROM || ctx.DATE) + ', ' + (ctx.WTO || ctx.DATE) + ']**。事件/发布日期明显在窗口外（数天前/数周前/上月）→ refuted=true；页面日期在窗口内但内容陈述的是旧事件，按**事件实际发生日**判定，日期明确超窗仍 → refuted=true；无法判定日期则不因时效否决。\n3. 来源质量与声明强度是否匹配？（惊人声明需一手源）\n4. 是否营销话术/吹嘘/标题党/论坛猜测？（→ refuted=true）\n\n5. **禁止使用 WebSearch/WebFetch 等外部搜索工具**——本核查只依据上面给出的引语/来源/日期/声明做内部一致性判断，外部搜索会烧掉大量 token。\n\n默认 refuted=true，除非证据充分支撑。\n\nStructured output only. Evidence 简短具体（≤80 字）。'

// reportPrompt 需要编排层预拼的 reportBody/refutedList/unverifiedList/missBlock/coverBlock 与统计数，经 ctx 传入。
export const reportPrompt = ctx =>
  "## 日报终稿 —— 新闻编辑简报\n\n窗口：" + ctx.WINDOW_LABEL + "。下面是一篇 AI 日报的原始素材：" + ctx.confirmedVerifyCount + " 条已核查声明（对抗式 2+1 票验证），" + ctx.majorOutCount + " 条行业公认重大事实（[窗口外·重大]，超窗未投票但可入正文）。\n\n" +
  "你的任务：把它们写成一篇**真正可读的中文 AI 日报**。\n\n" +
  "## 原始素材\n" + ctx.reportBody + "\n" +
  (ctx.killedCount ? "\n## 被否决声明（不写入正文）\n" + ctx.refutedList : "") +
  (ctx.unverifiedCount ? "\n## 未验证声明（核查代理故障，只能进“待核实”小节）\n" + ctx.unverifiedList : "") +
  ctx.missBlock +
  "\n## 覆盖自检\n" + ctx.coverBlock + "\n\n## 编辑要求\n" +
  "0. **禁止调用任何工具**（禁 WebFetch、WebSearch、Read、curl 及一切工具调用）——只做纯推理合成；一旦发起工具调用即视为失败。\n\n" +
  "1. **先筛选，再写稿**：通读全部素材，选出今天**真正值得报道的 2-3 条头条**（正式发布/官宣/大额融资/监管裁决/里程碑）。其余素材按板块归类，不重要的（小更新/营销话术/旧闻重复）**直接 discard 不进正文**。宁缺毋滥。\n\n" +
  "2. **oneLiner（今日一句话）**：用一句话概括今天 AI 行业最重要的事——像新闻快讯标题，不是笼统总结。\n\n" +
  "3. **execSummary（执行摘要）**：3-5 句，按重要性排序，写成一个连贯段落（不是分点列项）。每句对应一条重要新闻，写清楚谁做了什么+结果。\n\n" +
  "4. **sections / items**：\n" +
  "   - title：**新闻式标题**（≤25字，主语+动词+结果/数字，例：Stripe $7.5B 收购 OpenRouter）。**不要前置 [窗口外·重大]/[2-0✓] 等标签**，不要长从句，不要括号解释。\n" +
  "   - summary：**一段新闻正文**（2-3 句），写清楚发生了什么、为什么重要，不是重复 title。\n" +
  "   - status：核查状态，取值为 已核查 2-0 / 已核查 2-1 / [窗口外·重大] / 未核查 / 已否决（render 会在标题后加徽标）\n" +
  "   - 多个 sources 时只保留最权威的 1-2 个 URL。\n\n" +
  "5. **板块组织**：不要机械按来源分板。如果某板块今天无重要新闻，该板块可以不出现在正文（但保留 coverage 自检）。重磅新闻放在最靠前的板块下。\n\n" +
  "6. **caveats**：注明弱来源/厂商口径/时间敏感。openQuestions 2-4 个。\n\n" +
  "7. 如果素材大部分是超窗重大项（major-out）而窗口内几乎为空，则 oneLiner 和 execSummary 如实反映这一情况，优先报道 major-out 中最重要的 1-2 条。\n\n" +
  "Structured output only. 输出格式：{ sections, oneLiner, execSummary, caveats, openQuestions } 其中 sections 为 [{ board, title, items: [{ title, summary, confidence, sources, vote, status }] }]"
