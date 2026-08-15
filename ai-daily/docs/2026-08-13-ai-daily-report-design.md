# AI 日报系统设计

- **日期**: 2026-08-13
- **状态**: 已设计，准备实现
- **触发**: 每日自动（launchd）+ 手动 `/ai-daily`
- **项目**: `/Users/mango/project/claude-project/obsidian`（Obsidian 库）

## 1. 背景与根因

内建 `deep-research` 工作流在本环境跑"今日 AI 日报"时漏掉了明显的头条新闻（如 Grok 4.6、DeepSeek 系发布）。根因调查结论（已取证）：

1. **Scope 阶段由 LLM 自由生成 5 条查询**，其中"头部实验室"查询把公司白名单写死为 `OpenAI Google DeepMind Anthropic NVIDIA Microsoft`，**xAI/Grok 等其他主要厂商被排除**；搜索代理实际发出的 6 条公司定向查询全部在这张白名单里（已从子代理转录提取取证）。

> **8/13 晚修正**：首版实现矫枉过正——把"日历窗口"误当成"重要性过滤器"，导致 DeepSeek V4 开源、Grok 4.6 发布、Harness 等**公认事实**被"不在窗口 + 无官宣"规则挡进"窗口外参考"，造成同类型漏报。已改为上述"重大超窗事实入正文（[窗口外·重大]）"规则。
2. **单一搜索工具**：搜索阶段只允许用内建 WebSearch，未接入 grok-search（Tavily/Exa/X 官方搜索/官方 RSS）。
3. **硬上限**：每搜索代理 ≤6 条、MAX_FETCH=15、MAX_VERIFY_CLAIMS=25；本轮 WebSearch 配额 200 次被耗尽。
4. **网关不稳**：全部子代理跑 deepseek-v4-flash（经 cpa.mangoqwq.com），13 个子代理因 Cloudflare 524 报错，合成阶段失败，23 条已验证声索未合并。

## 2. 目标

- **全面**：覆盖 9 大板块 × 必查厂商花名册，机制上消除"漏搜 = 没新闻"的盲区。
- **优质**：对抗式核查、来源引用、时效约束、可信度标注、明确的覆盖自检。
- **可靠**：阶段落盘可续跑、网关重试与降级模式、WebSearch 配额不失控。
- **可接受**：单篇 Markdown 日报 + 原始数据存档；每日 08:40 自动产出，可手动补跑任意历史日。

## 3. 总体架构

```
launchd（每日 08:40，headless claude）或 手动 /ai-daily
   └─ ai-daily skill（编排器，主会话）
        ├─ 阶段0  准备：计算日期窗口、建当日工作目录、跑 grok-search 官方源扫描 → seed_URLs.json
        ├─ 阶段1  调用 Workflow({scriptPath: .claude/workflows/ai-daily.js, args:{date, seedFile, outDir}})
        │            ├─ Phase A  覆盖矩阵映射（必查花名册 × 9 板块）
        │            ├─ Phase B  每任务：读 seed 源 → 筛选/补搜 → URL 名单
        │            ├─ Phase C  按 URL 抓取并提取 falsifiable claims（带 quote/publishDate/sourceQuality）
        │            ├─ Phase D  3 票对抗核查（refute 优先，≥2 票 kill；不足 3 票则补轮至满，无第 4-5 票复核）
        │            ├─ Phase E  覆盖自检（对照花名册输出"确认无动态"清单）
        │            └─ Phase F  终稿合成（结构化 JSON：板块 findings + 摘要 + caveats + 覆盖矩阵）
        └─ 阶段2  落地：写 docs/daily/YYYY-MM-DD-ai日报.md + *.verified-claims.json + *.sources.json + *.meta.json
```

**关键决策**：发现层（grok-search 官方源扫描）与验证层（workflow）解耦——发现依赖 grok-search 的多 provider 搜索面（X 官方、RSS、Tavily/Exa），验证依赖 workflow 的结构化多 agent 流程。内建 WebSearch 仅作兜底补充，避免 200 次/会话配额被吞。

