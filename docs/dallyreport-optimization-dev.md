---
title: DallyReport 优化开发文档
status: draft-pending-approval
updated: 2026-08-11
tags:
  - dallyreport
  - dev-contract
  - optimization
---

# DallyReport 优化开发文档(DEV 合同)

> 状态:**草稿,待用户批准后实施**
> 关联:[[DallyReport 运维]](canonical 运维文档,代码现状以此为准)
> 代码仓:`/Users/mango/project/claude-project/DallyReport`(git,当前 HEAD `9f2e14b`)
> 依据:GitHub 开源调研(4 项目深度阅读)+ 本机只读验证 + 2026-08-11 review

## 0. 为什么优化(问题定义,按验证证据)

对 2026-08-05~08-10 六天产出的只读核对,发现:

1. **当日性失控(核心)**:
   - `GROK_DAYS=2` 允许近 2 天来源,来源未按发布时间过滤;
   - 2026-08-10 日报含 8/7 Axios 报道、7/16 新华网链接 —— 日报变成"近期综述"而非"当日热点"。
2. **低素材日幻觉风险**:linux.do 帖量 1~41 波动极大(08-07/08/09=40+,08-10=1 条)。低素材日来源不足时,方案 2 综合会靠模型记忆补白(08-10 顶部"今天尚未发现…发布公告"即补白信号),有编造风险。
3. **无当日保底源**:现有源(linux.do/nodeseek/v2ex + tavily/firecrawl)无按发布时间过滤的当日硬源,HN/arXiv/36kr 等零配置 API 未接入。
4. **搜索/综合模型耦合**:`GROK_MODEL` 同时管 grok-search 搜索与合成(运维文档"已知限制"已记录,本次落实)。
5. **手动运行**:"无 cron / 无 CI"是既有现状,本次只提供**可选**的自动化方案,实施前需用户明确决策。

## 1. 调研结论(开源项目参考,已核实)

| 项目 | star | 可借鉴 | 不借鉴(理由) |
|---|---|---|---|
| leiting-eric/DailyBrief | 316 | launchd plist 注册;时区感知 gate;sources.config.json 集中管理;单文件 HTML | 6 后端抽象(我们 CPA 已统一 openai-compatible);enrichment 逐条摘要(形态不同,叠成本) |
| ilovetochangetheworld/ai-daily-report | 2 | 轻栏目化(今日焦点/Top 信号/产品/研究/开源/社区) | 9 栏固定渲染(空栏日难看);多 agent 管线(重) |
| justlovemaki/CloudFlare-AI-Insight-Daily | 1769 | 全自动 CI 发布链路存在 | CF Workers 全托管(我们需本地 CPA + Obsidian 写入,架构不合) |
| hoangsonww/AI-News-Briefing | 36 | 多端分发思路 | 5+ agent 并行(成本高) |
| AgentEra/Agently-Daily-News-Collector | 635 | 分层 flow(父/子) | Python 栈,不迁移 |

## 2. 目标与非目标

**目标**:
- 日报素材"当日性"可验证:来源按发布时间过滤,报告标注来源时间跨度;
- 低素材日有 ≥10 条当日硬素材兜底,降低模型补白/幻觉概率;
- 搜索与综合模型解耦(config 级);
- (可选,需决策)本机 launchd 定时自动跑。

**非目标**(本迭代不做):
- 多 LLM 后端抽象层(CPA 已统一);
- enrichment 逐条摘要(形态不符,成本高);
- GitHub Actions CI 默认迁移(sips/cookie/secret 三个降级点,需单独决策);
- 中英双语、金融行情板块(范围外)。

## 3. 总体设计

```
当日硬源(HN/arXiv/36kr, 按发布时间过滤)
      │ 并入
linux.do / nodeseek / v2ex (已有)
      │ 并入
grok-search tavily/firecrawl (GROK_DAYS 语义收紧=当日优先)
      │
mergeSourcesPreferLinuxDo ──> dedupeAndNormalizeSources(已有)
      │
【新】filterByRecency: 按来源发布时间过滤 + 记录时间跨度
      │
方案2 综合(已有, prompt 增加"素材覆盖不足声明")
      │
AI.md / AI-Gemini.md + 海报(已有)
```

### 3.1 新增模块:src/sources-daily.mjs

当日硬源抓取器,复用现有 community/nodeseek/v2ex 的"开关 + catch 兜底 + 不阻塞"模式:

- `fetchHackerNewsDaily({limit})` — firebase API `topstories` + item 详情,按 `time` 过滤当日,标题/URL/desc;
- `fetch36krDaily({limit})` — `https://36kr.com/feed` RSS,按 `pubDate` 过滤当日;
- `fetchArxivDaily({limit})` — `export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate`,当日条目;
- 合并进 `mergeSourcesPreferLinuxDo` 的 `extraCommunitySources` 槽位(linux.do 仍最高优先)。

配置(env,全部默认 enabled):
| 变量 | 默认 | 说明 |
|---|---|---|
| `DAILY_SOURCES_ENABLED` | `true` | 总开关 |
| `HN_DAILY_ENABLED` / `HN_DAILY_LIMIT` | `true` / `5` | Hacker News |
| `KRSH_DAILY_ENABLED` / `KRSH_DAILY_LIMIT` | `true` / `5` | 36kr RSS |
| `ARXIV_DAILY_ENABLED` / `ARXIV_DAILY_LIMIT` | `true` / `5` | arXiv cs.AI |

### 3.2 新增过滤:src/snippet-hygiene.mjs 增加 `filterByRecency`

