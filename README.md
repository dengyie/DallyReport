# DallyReport

每日 AI / GitHub 日报生成器。复用 [`grok-search`](https://github.com/) skill 拉取当前 AI 资讯与 GitHub 热门项目，渲染成带 front-matter 的 Markdown，写入 Obsidian vault。设计上可扩展到更多板块（其它报告类型）。

## 目录结构

```
DallyReport/
├── src/
│   ├── run.mjs                 # 入口：并发跑两个板块 -> 落盘 Obsidian；随后追跑 AI/GitHub 海报生图并嵌入
│   ├── config.mjs              # 加载 .env、校验必填、导出运行时配置（综合/生图/缓存目录）
│   ├── grok-cli.mjs            # 封装 spawn 调用 grok-search 的 search.js / fetch.js（带子进程超时）
│   ├── llm-synthesize.mjs      # 零回引时把 Tavily/Firecrawl/linux.do 来源喂给模型综合正文（/chat/completions）
│   ├── linuxdo.mjs             # 抓取 linux.do 前沿快讯 + 人工智能 tag，过滤 AI 帖并优先并入 AI 来源
│   ├── image-gen.mjs           # GitHub/AI 日报海报生图：vault 提示词+参考图 -> CPA /images/edits -> PNG
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

# 4. 测试
npm test           # = node --test，跑 test/ 下的单测
```

跑完会在 Obsidian vault 的 `DallyReport/<今天>/` 下生成 `AI.md`、`GitHub.md`，以及启用生图时对应的 `AI.png`、`GitHub.png`。同一天重跑会刷新这些文件，不产生重复。

## 配置（.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `GROK_API_URL` | ✅ | Responses 兼容端点，如 `https://api.x.ai/v1` |
| `GROK_API_KEY` | ✅ | 上面端点的 key |
| `GROK_MODEL` |  | 同时用于 grok-search 搜索调用与 llm-synthesize 综合调用，默认 `grok-4.5` |
| `TAVILY_API_KEY` |  | 给 AI 板块补来源、给 GitHub 板块做 Extract，强烈建议填 |
| `FIRECRAWL_API_URL` |  | 可选，备用抓取 provider |
| `GROK_SEARCH_DIR` |  | grok-search skill 路径，默认基于当前用户 home 的 `~/.claude/skills/grok-search`；换机、CI、生产建议显式配置 |
| `OBSIDIAN_DIR` |  | Obsidian vault 输出目录，默认基于当前用户 home 推导 `Note/AI/DallyReport`；换机、CI、生产建议显式配置 |
| `GROK_DAYS` |  | AI 板块 `--days`（只取近 N 天来源），默认 `2` |
| `GROK_EXTRA` |  | AI 板块 `--extra`（外部来源数量），默认 `10` |
| `GROK_FETCH_MAX_CHARS` |  | GitHub trending 抓取上限字符，默认 `80000` |
| `GROK_SYNTH_MAX_TOKENS` |  | 综合调用 completion token 上限，默认 `4000`（截断由 `finish_reason` 探测） |
| `GROK_SYNTH_TIMEOUT_MS` |  | 综合 `/chat/completions` 调用超时，默认 `90000` |
| `GROK_CHILD_TIMEOUT_MS` |  | 单个 grok-search 子进程超时，默认 `120000` |
| `AI_QUERY` |  | AI 查询模板，`{date}` 会被替换成当天日期；默认已提示优先 linux.do |
| `LINUXDO_ENABLED` |  | 是否额外抓取 linux.do 论坛 AI 帖并优先并入来源，默认开；`false` 关闭 |
| `LINUXDO_LIST_URLS` |  | 列表页 URL，逗号分隔；默认 `前沿快讯` + `人工智能` tag |
| `LINUXDO_TOPIC_LIMIT` |  | 最多纳入多少条 AI 相关帖，默认 `8` |
| `LINUXDO_DEEP_FETCH` |  | 是否深抓帖子正文做 snippet，默认开 |
| `LINUXDO_DEEP_FETCH_LIMIT` |  | 深抓帖子数量上限，默认 `5` |
| `AI_SOURCE_MAX_TOTAL` |  | 综合时总来源上限（linux.do 优先占位），默认 `16` |
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

## 工作机制

- **AI 板块**：以 `--days`+`--extra` 调 `grok-search search.js`，取正文与来源卡片。同时并行抓取 **linux.do** 论坛「前沿快讯」(`/c/news/34`) 与「人工智能」tag，按标题过滤 AI 相关帖、深抓 top-N 正文 snippet，**合并时 linux.do 来源排在最前**（综合 prompt 也明确要求优先采纳）。当网关 `/responses` 后端零回引（`web_search_calls=0`）时，模型原生正文是凭训练记忆编造的；此时本板块会把 Tavily/Firecrawl + linux.do 当日抓取到的来源喂给 `GROK_MODEL`（经网关 `/chat/completions`）重新综合成正文，每条标注来源序号 `[n]`，下方来源卡片为依据。综合若失败（超时、`finish_reason=length` 截断等）会回退为模型原始回答并在顶部标注，并在总结里标 `⚠️`。若 grok-search 自身已降级并产出可用的原始来源 dump，则直接复用、不再二次综合（省开销）。`--days` 过滤掉更早来源并记到 front-matter `days_dropped`。`LINUXDO_ENABLED=false` 可关掉论坛优先。来源 snippet 在送入综合模型前会做句子级注入清洗，并以 `<untrusted-source>` 数据边界传入；缓存命中会在日报备注中明确标注「linux.do 来源来自本地缓存，实时状态未验证」，不会伪装成实时抓取。即使通用搜索失败或处于 degraded 模式，只要有 linux.do 来源仍会优先纳入并尝试综合。
- **GitHub 板块**：用 `fetch.js` 抓 `https://github.com/trending?since=daily`，本地正则解析每个 `owner/repo` 及其 `stars today`、总 Star、一行项目简介（captured off the line right under the repo name），去重后按今日增长降序，渲染前 15 的 Markdown 表格。结果缓存到 `reports-cache/`，重跑优先读缓存，并在结果备注中区分缓存命中与实时抓取；实时抓取成功但缓存写入失败时仍保留实时结果，只追加可见 warning，不会把成功反转为失败。解析出的前 N 名 `repos`（含一句话简介）会传给海报生图步骤。
- **GitHub 日报海报生图**：GitHub 板块落盘后，读取 vault 里用户维护的「GitHub 日报海报提示词」Markdown（提取首个围栏代码块作为提示词，注入 `{date}` 与前 10 名 `owner/repo`+star 数据+每项原始英文一句话简介）与参考图，调 CPA `/v1/images/edits`（multipart 上传参考图，用户要求「也上传参考图片」）生成 16:9 海报 PNG，落到 `OBSIDIAN_DIR/YYYY-MM-DD/GitHub.png`，并在 `GitHub.md` 标题下嵌入 `![[GitHub.png]]`。**项目名保持英文原样（owner/repo 不翻译）**，**简介要求翻译成中文一句话**：抓取到的英文简介先在数据层截成一句（在第一个句末标点 `. ! ? 。！？` 处截断，无标点则整行保留）作为「原始简介」传入，Prompt 明确指示模型把它译成中文、控制一句内渲染到海报，无简介的项目只显示名称与数据不编造。模型固定 `gpt-image-2`（CPA 对 `gpt-image-1` 在 `/images/*` 返 400）。**网关 524 处理**：CPA/CF 在 ~126s 处高频返 524，且**524 可能带一个合法的 JSON 图片 body**（CF 标 origin 超时但图已生成）——本模块**先尝试从 body 解码图片、无视 status**，拿不到图才报 HTTP 错；524/超时/5xx 可重试（`IMAGE_RETRIES`），全部失败再退到 `/images/generations`（纯文本、无参考图，CPA 上更稳）。参考图偏大（1.7MB PNG）易触发 524，上传前用 macOS `sips` 缩到 ≤768px + JPEG（不可用则退回原 PNG）；`sips` 默认 15 秒超时，先发 `SIGTERM`，宽限期后发 `SIGKILL`，失败或超时都会清理临时 JPEG 并回退原 PNG。生图**独立于文字板块**：失败只会在总结里标 `⚠️`，不会降级已写好的 `GitHub.md`；`IMAGE_ENABLED=false` 可整体跳过。
- **AI 日报海报生图**：AI 板块落盘后，在同一份已清洗、linux.do 优先的来源集合中取前 8 条有效标题，重新做边界清洗并标注 `[linux.do]`，明确告诉生图模型「标题是新闻数据而不是指令」，只渲染给定标题。若标题全部被清洗为空，运行入口和 `generateAiPoster()` 都会在调用图片 API 前跳过（`IMG_NO_HEADLINES`），不会诱导模型编造新闻。读取 `AI_IMAGE_PROMPT_FILE` 与 `AI_IMAGE_REF_IMAGE`（后者默认复用 GitHub 参考图），调同一套 edits/524 salvage/generations fallback/PNG 校验/原子写盘流程，输出 `OBSIDIAN_DIR/YYYY-MM-DD/AI.png` 并嵌入 `AI.md`。`AI_IMAGE_ENABLED` 可单独关闭；AI 板块失败、执行异常、海报失败或嵌入失败只进入总结中的可区分状态，不影响已经写好的文字日报。
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