## 4. 覆盖模型（确定性）

**9 大固定板块**：①头部实验室·新模型 ②重磅头条/战略 ③大公司产品与硬件 ④开源与工具链 ⑤学术研究 ⑥融资并购 ⑦政策监管 ⑧安全与伦理 ⑨人才流动。

**必查厂商花名册**（每厂商一个搜索/抓取任务，粒度统一）：
OpenAI、Google/DeepMind、Anthropic、**xAI**、NVIDIA、Meta、Amazon、Apple、Microsoft、Mistral、Cohere、DeepSeek、阿里 Qwen、Moonshot(Kimi)、MiniMax、百度、腾讯、字节/豆包、智谱、阶跃、快手可灵、Midjourney、Stability AI；本轮验收日按 8 月 13 日窗口执行。

每家公司的官方发现面：X handle（`--responses-x-search --responses-allowed-x-handles <公司>`）、官方 News/Blog RSS、官网 News 页。**覆盖自检**：Phase E 输出每家的"有动态/无动态/未达"三态，末尾列进报告。

## 5. 搜索面与抓取

- **seed 扫描（编排器阶段0，Bash 跑 grok-search node 脚本）**：
  - X 官方搜索（xai, OpenAI, GoogleAI, AnthropicAI, NVIDIAAI, DeepSeek…）；
  - 官方 RSS 直抓：x.ai/news、openai.com/news/rss、research.google/blog/feed、anthropic.com/news、huggingface.co/blog/feed、arxiv.org/list/cs.AI+cs.CL/recent、量子位/机器之心/36氪 今日页；
  - 结果合并去重 → `seed_URLs.json`（含 url/title/found_via/date）。
- **workflow Phase B**：每任务子代理先读分配给它的 seed URL 段，再可选 WebSearch 补搜（本轮 WebSearch 配额用尽时自动降级为纯 seed + 官方通道抓取）。
- **Phase C 抓取**：每 URL 一个 extract 子代理（WebFetch），输出 2-3 条 falsifiable claims。
- **预算重设**：每任务 ≤6 条；MAX_FETCH 20；**板间轮询公平分配**（每轮每板块至多取 1 个未抓 URL，保证晚序板块不被挤掉）；URL 规范化去重贯穿全程。