- 对带时间戳的来源(HN/arXiv/36kr/linux.do)按发布时间 > 当天 00:00(北京历法日,复用 `beijingDateFor`)过滤;
- 无时间戳的来源(tavily/firecrawl)按"当日优先"排序,不硬删;
- 返回 `{sources, dropped}` — dropped 供报告顶部标注"N 条过期来源已过滤"。

### 3.3 时间窗语义收紧:config.mjs

- `GROK_DAYS` 保留但默认 `2→1`(当日优先,语义写入注释);
- 新增 `REPORT_STRICT_DAILY`(默认 `true`):开启时 tavily/firecrawl 来源中明显过期(>2 天)的剔除。

### 3.4 prompt 防补白:llm-synthesize.mjs

SYSTEM_PROMPT 新增条款(编号续接):
> "若提供的来源数量或时效不足以支撑'当日'明确结论,必须显式标注'当日公开渠道未见 X 类重大动态',并基于来源给出'近期趋势'标题。禁止编造来源中不存在的模型名、发布日期、数字或结论。"

### 3.5 顶部状态标注:markdown.mjs / ai-news.mjs

报告顶部 (front-matter 后) 增加:
- `素材窗口: N 条当日 + M 条近 2 天, 过期过滤 K 条`
- `低素材警告: 当日来源 < 10 条` 时显式黄字标注。

### 3.6 (可选,P1)搜索/综合模型拆分:config.mjs

- 新增 `GROK_SEARCH_MODEL`(默认沿用 `GROK_MODEL` 值,兼容现状);
- `grok-cli.mjs` 调用 search.js 时传搜索模型;`llm-synthesize.mjs` 用 `SYNTH_MODEL`(默认 `GROK_MODEL`)。
- **行为不变式**:不设新变量时,与现在完全一致(不存在默认路径行为漂移)。

### 3.7 (可选,P1)轻栏目化:ai-news.mjs + markdown.mjs

综合输出后按 JSON 分类(今日焦点/产品模型/前沿研究/开源项目/社区热议/行业趋势),空栏目不渲染;失败回退现有扁平格式(失败安全)。

### 3.8 (可选,P1)launchd 定时 — 需用户决策

参考 DailyBrief `scripts/install.mjs`:
- `scripts/install-launchd.mjs`:生成 `~/Library/LaunchAgents/com.mango.dallyreport.plist`,StartCalendarInterval 每天 09:00(北京),日志重定向 `logs/launchd.{out,err}.log`;
- `scripts/uninstall-launchd.mjs`;
- **前提**:用户确认要自动化(现状"无 cron 无 CI"是用户定的)。

## 4. 任务拆解与验收

### Phase 1(质量核心)
- [ ] 3.1 当日硬源抓取器 + 3.2 filterByRecency + 3.3 时间窗收紧 + 3.4 prompt 防补白 + 3.5 状态标注
- [ ] 单测:新增 `test/sources-daily.test.mjs`(三个源抓取解析 + 开关/catch 兜底)、`test/recency.test.mjs`(时间过滤 + dropped 统计 + 无时间戳源排序)
- [ ] 全量 `npm test`(当前 211/209/2/0,须不下降)
- [ ] 验收(真实数据):`node src/run.mjs --date <昨天>` 重跑,核对:
  1. 报告顶部素材窗口标注存在且数字可归因(与 reports-cache 源清单一致);
  2. AI.md 中当日(昨日)来源占比 > 70%,无 >2 天前新闻混入正文;
  3. 低素材日(如有)出现"当日未见 X 类重大动态"而非补白语句;
  4. 海报正常生成,AI.png/GitHub.png 嵌入。

### Phase 2(结构解耦,可选)
- [ ] 3.6 搜索/综合模型拆分;验收:`GROK_SEARCH_MODEL` 单独设置后 grep 日志确认 search 子进程用新模型、综合用 SYNTH_MODEL;不设时行为与现状逐字节一致。
- [ ] 3.7 轻栏目化;验收:空栏目不渲染、有内容栏目正常、综合失败回退扁平格式、海报标题仍取前 8 有效标题。

### Phase 3(自动化,需用户决策)
- [ ] 3.8 launchd 安装/卸载脚本;验收:`launchctl list | grep dallyreport` 存在,实际触发一次 cron 产生当日报告,日志无异常。

## 5. 风险与护栏

| 风险 | 缓解 |
|---|---|
| 新源抓取失败拖死主流程 | 沿用 community 模式:`Promise.allSettled` + `.catch(fallbackCommunity)` + 0 条贡献不阻塞(已被 nodeseek/v2ex 验证) |
| 当日硬源与现有源重复 | URL 去重已有(mergeSourcesPreferLinuxDo 按 URL);linux.do 仍最高优先 |
| 36kr RSS 结构变 | 解析器失败安全:parse 异常 catch 后 0 条 + warning,有单测守 fixture |
| HN firebase 限流 | 只在当日首次请求,复用 reports-cache 缓存(同 grok-cli 模式) |
| 过滤过严导致当日素材反而更少 | GROK_DAYS 仍可回退 2;filterByRecency dropped 计数可视化,可关 |
| 模型补白屡禁不止 | 验收 3 强制检查;必要时把"禁止编造"条款升级为硬校验(关键词扫描日期/模型名出现而来源无对应) |
| launchd 与手动跑冲突 | 单例锁已有(reports-cache/run.lock),两个实例互斥 |

## 6. 变更记录

- **2026-08-11**:建立本文档。基于 GitHub 开源调研 + 6 天产出只读核对 + 候选源可用性实测(HN/arXiv/HF/OpenAI/36kr 200 通过;Anthropic 404、量子位 302 剔除)。修正初稿 5 处假设错误(见 review 结论)。