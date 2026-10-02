# DallyReport

每日 AI / GitHub 日报生成器。复用 [`grok-search`](https://github.com/) skill 拉取当前 AI 资讯与 GitHub 热门项目，渲染成带 front-matter 的 Markdown，写入 Obsidian vault。设计上可扩展到更多板块（其它报告类型）。

## 2026-09-28 优化（海报重做 + 去 AI 味儿 + 引用修复）

这一轮的起因是实测：把 2026-09-25 那周的周报正文和两张海报都拿出来逐条看，量出来的缺陷有据可查，不是口味问题。

- **海报不再交给扩散模型排版**。原路径把内容渲染成 prompt 让 `gpt-image-2` 画，交付出来的东西里：`宣布`画成`布`、`美元`画成`葵元`、`杭州`画成`抗州`、周报印上 `Al Trending Daily`；两条被点名的新闻（Copilot、WSO2）整条消失；还凭空多出「定价与性价比动态」「知识库更新记录」两个不存在的栏目标题。2x 和 4x 两种尺度 OCR 出来是同一批错字——**是像素本身错了，不是分辨率不够**。换成自排 HTML + headless Chrome，同一批内容 OCR 回来一字不差。新增 `src/poster/`，旧路径保留在 `POSTER_RENDERER=image`。
- **AI 海报改用笔记正文**。原来渲染的是来源卡片的原始标题，交付周报的 15 条来源里 8 条是英文原标题，还有论坛腔。同一份笔记的正文已经用中文把每件事说完整了，直接用正文要点。
- **周期口径收敛到一处**。`src/poster/period.mjs` 持有两张海报的周/日措辞、行数上限和文件名。之前 `GITHUB_POSTER_MAX_ROWS = 10` 在两个文件里各写了一遍，靠巧合一致；`normalizeGithubPeriod` 也还会吐出 `label: undefined` 进 prompt（`undefined` 会被画到图上）。现在两路渲染器引用的是同一个函数对象，测试直接断言这一点。
- **去 AI 味儿**。`src/prose-tighten.mjs` 在正文上做确定性清洗：把「同时，」「此外，」「另外，」并进同一条的要点拆开——**只在连接词出现在句子开头、且后半句自带 `[N]` 引用时才拆**，因为只有这两个条件同时成立才说明这是两件事。实测周报要点 10 → 14 条，过度聚类 4 → 1。拆分出来的后半段**不编造标题**（宁可没有小标题，也不要"公司动态"这种类别词当标题）。同时给综合 prompt 加了第 12 条：一条要点只讲一件事，粗体标题必须是一个具体的事件或对象本身。
- **引用修复**：正文里的 `[4, 19]` 这种组合引用以前只解析出第一个编号，后面的 `[19]` 变成悬空引用（参考列表里根本没有 19 号）。现在按逗号逐个解析，编号仍按完整来源表的 1-based 序号。
- **HN 链接帖不再往标题里塞 `(score: N)`**：该字段是站点评分，不是新闻内容，现在只进数据不进正文。另外 `Hacker News` 摘要会取帖子的首段文字，纯链接帖没有正文就留空，不复述标题。
- **无数据的格子不出现**：GitHub 海报缺 Fork 或总 Star 时不再画破折号占位。破折号落在数字格里是个明确的"这里该有个数"指令，扩散模型会照着编一个 GitHub 从没发布过的数字出来。两条旧测试原本断言 `Fork —`，已按新契约重写并在注释里写明改了什么、为什么。
- **像素级验收**：`scripts/verify-poster.mjs` 用真实数据重渲染 + macOS Vision OCR 回读，39 项断言，当前 `RESULT=OK`。

## 2026-08-11 优化（当日性 + 硬源保底 + 解耦）

- **当日硬源**：新增 HN(top+best 合并去重) / 36kr(默认关) / arXiv(1 天宽限) / OpenAI News / HF Blog 五个零配置公开 API/RSS 源（`src/sources-daily.mjs`），按发布时间过滤出**北京历法当日**素材，linux.do 安静日（如 08-10 仅 1 帖）时模型仍有 ≥10 条当日素材，降低凭记忆补白/编造风险。36kr 默认关闭（Firecrawl URL 被重写为 feed 首页，去重合并）。
- **时效过滤**：`filterByRecency`（`src/snippet-hygiene.mjs`）对带时间戳来源（含 linux.do `created_at`）按当日 00:00（北京）过滤，过期计数在报告头部标注；`GROK_DAYS` 默认收紧 2→1。
- **素材窗口标注**：报告顶部 `> **素材窗口**：当日素材 N 条；近几日来源 M 条；过期已过滤 K 条`；当日硬源 < 10 时给出低素材提示。`REPORT_STRICT_DAILY=false` 可关闭。
- **防补白 prompt**：`SYSTEM_PROMPT` 新增第 8 条（素材时效声明——来源不足显式标注"当日未见 X 类动态"而非编造）与第 9 条（轻栏目化——来源 ≥8 条时按今日焦点/产品模型/前沿研究/开源/社区组织，空栏不渲染，<8 条退化为扁平列表）。
- **搜索/综合模型解耦**：`GROK_SEARCH_MODEL` 单独配置搜索子进程模型，综合写手仍用 `GROK_MODEL`；不设时行为与旧版完全一致。
- **launchd 定时（可选）**：`node scripts/install-launchd.mjs` 注册每日 09:00 本机定时任务（日志 `logs/launchd.{out,err}.log`），`node scripts/uninstall-launchd.mjs` 卸载。
- 测试 211 → **228（全部 pass）**。

> 开发文档：`docs/dallyreport-optimization-dev.md`（Obsidian: `Note/Infra/DallyReport 优化开发文档.md`）

## 目录结构

```
DallyReport/
├── src/
│   ├── run.mjs                 # 入口：并发跑两个板块 -> 落盘 Obsidian；随后追跑 AI/GitHub 海报生图并嵌入
│   ├── config.mjs              # 加载 .env、校验必填、导出运行时配置（综合/生图/缓存目录）
│   ├── grok-cli.mjs            # 封装 spawn 调用 grok-search 的 search.js / fetch.js（带子进程超时）
│   ├── llm-synthesize.mjs      # 零回引时把 Tavily/Firecrawl/linux.do 来源喂给模型综合正文（/chat/completions）
│   ├── linuxdo.mjs             # 抓取 linux.do 前沿快讯 + 人工智能 tag，过滤 AI 帖并优先并入 AI 来源
│   ├── image-gen.mjs           # 旧的海报生图路径（POSTER_RENDERER=image 才走）：vault 提示词+参考图 -> CPA /images/edits -> PNG
│   ├── prose-tighten.mjs       # 正文后处理：拆分被「同时/此外/另外」并成一条的要点
│   ├── poster/                 # 默认的海报渲染：自排 HTML -> headless Chrome -> PNG
│   │   ├── period.mjs          # 两路渲染器共用的周期措辞、行数上限、文件名（防止口径漂移）
│   │   ├── shot.mjs            # HTML -> PNG（自己拉起浏览器，不依赖已登录的 Chrome）
│   │   ├── html.mjs            # 版式基座：1600x900、一个强调色、发丝线
│   │   ├── github.mjs          # GitHub 海报：单行表头、等高行、诚实的截断声明
│   │   ├── ai.mjs              # AI 海报：双栏、先左栏后右栏、不编造栏目标题
│   │   └── translate.mjs       # 仓库简介的尽力中文翻译（失败退回英文，不阻断）
│   ├── markdown.mjs            # 纯函数：front-matter、来源卡片、表格
│   ├── obsidian.mjs            # 写入 vault：YYYY-MM-DD/{AI,GitHub}.md；写入失败则抢救到缓存
│   └── sections/
│       ├── ai-news.mjs         # AI 板块：搜索 -> 零回引则综合 -> 来源卡片
│       └── github-trending.mjs # GitHub 板块：fetch trending -> 解析 star 增量 -> 表格（+暴露 repos 给海报）
├── test/                       # node:test 单测（配置、缓存、注入清洗、原子写、综合、海报等）
├── reports-cache/              # 抓取结果缓存 + 写入失败时的抢救正文（gitignore）
├── .env.example
└── package.json
```

日报物理写入外部 Obsidian vault（默认 `~/Library/.../obsidian-note/Note/AI/DallyReport`），按 `YYYY-MM-DD/` 分日期文件夹分节。

## 用法

```bash
# 1. 装依赖（只装一个 dotenv）
npm install

# 2. 配置
cp .env.example .env
# 填入 GROK_API_URL / GROK_API_KEY（必填）

# 3. 跑当天全量日报
npm run            # = node src/run.mjs，输出 AI.md + GitHub.md

# 单独跑一个板块
npm run ai
npm run github

# 手动指定周期（默认 auto：北京时间周五跑周报，其余跑日报）
node src/run.mjs --mode weekly --date 2026-10-02
node src/run.mjs --mode daily
node src/run.mjs --mode bogus        # 退出码 2，不做任何采集

# 只跑到采集层的干跑（实网、不调 LLM、不写 vault）
node scripts/dry-run-weekly.mjs --date 2026-10-02

# 生成博客草稿（不发布）
npm run blog:draft -- --date 2026-08-13

# 4. 测试
npm test           # = node --test，跑 test/ 下的单测
```

跑完会在 Obsidian vault 的 `DallyReport/<今天>/` 下生成 `AI.md`、`GitHub.md`，以及启用生图时对应的 `AI.png`、`GitHub.png`。同一天重跑会刷新这些文件，不产生重复。

### 日报 / 周报

同一个 launchd 任务（每天 09:00）同时产出两种报告，由 `REPORT_MODE` 决定：

| | 日报 | 周报 |
|---|---|---|
| 触发 | 周一~周四、周六、周日 | **周五**（且当天不跑日报） |
| 窗口 | 当日 1 天 | 过去 7 天（含当天） |
| 文件 | `AI.md` / `AI.png` | `AI-周报.md` / `AI-周报.png` |
| front-matter | `date` | `date` + `date_range` |
| GitHub 榜单 | `?since=daily`（今日新增） | `?since=weekly`（本周新增） |
| 硬源上限 | 15 条 | 60 条 |
| 低素材阈值 | 8 条 | 20 条 |

周报与日报走完全相同的链路，只是窗口天数不同——窗口原语集中在 `src/report-window.mjs`（纯函数，无 I/O）。周报跳过 linux.do「辅助资料」笔记（一周的帖子逐条归档会变成几百行的墙，且要按 7 倍成本抓全文）。

**注意 `GROK_DAYS`**：它在 `.env` 里若被显式设成 `1`，会同时把周报的联网检索也压回 1 天，与采集层的 7 天窗口不一致。要么删掉该行（日报默认 1、周报默认 7），要么设为 `7`。

博客草稿导出到 `reports-cache/blog-drafts/YYYY-MM-DD/`，包含 `AI.md` 和 `assets/AI.png`。草稿带有 `draft: true` 与 `publish_review: pending`，当前不会连接任何博客平台，也不会公开发布。可用 `BLOG_DRAFT_DIR` 覆盖输出目录。

## 配置（.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `GROK_API_URL` | ✅ | Responses 兼容端点，如 `https://api.x.ai/v1` |
| `GROK_API_KEY` | ✅ | 上面端点的 key |
| `GROK_MODEL` |  | 同时用于 grok-search 搜索调用与 llm-synthesize 综合调用，默认 `gpt-5.6-luna`（`grok-4.5` 仅为综合失败时的回退模型） |
| `TAVILY_API_KEY` |  | 给 AI 板块补来源、给 GitHub 板块做 Extract，强烈建议填 |
| `FIRECRAWL_API_URL` |  | 可选，备用抓取 provider |
| `GROK_SEARCH_DIR` |  | grok-search skill 路径，默认基于当前用户 home 的 `~/.claude/skills/grok-search`；换机、CI、生产建议显式配置 |
| `OBSIDIAN_DIR` |  | Obsidian vault 输出目录，默认基于当前用户 home 推导 `Note/AI/DallyReport`；换机、CI、生产建议显式配置 |
| `GROK_DAYS` |  | AI 板块 `--days`（只取近 N 天来源），默认 `1` |
| `GROK_EXTRA` |  | AI 板块 `--extra`（外部来源数量），默认 `10` |
| `GROK_FETCH_MAX_CHARS` |  | GitHub trending 抓取上限字符，默认 `80000` |
| `GROK_SYNTH_MAX_TOKENS` |  | 综合调用 completion token 上限，默认 `4000`（截断由 `finish_reason` 探测） |
| `GROK_SYNTH_TIMEOUT_MS` |  | 综合 `/chat/completions` 调用超时，默认 `90000` |
| `GROK_CHILD_TIMEOUT_MS` |  | 单个 grok-search 子进程超时，默认 `120000`；同时作为 `search.js` / `fetch.js` 的 `--deadline`（秒）传入，让 Grok HTTP 超时落在该预算内 |
| `AI_QUERY` |  | AI 查询模板，`{date}` 会被替换成当天日期；默认已提示优先 linux.do |
| `LINUXDO_ENABLED` |  | 是否额外抓取 linux.do 论坛 AI 帖并优先并入来源，默认开；`false` 关闭 |
| `LINUXDO_LIST_URLS` |  | 列表页 URL，逗号分隔；默认 `前沿快讯` + `人工智能` tag |
| `LINUXDO_TOPIC_LIMIT` |  | 最多纳入多少条 AI 相关帖，默认 `8` |
| `LINUXDO_DEEP_FETCH` |  | 是否深抓帖子正文做 snippet，默认开 |
| `LINUXDO_DEEP_FETCH_LIMIT` |  | 深抓帖子数量上限，默认 `5` |
| `AI_SOURCE_MAX_TOTAL` |  | 综合时总来源上限（linux.do 优先占位），默认 `18` |
| `IMAGE_API_URL` |  | 生图网关 base，留空复用 `GROK_API_URL`（CPA 同一个 `/v1` 暴露 `gpt-image-2`） |
| `IMAGE_API_KEY` |  | 生图网关 key，留空复用 `GROK_API_KEY` |
| `IMAGE_MODEL` |  | 生图模型，默认 `gpt-image-2`（CPA 拒 `gpt-image-1`） |
| `IMAGE_SIZE` |  | 出图尺寸，默认 `1024x1024` |
| `IMAGE_PROMPT_FILE` |  | 海报提示词 Markdown（vault 内），默认指向 `GitHub 日报海报提示词.md` |
| `IMAGE_REF_IMAGE` |  | 海报参考图路径（vault 内），默认基于当前用户 home 推导；换机、CI、生产建议显式配置 |
| `IMAGE_TIMEOUT_MS` |  | 单次生图请求墙钟预算，默认 `180000`（网关 524 常在 ~126s，给余量） |
| `IMAGE_SIPS_TIMEOUT_MS` |  | macOS `sips` 缩放参考图的超时，默认 `15000`；超时后发送 `SIGTERM`，宽限期后 `SIGKILL`，并回退原图 |
| `IMAGE_RETRIES` |  | `/images/edits` 失败重试次数（524/超时可重试），默认 `2` |
| `IMAGE_ENABLED` |  | 设为 `false` 可整体跳过生图（断网/只想跑文字时），默认开 |
| `AI_IMAGE_ENABLED` |  | AI 海报独立开关；未设置时跟随 `IMAGE_ENABLED` |
| `AI_IMAGE_PROMPT_FILE` |  | AI 海报提示词 Markdown；默认指向 `AI 日报海报提示词.md` |
| `AI_IMAGE_REF_IMAGE` |  | AI 海报参考图；未设置时复用 `IMAGE_REF_IMAGE` |
| `POSTER_RENDERER` |  | 海报渲染方式：`layout`（默认，自排 HTML -> headless Chrome 截图）或 `image`（旧的扩散模型生图）。非法值一律回落 `layout` |
| `POSTER_CHROME_BIN` |  | 排版路径使用的浏览器可执行文件；留空则依次探测 Chrome / Chromium / Edge / Brave |

## 工作机制

- **AI 板块**：以 `--days`+`--extra` 调 `grok-search search.js`，取正文与来源卡片。同时并行抓取 **linux.do** 论坛「前沿快讯」(`/c/news/34`) 与「人工智能」tag，按标题过滤 AI 相关帖、深抓 top-N 正文 snippet，**合并时 linux.do 来源排在最前**（综合 prompt 也明确要求优先采纳）。当网关 `/responses` 后端零回引（`web_search_calls=0`）时，模型原生正文是凭训练记忆编造的；此时本板块会把 Tavily/Firecrawl + linux.do 当日抓取到的来源喂给 `GROK_MODEL`（经网关 `/chat/completions`）重新综合成正文，每条标注来源序号 `[n]`，下方来源卡片为依据。综合若失败（超时、`finish_reason=length` 截断等）会回退为模型原始回答并在顶部标注，并在总结里标 `⚠️`。若 grok-search 自身已降级并产出可用的原始来源 dump，则直接复用、不再二次综合（省开销）。`--days` 过滤掉更早来源并记到 front-matter `days_dropped`。`LINUXDO_ENABLED=false` 可关掉论坛优先。来源 snippet 在送入综合模型前会做句子级注入清洗，并以 `<untrusted-source>` 数据边界传入；缓存命中会在日报备注中明确标注「linux.do 来源来自本地缓存，实时状态未验证」，不会伪装成实时抓取。即使通用搜索失败或处于 degraded 模式，只要有 linux.do 来源仍会优先纳入并尝试综合。
- **GitHub 板块**：用 `fetch.js` 抓 `https://github.com/trending?since=daily`，本地正则解析每个 `owner/repo` 及其 `stars today`、总 Star、一行项目简介（captured off the line right under the repo name），去重后按今日增长降序，渲染前 15 的 Markdown 表格。结果缓存到 `reports-cache/`，重跑优先读缓存，并在结果备注中区分缓存命中与实时抓取；实时抓取成功但缓存写入失败时仍保留实时结果，只追加可见 warning，不会把成功反转为失败。解析出的前 N 名 `repos`（含一句话简介）会传给海报生图步骤。
- **海报渲染（默认 `layout`）**：两张海报都由本项目自己排版——把内容渲染成一张 1600×900 的 HTML，交给 **我们自己拉起的** headless Chrome 截图成 PNG。不复用用户已登录的 Chrome 实例：定时任务是无人值守的 09:00 跑，借用已开的浏览器会直接把任务带崩。浏览器按 Chrome / Chromium / Edge / Brave 顺序探测，可用 `POSTER_CHROME_BIN` 指定；都没有时返回 `POSTER_NO_CHROME` 而不是静默跳过。排版口径只有一份，放在 `src/poster/period.mjs`：两张海报的周/日措辞、行数上限、文件名都从这里出，两路渲染器不可能各说各话。设计取向是**优雅、简洁、直抒胸臆**：一个强调色、发丝线而不是卡片卡；正文里没有的指标就不出现单元格，不用破折号占位（破折号落在数字格里，扩散模型会当成"这里该有个数"然后编一个出来）；列表被截断时页脚直接写明"共 N 个，显示前 M 名，另有 K 个见笔记"。
  - **AI 海报的内容来自笔记正文，不是来源卡片。** 交付的 2026-09-25 周报里，15 条来源有 8 条是英文原标题（`Evolving programming languages in the AI era`、`AD-WM: Action-Discriminative World Models for Counterfactual Model Predictive Control`），还有论坛腔（`Termius-MCP 让AI接管你的小鸡`）和生图模型自己的错字被原样带进数据（`opencode永久延期DeepSeek4.1f用量！`）。同一份笔记的正文已经用中文把每件事说完整了，所以海报直接用正文要点。这也意味着去聚类会真的影响到图上条目数——否则它只改笔记、不改图。
  - 切回旧的扩散模型生图：`POSTER_RENDERER=image`，不需要改任何代码。
- **旧的海报生图路径（`POSTER_RENDERER=image`）**：读取 vault 里用户维护的「GitHub 日报海报提示词」Markdown（提取首个围栏代码块作为提示词，注入 `{date}` 与前 10 名 `owner/repo`+star 数据+每项原始英文一句话简介）与参考图，调 CPA `/v1/images/edits` 生成 16:9 PNG。**项目名保持英文原样（owner/repo 不翻译）**，简介先在数据层截成一句作为「原始简介」传入，Prompt 指示模型译成中文一句渲染，无简介的项目只显示名称与数据不编造。模型固定 `gpt-image-2`。**网关 524 处理**：CPA/CF 在 ~126s 处高频返 524，且 **524 可能带一个合法的 JSON 图片 body**——本模块**先尝试从 body 解码图片、无视 status**，拿不到图才报 HTTP 错；524/超时/5xx 可重试（`IMAGE_RETRIES`），全部失败再退到 `/images/generations`。参考图用 macOS `sips` 缩到 ≤768px + JPEG。已知这条路的代价：它会把「宣布」画成「布」、「美元」画成「葵元」、「杭州」画成「抗州」，并且会自己编出「定价与性价比动态」这种不存在的栏目标题——2x 和 4x 两种尺度 OCR 出来是同一批错字，说明是像素本身错了而不是分辨率不够。
- **海报验收（`scripts/verify-poster.mjs`）**：用真实笔记数据 + 缓存 trending 重渲染两张海报，用 macOS Vision OCR 回读文字，断言 39 项（周期措辞、每个标题、页脚、"不该出现的 `score:`"）。它是像素级的关卡，跑的是 `run.mjs` 调的同一个 `buildStoriesFromBody`——验收脚本自己另写一套重建逻辑，就会测一个比交付物更干净的版本（已经踩过一次）。OCR 比较对 `I`/`l` 和 `…`/`.` 做了折叠：这两处是识别器对本来就含糊的字形的误读，不是像素错；CJK 错字（美元→葵元）不在折叠范围内，照样判失败。
- **隔离与抢救**：任一板块失败不阻断另一板块落盘（Grok 挂了 GitHub 照出，反之亦然）。单板块超时（子进程 / 综合调用 / 生图各自有超时）会落进失败分支而非无限挂起。Obsidian Markdown 先写入同目录临时文件，再用 `rename` 原子替换目标；写入或替换失败会清理临时文件并保留旧文件。若正文已生成但写入 Obsidian vault 失败（iCloud 同步中、vault 移动、磁盘满），会把正文抢救到 `reports-cache/<date>-<section>-fallback.md`，不丢失已计算结果。
- **缓存目录**：`reports-cache/` 相对项目根目录解析（与运行时 cwd 无关），从任意目录跑都能命中同一份缓存。

## 获取 & 同步

```bash
git clone https://github.com/dengyie/DallyReport.git
```

远端已默认关联 HTTPS（`https://github.com/dengyie/DallyReport.git`，与兄弟仓一致）。这台机器克隆后即可 `git pull`；如需改用 SSH，`git remote set-url origin git@github.com:dengyie/DallyReport.git`。

`.env`、`reports-cache/` 均在 `.gitignore` 中，不会进库。日报正文落在外部 Obsidian vault，不进本仓 git（如需归档副本留作 next phase）。

## 测试

```bash
npm test
```

用 Node 内置的 `node:test`，无需额外依赖。覆盖：

- `parseTrending`：用一份抓取样例 fixture 解析、断言排序与 `starsToday`/`starsTotal`/`description` 归属，并验证正文里的数字不会污染 `starsTotal`。
- `config`：验证默认路径基于 `os.homedir()`、显式环境变量覆盖、正整数超时校验，以及缺失运行路径只产生 warning。
- `obsidian`：验证同目录临时文件 + `rename` 的原子覆盖语义、替换失败时旧文件完整保留，以及临时文件清理。
- `grok-cli`：验证缓存命中标记、实时抓取与缓存区分，以及缓存写失败不会反转实时成功。
- `snippet-hygiene` 与 `renderSources`：覆盖中英文 prompt injection/paraphrase 清洗、合法新闻保留、来源 `<untrusted-source>` 边界和字段转义。
- `llm-synthesize.synthesizeFromSources`：注入 `fetch` 桩，覆盖 `finish_reason=length` 截断（`SYNTH_TRUNCATED`）、超时（`SYNTH_FETCH_FAILED`/`aborted`）、空内容（`SYNTH_EMPTY`）、缺凭证（`MISSING_GROK_CREDS`）等失败路径。
- `linuxdo`：解析列表页 topic 链接、AI 标题过滤、广告降权、来源合并去重、注入 `runFetch` 的抓取路径与失败隔离，并验证缓存状态是非枚举元数据且 listing 失败仍可观测。
- `image-gen.generateGithubPoster` / `generateAiPoster` + `extractPrompt` + 两套 prompt builder：注入 `fetch` 桩，覆盖 edits 成功落盘、**524 带合法图片 body 的抢救**、524 重试后 `generations` 兜底、非可重试 400 直退兜底、全部失败 `IMG_HTTP_ERROR`、超时 `IMG_TIMEOUT`、空 data `IMG_EMPTY`、url 分支 PNG 签名校验、缺提示词 `IMG_BAD_PROMPT`、写盘失败 `IMG_WRITE_FAILED`、缺凭证 `MISSING_IMAGE_CREDS`；同时覆盖 `sips` 成功读取、超时后的 `SIGTERM`/`SIGKILL` 与临时文件清理。`buildContextualPrompt` 断言单句描述注入、无描述退化、空 repos 退化；`buildAiContextualPrompt` / `hasAiPosterHeadlines` 断言标题清洗、linux.do 标识、前 8 条上限，以及无有效标题时不调用图片 API。

这几个是项目里最易回归、又最依赖外部形态的点（GitHub 页面结构变化 / 网关返回变化 / 生图网关 524 抖动），优先守住。