> **8/13 深夜优化（tokens/速度）**：此前单次全跑烧 >2.2M token 且未跑完。根因=共享 feed（techcrunch/qbitai）被 6 个板块 discover 代理各自全量抓一遍 + verify 阶段每票跑 WebSearch（1.14MB tool_result）+ fetch.js 完整文件路径泄漏进模型上下文。8/14 凌晨完成四项结构性修复：
> 
> 1. **Harvest-once 独立阶段**：全量 feed 去重后由独立 harvest 代理预抓一次（每个 feed 输出紧凑 digest，≤15 条 URL +  ≤4 条重大近窗项），注入到 discover 代理 prompt 中；discover 代理彻底移除 fetch.js，上下文结构封顶。效果：harvest 代理 22–57KB，discover 代理 53–82KB（原 160–256KB）。共享 feed（techcrunch/qbitai 等）只抓一次，不被 6 个板块各抓一遍。
> 2. **fetch.js `--full-path` 默认关闭**：完整输出文件路径不再出现在 JSON 响应中，消除模型 `cat` 完整文件（148KB）进入上下文的泄漏路径。
> 3. **Verify 移除 WebSearch**：原 prompt 第 5 步"（可选）WebSearch 找矛盾证据"导致每核查票跑 1–2 次 WebSearch（27–69KB/次），54 个 verify agent 的中位数 37KB、峰值 135KB，共烧 1.14MB 纯 tool_result。改为纯内部一致性判断，**禁用 WebSearch/WebFetch**。预期 verify agent 降至 15–25KB（待验证）。
> 4. **Per-agent 截止时间**：`safeAgent` 内嵌 Promise.race 对抗 360s 死线（`agentTimeoutMs` 参数可调）；任何静默卡死（deepseek 网关 524/模型发了工具结果后无回复）降级为 `null`，由 `safeAgent` 的已有重试逻辑用全新代理重试一次，不再无限堵死整个 parallel/pipeline 闸门。9 板全量跑建议设 420s。
> 
> **8/14 凌晨补充（第五项：写盘不再走 writer 代理）**：3 板验证跑暴露 JSON 落盘全链路失败——`verified-claims.json` 写入后消失、`meta.json` 出现 control-char 非法 JSON。根因：b64Writer 把 ~20KB base64 塞给 LLM 代理逐字节转录，LLM 无法保证字节级复写；两个失败 writer 各烧 ~270KB token（纯浪费，5 个 writer 共 741KB）。**修复：workflow 把 3 个 JSON 的 payload 字符串原样放进返回值 `payloads.{claims,sources,meta}`，由主会话（orchestrator）用 Write 工具逐字节落盘**；md 仍由 mdWriter 代理（Write 工具）落盘（已验证可靠）。收益：消除 741KB writer token + 100% 消除 control-char/丢文件类写盘失败。
> 
> 效果预期（3 板验证跑中）：总 transcript 约 1.5–2MB（原 3 板 >1MB+），verify 代理尺寸腹部明显左移；不卡死、可完成。
> 
> **8/14 午间补充（第六项：源预算压缩，速率优先）**：9 板全量跑实测 **55 min / 4.56M tokens / 221 agents**，其中 fetch 48 + verify 144（48×3 票）占 ~87% 代理数。用户要求"少找数据源、更快"。已下调：`MAX_FETCH 48→20`、`MAX_VERIFY 48→24`、`MAX_URLS_PER_BOARD 12→6`、提取声明 2-5→2-3 条/URL；共享 feed 18→14（砍 github trending / HN / 极知心 / arxiv cs.LG）。**fetch 预算改为板间轮询公平分配**（原按 boards 顺序消耗全局 quota，预算收紧后 labs/strategy 会挤掉 policy/safety/people——必须修）。预期代理数 221→~121、耗时 ~30min；已核查条数 48→24（正文条目相应变少，属速率优先的显式取舍，必要时可调回）。

## 6. 验证（质量核心）

- **3 票对抗核查**（refute 优先，≥2 票 kill）；恒默认 refute=true 除非证据充分。不足 3 票（代理失败/null）时补轮至满，最多 2 轮；**无第 4-5 票独立复核**，无第二来源交叉验证（核查为纯内部一致性判断，禁用 WebSearch/WebFetch）。
- **时效核查**：claim 必须带 publishDate。窗口内 = `[T-2, T]`，正常入正文；**超窗分两档**：
  - **重大超窗事实**（行业里程碑级公认客观事件，如 DeepSeek V4 开源、Grok 4.6 发布、Harness）——即使不在窗口也必须进正文，标注 `[窗口外·重大]`，可出现在执行摘要与头条；由发现代理 `majorOutOfWindow` 字段 + 种子 `KNOWN_MAJOR_OUT` 收集，绕过 fetch/verify 直注 report。**未经窗口内对抗投票**：`verdicts:[]` + `vote:'—'` + `verifiedByVote:false`，reportBody 统一渲染 `Vote: —（未投票，多源公认行业里程碑）`，不得冒充 3-0。
  - **次要超窗项**——仅在文末 `## 📎 窗口外参考` 如实引用，不得混入正文（防误标为窗口内新闻）。
- **来源核查**：X/官方声明校验 handle 与官方域名，防范冒充（参考 knownagents AI 爬虫冒充事件）。
- 输出每 claim：survives / refuted / unverified + 投票明细 + confidence。

## 7. 合成与产出

- **Phase F 终稿合成 agent**：输入全部确认 claims + 投票证据；按 9 板块组织；去语义重复；头条置顶；每条含标题/要点/详情/来源/可信度；文首执行摘要 + "今日一句话"；文末附未验证项、覆盖矩阵、开放问题。
- **产出物**（阶段2 落地）：
  - `docs/daily/YYYY-MM-DD-ai日报.md`（人类可读日报）
  - `docs/daily/YYYY-MM-DD.verified-claims.json`（全量 claim+投票+来源）
  - `docs/daily/YYYY-MM-DD.sources.json`（抓取来源清单+质量等级）
  - `docs/daily/YYYY-MM-DD.meta.json`（耗时/用量/降级标记/覆盖矩阵）
- **失败降级**：核查全部失败 → 出"未核查日报"（标注 + 原始 claims）；终稿失败 → 保留已验证数据归档，不丢弃。

## 8. 模型策略（本期）

- 全链路统一 **deepseek-v4-flash**（用户指定"先统一用"）。
- 预留 future toggle：`scope/verify/synthesize` 可切 `claude-opus-4-8 / claude-fable-5`（网关不稳时的备选加固方向，本期不启用）。

## 9. 调度

- **launchd LaunchAgent**（`~/Library/LaunchAgents/com.mango.ai-daily.plist`）：每天 08:40 执行 `~/.ai-daily/run-daily.sh`（headless `claude -p "运行 ai-daily 日报" --model deepseek-v4-flash --dangerously-skip-permissions`，工作目录 = obsidian 库；8/13 曾用 `--no-input` 报 "unknown option" 已修；8/14 加"当日报告已存在则跳过"幂等逻辑）。
- **8/14 验证（headless 编排可用）**：`claude -p "调用 Workflow…probe-sleep.js" --model deepseek-v4-flash --dangerously-skip-permissions` 实测：全程 ~45s（含 ~35s CLI 冷启动），`claude -p` 会**等待后台 Workflow 完成并返回其返回值**，不会中途退出。run-daily.sh 无头链路成立：launchd → `claude -p` → skill → Workflow → 主会话拿到 `payloads` 逐字节落盘。
- **手动**：`/ai-daily`，支持 `--date YYYY-MM-DD`（补历史日）、`--force`（重跑当日）。
- 说明：`CronCreate` 仅会话内有效且 7 天过期，不用于持久调度。

## 10. 验收标准

1. **覆盖**：日报含全部 9 板块；花名册每厂商有明确三态；头条包含该日最重要的官宣或公认事实（如 Grok 4.6 发布、DeepSeek V4 开源这类，即使不在窗口也以 `[窗口外·重大]` 呈现于正文）。
2. **质量**：每条 claim 有来源链接、publishDate、可信度；抽样 10 条人工核对来源与日期无误。
3. **可靠**：连续 3 天跑无失败；WebSearch 不可用或网关降级时出降级报告而非空跑；中断后可续跑。
4. **产物**：md + 3 类 json 齐全，命名规范，可回溯。

## 11. 未来方向（本期不做）

- 头条/摘要模型档位提升到 claude opus/fable；
- 周报聚合、跨日趋势、厂商动态追踪（每日对比昨日）；
- 与 obsidian-doc-router 的命名/索引规则对接。
> **8/14 午间补充（第七项：投票标注失真修复）**：2 板冒烟发现 `[窗口外·重大]` 条目被 `_mkMajor` 注入 `verdicts:[3×refuted:false]` + `vote:'3-0'`（8/14 凌晨补丁遗留），md 渲染成"3-0 对抗核查"——但 major-out 并未经窗口内投票。已修复：`verdicts:[]` + `vote:'—'` + `verifiedByVote:false`；`reportBody` 对 major-out 渲染 `Vote: —（未投票，多源公认行业里程碑）`，claims 归档 `vote:'—'` + `verifiedByVote:false`。语义：major-out 可入正文/头条（用户认可客观事实），但**不得冒充窗口内投票结果**。

> **8/15 补充（第八项：结构性降本——9 板块 + 对抗核查语义不变）**：8/15 全量跑实测 **93 代理 / 2.06M token / ~2h / 20 个代理报错**，7/9 板块自检降级、23/23 厂商 unreached，产出仅 ~3 条窗口内新 claim。用户明确"快 1M token 找新闻得不偿失"。本轮按已批准计划做纯结构降本，**9 板块覆盖矩阵 + 对抗核查语义（≥2 否 kill、存活需 ≥2 票）不变**：
>
> 1. **Harvest 14 并发 → 5 分组串行**：14 个单 feed 代理合并为 5 个批代理（official/cn-media/en-media/opensource/academic），每条目带 `feed` 标签归栈；3 个一组串行执行；`feedMaxChars` 扁平化为 12000。缓解"14 并发打爆网关 → 524 风暴互为因果"。
> 2. **Discover 9 代理 → 5 分组**：6 个媒体板合并为 media-cn（qbitai+36kr → strategy/funding/policy/safety/people）与 media-en（techcrunch+theverge+qbitai → strategy/products/funding/policy）；labs/opensource/academic 单板。`DISCOVER_GROUPS` 从 `boardKeysSel` 派生、URL 带 `board` 标签展平。X 搜索预算 labs≤5、media≤4、opensource/academic≤3；WebSearch 全流水 ≤4。
> 3. **核查 3 票 → 自适应 2+1**：round0 并发 2 票——双否 kill、双放行存活、1-1 分歧补第 3 票；终判规则与现网逐字一致（survives ⇔ refuted<2 ∧ valid≥2）。全量跑 12 条核查：7 确认（3 条 2-1、4 条 2-0）+ 5 否决（3 条 0-2、2 条 1-2），2 票快路径实际生效、平均 ~2.3 票/条。
> 4. **重试策略**：harvest/discover/核查票 `tries=1`（失败不换新代理重跑、费用不翻倍）；fetch/report/mdWriter `tries=2`；`AGENT_TIMEOUT_MS` 480000→360000。report/mdWriter 单独 `timeoutMs:480000`（终稿合成是最大代理，8/15 冒烟在 360s 死线两超导致 md 未写出——已修）。
> 5. **预算 + effort**：`MAX_FETCH 20→12`、`MAX_VERIFY 24→12`（延续 8/14 速率优先取舍）；机械代理（harvest/fetch/票）`effort:'low'`。
>
> **实测（8/15 全量，9 板）**：93→**52 代理**（-44%）、2.06M→**1.156M token**（-44%）、~2h→**26.4min**（-82%）、20→**0 报错**。产出：7 条窗口内 claim 全过核查 + 6 条 [窗口外·重大] 注入（vote:'—'/verifiedByVote:false 语义不变）+ 5 条被否（如实排除）+ 0 未核查；md + 3 JSON 全部落盘。degraded 仅 2 项如实上报：fetch_budget_dropped:14、discovery_degraded:missing_labs。对照计划门禁（≤~55 代理 / ≤~0.9M / ≤45min）：代理与墙钟达标、token 1.156M 超软目标 28%（继续压需减 fetch/verify 条数，即正文章条变薄的显式取舍，本期保留 12/12）。
>
> **验证中发现并修复：disc:labs 结构性超时**——labs 发现代理要跑 23 家厂商花名册、14 次工具调用，实测 536s > 360s 死线；且超时不终止代理、仍在后台空烧 token。已修复：disc:labs 单独 `timeoutMs:600000`（把已完成的工作变成可用结果，旗舰板不再丢覆盖）+ 预算纪律强化（发现阶段禁止 WebFetch 连续深挖单公司官网，X 搜索 4-6 handle 批量一次覆盖）。定向 labs 验证跑（8/15，单板）：28 代理 / 596k token / 15min / 0 报错；disc:labs 600s 内完成，23 家厂商全部三态（OpenAI/Anthropic/xAI/DeepSeek 有动态，其余 19 家无动态，**0 unreached**），`degraded:[]`——旗舰板覆盖修复确认。
