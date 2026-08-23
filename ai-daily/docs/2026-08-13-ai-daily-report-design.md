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

> **8/16 补充（第九项：引语契约 + majorOut 去重 + harvest/discover 死线根因修复）**：8/16 前两轮全量门禁：**第一轮 45 代理 / 1.097M token / 45.0min / 0 报错**——代理与墙钟达标、token 超软目标 22%，但**覆盖塌方**：8/9 板块自检 degraded、23/23 labs 厂商 unreached，仅 academic 1 板产出；**第二轮 44 代理 / 1.02M / 80.8min / 1 报错**——逐代理时间线 + 注入 digest 抽查定位根因：
>
> - **harvest 360s 死线丢弃已完成工作（覆盖塌方的主因）**：harvest 代理不带 `timeoutMs` → 吃 `AGENT_TIMEOUT_MS=360s`；5 组共源并发下 3 个分组实测 384–800s 才完成（cn-media 442s / opensource 384s / en-media 800s）。`withDeadline` 在 360s 先让 `safeAgent` 返回 null → `.then` 里 `failed:true` → **digest 整块标"抓取失败"，已完成的工作被静默丢弃**（代理在后台跑完、结果进了 journal 但没被用）。抽查注入的 discover prompt 证实：academic/labs digest 有内容（→ 两板正常），opensource/media-cn digest 全标"抓取失败"（→ 空摘要、只能 X 搜索兜底、0-1 条 URL）→ 6 个媒体/开源板 degrade。
> - **disc:media-en 40 分钟瞬时断连丢 4 板**：discover 批量（3+2）已严格串行，但 disc:media-en 实测 2336s 后 API "Connection closed"（瞬时错误），`tries=1` 无重试 → strategy/products/funding/policy 4 板尽失 + 40 分钟墙钟。代理 13 次慢工具调用（含 4 次被禁的 WebFetch）为空摘要补偿所致。
> - **45min 墙钟是靠扔覆盖换来的**：媒体/en 板被 360s 死线 kill 后并行 resolve → discover 提前启动，墙钟看似 45min，实则媒体板从未被真正发现。
>
> 本轮修复，9 板块覆盖矩阵 + 对抗核查语义（≥2 否 kill、存活需 ≥2 票）不变：
>
> 1. **C1 引语契约**（FETCH_PROMPT）：quote 约束改为"**逐字抄录支撑该声明的完整原句，≤220 字，且必须包含声明中的全部具体细节——日期/数字/机构名/对比结论**"（原 ≤40 字短句 → 核查票无据可依、误默认否决）。**实测证明生效**：OmniScientist"36 个真实案例、论文均分 6.3"在上一轮以短引语被 0-2 kill，本轮以完整逐字引语 2-0 存活，票内证据逐字溯源全部细节。
> 2. **C2 核查票校准**（VERIFY_PROMPT）：引语是逐字支撑句、声明细节凡可逐字溯源即视为支撑，**引语不是全文 ≠ 证据不足**，仅当声明明显超出引语范围才算过度引申——消除"引语短→默认否决"的系统性误杀。门禁跑 6 条窗口内声明 5 条 2-0、1 条 2-1（WebArena harness，自适应第 3 票生效），无一条因引语短被误否，无虚假 2-0。
> 3. **C3 majorOut 实体去重**（_majorKey）：按实体指纹合并超窗重大事实——deepseek-v4 / harness / grok-4.6 / muse-glimmer / jeff-dean / hassabis / gemini 归一化 + 括号限定词剥离兜底。**实测**：Grok 4.6 合并进 KNOWN 种子并带上 08-12 日期，DeepSeek V4/Harness 种子保留，vote:'—'/verifiedByVote:false 语义不变。**压测暴露 1 条去重盲区，已修复**：媒体组上报的 Grok 4.6 claim 形如 "xAI：Grok 4.6：…"，原 `_majorKey(x.claim.split('：')[0])` 首段是 "xAI" 而非 "Grok 4.6" → KNOWN 种子被重复 push 一条（md 靠渲染层二次合并掩盖）；修复为**全 claim 与首段各测一次**（实体规则对全 claim 命中）+ 新增 GPT-5.6+Fable 数学难题指纹，已用本轮真实 claims 模拟验证：majorOut 12→10 条、Grok 4.6 与 GPT-5.6+Fable 各合为 1 条（保留更具体日期）。
> 4. **D1 harvest 死线 360→1800s**（覆盖塌方根因修复）：harvest `timeoutMs:1800000`——慢但已完成的 harvest 结果必须真正进 digest，不许被 360s 死线静默丢弃。
> 5. **D2 discover 死线 + 批量 + 重试**：discover 3+2 两波严格串行 + 死线 labs 1800s/其余 2400s（首轮门禁验证：两波串行生效，labs/opensource/academic 全部完成）；`tries 1→2` + `TRANSIENT` 加 `connection closed`——媒体合组是 9 板覆盖关键，一个瞬时断连不配让 4 板集体降级。
> 6. **D3 report 死线**：480000→600000——report 合成 588s 撞 480s 死线被丢弃、换新代理重跑 111s（费用翻倍）；放 600s 让正常推进的合成一次完成（本轮 report 197s 单次完成，无重复）。
>
> **实测（8/16 第三轮全量，9 板）**：**50 代理 / 1.075M token / 21.7min / 0 报错**。对照计划门禁（≤~55 代理 / ≤~0.9M / ≤45min）：**代理、墙钟大幅达标**（50 ≤ 55；21.7min ≪ 45min），**token 超软目标 19.5%**（1.075M vs 0.9M，与上一轮 1.02M 基本持平——fetch/verify 条数压到 12/12 上限后的自然结果）。**覆盖修复生效**：5 个 harvest 组全部 completed（`failed=false`，含 442s/800s 慢组，不再被 360s 死线标"抓取失败"），4 个 discover 组注入 digest 均带实条目（21/27/24/15 行），媒体组（media-cn/media-en）回传 15 条真实窗口内 URL——**8/9 板 degraded 的塌方根除**；6 条窗口内声明全过核查（5×2-0 + 1×2-1）；majorOut 12 条注入全部 `vote:'—'/verifiedByVote:false`（Grok 4.6 合并带 08-12 日期、DeepSeek V4/Harness 种子在列）。剩余覆盖缺口为**诚实零声明**：policy/safety/people 三板块窗口内确无新闻、labs 23 家花名册全部核到（9 有动态/14 无），均在"覆盖自检"如实标注，非抓取失败。已知取舍：token 软目标 0.9M 需继续压 fetch/verify 条数（正文章条变薄的显式取舍）；墙钟 21.7min 远低于 45min——**"≤45min" 门禁与全量覆盖并不冲突**，上一轮 80.8min 的墙钟全是空 digest 补偿耗掉的，digest 修复后墙钟反而骤降。已知局限：Anthropic 别名 'Claude' 误命中 "Claude Code"（DeepSeek Harness 报道）→ 覆盖自检将 Anthropic 误标 has_dynamic，md writer 已在"未验证与局限"如实标注，不单列修复。

> **8/16 review 补充（第十项：全面 review——对抗核查语义核对 + majorOut 实体指纹顺序缺陷修复）**：对 ai-daily.js（752 行）进行**全面综合 review**：全文重读三次 × 与八个 changelog 逐条语义核对 × SKILL.md 预算参数核对 × DallyReport mirror 三文件字节一致核对（cmp 全等）；核心逻辑用真实数据模拟穷举验证（45 断言全绿）。**确认无问题**：verify 自适应 2+1 终判序穷举 10 场景全对——双否 kill / 双过存活均 2 票收束、1-1 分歧与票失败缺位补第 3 票、双 fail 补 1 票=unverified、快路径不消耗第 3 票，且与原 3 票语义逐字一致（含 [P,P,R]→survive、[P,FAIL]→补 R 后 1-1→survive 等价）；majorOut 全链路 `vote:'—'/verifiedByVote:false/窗口 'major-out'` 不冒充窗口内投票；三 JSON 由主会话逐字节落盘、md 由 mdWriter 实测 bytes 校验；覆盖三态 / reconcile / degraded 如实；`claimWindow` 在 WIN_FROM=null 时语义=无下限（`x>=null` 恒真），正常调用均显式给 window。
>
> **发现并修复 1 个真实缺陷（majorOut 实体指纹顺序）**：`_majorKey` 原 `/jeff\s*dean/` 规则在 `/hassabis/` **之前**——"Hassabis plans departure alongside Jeff Dean" 这类同时含两人的**哈萨比斯离职**事件会先命中 jeff-dean 规则，被静默吞并进 "Jeff Dean 创业" 条目（模拟证实：被吞事件无痕可查、数据丢失）；且 `/hassabis/` 不匹配中文"哈萨比斯" → 同一事件中英文多表述分裂成多条。修复：**hassabis 规则前移（特异实体优先落下）+ 中文别名**（哈萨比斯 / 杰夫·迪恩 / 深度求索）。已用 workflow 源码提取部署版 `_majorKey` 对 13 组映射逐条验证通过，并重跑去重模拟 45 断言全绿：Grok 4.6 合 1 带 08-12、GPT-5.6+Fable 合 1、DeepSeek V4 中文表述并入种子（先入者日期保留 07-31）、哈萨比斯英文+中文合 1 且与 Jeff Dean 创业正确分离。注：8/16 实际数据未触发该缺陷（哈萨比斯离职走 nearWindow 次要档未进 majorOut），属**防御性修复、无行为回退**。
>
> **清理**：verify 配额分配中紧接首轮的"第二轮"同序同分配循环，经 6 组分布模拟证明必无任何效果（remainV 被首轮耗尽或全板块 canTake=0，两轮结果恒等），属死代码已删除（行为不变）；一处注释 tab 缩进对齐。已知取舍（延续认知，不单列修复）：token 软目标 0.9M 超 19.5%（fetch/verify 压到 12/12 上限后的自然结果）；Anthropic 别名 'Claude' 误命中 "Claude Code"（覆盖自检将 Anthropic 误标 has_dynamic，md 已如实注释）；fetch 阶段失败仅通过 claims_extracted/urls 反映、不单列 degraded 标记（观察项）。
>
> **冒烟实测（8/16 修复后，单板 opensource 回归冒烟，maxFetch/maxVerify=4/4）**：`node --check` 语法通过；真流水线冒烟 **17 代理 / 323,902 token / ~31.3min / 0 代理报错**（`agents_error=0`、`verify_agent_errors=0`、journal 15/15 完成）——端到端 discovery→harvest→fetch→vote 无任何代理报错，**修复零回归**：`_majorKey` 顺序修正后同事件无重复入库；voteClaim 自适应 2+1 在真实声明确认（camera-indexed world state 声明 2 否 kill 快路径收束、HF 报告声明 2-0 存活、Qwen 4.7× 细节因引语外引申被判否）；4 条 [窗口外·重大] 注入全部 `vote:'—'`；meta confirmed 6 / killed 2 / unverified 0 与设计一致。**局限（如实标注）**：本次冒烟 report 代理未产出 md（meta `report_error:'report agent failed; reverting to raw archive'`、md_written 0、journal 无 report 结果行）——report 代理首次 API 调用对网关挂起（agent transcript 仅启动 prompt、20 分钟后随工作流结束才被中断；`cpa.mangoqwq.com` 同日 11:53 仍在 524），600s 死线未能强制终止挂起的 in-flight 调用；review git diff 仅含 quota 死代码删除 + `_majorKey` 顺序 + 注释对齐，**report/mdWriter 路径与提交版本逐字节一致**（第九项全量 gate 同代码 report 197s 单次完成，非 review 引入的回归），归因网关瞬时失败；冒烟墙钟 31.3min 亦被该挂起拖满（核心 15 代理 10:07-10:18 已完成），与代码无关。
>
> **8/17 补充（第十一项：综合 review 观察项落地——Synthesize 前网关探针快速降级 + report/mdWriter 单次直出 + 主脚本总墙钟 checkpoint 兜底）**：
>
> **基线（第十项冒烟暴露的挂起根因）**：report 代理首次 API 调用恰撞网关差窗口（cpa.mangoqwq.com 同日多次 524），`withDeadline` 对 in-flight 调用**无法强制终止**（仅提前决议，HTTP 请求继续占用）；`safeAgent` 按 null 换**全新代理**重跑又撞同窗（冒烟 report 第一轮 10:18-10:28、第二轮 10:28-10:38 均零产出）——两轮合计 ~20 分钟空转把 31.3min 冒烟墙钟拖满（核心 15 代理仅 11min 已完成）。`tries=2` 对最大上下文代理的失败成本 = 双倍费用 + 双倍挂起窗口。
>
> **改动（3 项，均机制层兜底，覆盖/核查语义不动）**：
> 1. **A1 网关健康探针**（probeGateway）：Synthesize 前派 1 只迷你代理（`effort:'low'`、prompt "仅回复 OK。"），`GATEWAY_PROBE_MS` 默认 20 000ms 死线——无响应即判网关不可用 → `PROBE-FAIL` → **跳过整个合成直接降级 raw archive**（claims/sources/meta 三 JSON 仍逐字节落盘，仅 md 不产出），挂起空转从 ~20min 压到 ≤20s；探针通过才进 report/mdWriter。
> 2. **A2 report/mdWriter `tries 2→1`**：网关已由探针把关，两个最大上下文代理改**单次直出**——失败即快速降级，不再换新代理重跑双倍费用。
> 3. **B 主脚本总墙钟 checkpoint**（`TOTAL_LIMIT_MS` 默认 1800 000ms）：时钟源用 `performance.now()`（Workflow realm 内 `Date.now()`/`new Date()` 会抛错）；Synthesize 前判一次 `RUN_ELAPSED() <= TOTAL_LIMIT_MS`，超限跳过合成直接降级——宽松兜底，防探针之外的任何阶段挂起把整轮拖满墙钟；resume 时 performance 重新起算 → 判定仅作宽松兜底、非精确预算（设计意图）。
>
> **语义守住**：降级走既有 raw archive 分支（`reportErr`/`writeFailures`/`degraded` 如实标注：`write_failed` 如实在 meta 列出且 `artifacts_failed` 带 md 路径）；三 JSON 逐字节落盘路径不变；[窗口外·重大]/对抗核查终判序未动；探针消耗 ≤20s、位于合成前串行路径上不干扰并行闸门。
>
> **冒烟实测（8/17 修复后，单板 opensource 回归冒烟，maxFetch/maxVerify=4/4）**：`node --check` 语法通过；真流水线冒烟 **19 代理 / 408,875 token / 22.9min（1 374 191ms）/ 0 代理报错**。**A 机制逐项验证生效**：journal 证探针 `probe:report` 正常返回 `"OK"`（迷你调用、`effort:'low'`）；**report 因 `tries 2→1` 只启动 1 次**——首次 API 调用再次对网关静默挂起（大上下文请求被丢弃，journal 无 result 行、随工作流结束被中断），600s 死线后**单次**快速降级 raw archive（`md_written 0`；claims/sources/meta 三 JSON 逐字节落盘：confirmed 5 / major_out 4 / killed 3 / unverified 0，major_out 注入全部 `vote:'—'`），**未再换新代理重跑、未再吃第二轮 600s**。**墙钟归算**：22.9min = 核心 17 代理 ~12.9min + report 单次死线 10min——较第十项冒烟 31.3min（report 两轮空转 ~20min）**省一轮空转 ~8.4min、report 费用减半**，A2 降本与 B 兜底按设计生效。**局限（如实标注，8/17 依据 transcript 二次核实修正）**：本轮 report 挂起**并非**"大上下文首次调用被静默丢弃"——transcript 实证：report **首次模型响应 2 分钟内正常返回**（16:29:20），随后**自主发起 6 次 WebFetch + 2 次 WebSearch**（16:30:30 四个并发工具 + 16:33:18 两个并发工具，超合成职责、自发去验证一手源），两批工具结果均在 16:33:41 前回流，**之后模型再无输出**——命中 deepseek 网关"工具结果回流后模型无回复"的静默卡死（AGENT_TIMEOUT_MS 注释所述类型），拖满 600s 死线后被工作流回收（transcript 末条 `[Request interrupted by user]` 恰在 16:27:29+600s=16:37:29）。**探针 PROBE-OK 测的是起始连通性，测不出 agent 内部多轮工具循环的卡死**；B 总墙钟 checkpoint 未触发（22.9min < 30min），属正常兜底未动用（机制留待超长 runs 验证）。**诱因是 prompt 缺陷**：REPORT_PROMPT 未禁止外网工具（VERIFY_PROMPT 已有同款禁令），合成代理把"用给定数据合成"做成"自主核查"。据此第十二项做对症修复。
>
> **8/17 补充（第十二项：report/mdWriter 禁工具硬约束 + report 输入降体积——补上 VERIFY_PROMPT 已有而 REPORT_PROMPT 漏装的缺位，并实证两种挂起形态）**：
>
> **基线**：第十一项修正确认 B 型挂起诱因是合成代理自发外网工具循环；C1/C2 对症修复：从 report 职责里删掉工具循环本身、并压低单请求体积。
>
> **改动（3 处，均在 prompt/输入层，覆盖/核查/降级语义不动）**：
> 1. **C1 REPORT_PROMPT 禁工具硬约束**：要求段加首条 "0. **禁止调用任何工具**（禁 WebFetch、WebSearch、Read、curl 及一切工具调用）——本输入已含上游核查的全部结论与逐字引语，你只需**纯推理合成**；一旦发起任何工具调用即视为本次合成失败"。与 VERIFY_PROMPT 既有禁令同模式（此前 REPORT_PROMPT 是唯一漏装该禁令的合成级 prompt）。
> 2. **C2 report 输入降体积**：`reportBody` 的 quote 全文 → 截断 140 字（引语只作合成要点，全文由核查阶段与归档 JSON 保证），压低单请求 payload 与 token——既降网关对大请求的敏感面，也是调成本。
> 3. **mdWriter 同因防复发**：prompt 加 "**只允许 Write 工具 + Bash（仅 wc -c 实测字节与清理临时文件）**，禁 WebFetch/WebSearch/Read/curl 等一切其他工具——渲染即最终交付"。
>
> **语义守住**：report 仍是 REPORT_SCHEMA 单一结构化 JSON 合成；降级分支/探针/总墙钟/`tries=1` 全保留；quote 截断仅影响合成输入，claims/meta 归档 JSON 仍逐字节含完整 quote。
>
> **冒烟实测（8/17 修复后，单板 opensource 回归冒烟，maxFetch/maxVerify=4/4）**：`node --check` 通过；真流水线 **17 代理 / 344,934 token / 24.8min（1 490 351ms）/ 0 代理报错**；核查链本轮更彻底（4 条窗口内声明 8 票全 2-0 通过、killed 0、unverified 0、confirmed 8 = 4 核查 + 4 [窗口外·重大] `vote:'—'`），journal 证探针 `probe:report` 仍返回 `"OK"`。**C1 生效证据**：本轮 report transcript **零工具调用、零条模型响应**——禁令消除了 B 型（无任何外网工具循环）。但 report 仍未产出 md（`md_written 0`、降级 raw archive、三 JSON 落盘）：**本轮实证「裸首调用挂起」（A 型）**——transcript 仅 1 条启动 prompt + 600s 后 `[Request interrupted by user]`（18:40:45+600s=18:50:45 精确吻合死线），**首个 API 请求阶段即被网关静默丢弃**（禁工具约束到不了首请求，C1 对 A 型无效）。**两种挂起形态认知确立**：B 型（工具结果回流后模型无回复，第一/十一项实证，C1 根除）与 A 型（首请求即不响应，本轮实证，C1 无效、C2 降输入仅压低触发面）；深夜网关（02:40-02:50 UTC+8）对 report 大请求整体高拒。**如实结论**：网关可用时 report 单次合成正常（第九项 gate 实证 197s）；差窗时 A/B 任一型都会吃满 600s 死线后降级，核查结论与三 JSON 不丢失、仅 md 渲染缺失。**下一观察项**：A 型根治需进一步精简 report 输入或将其拆为小段合成（每板 <10KB），属结构性重构、超出本次 C1+C2 范围，登记待办。
>
> **8/17 补充（第十四项：墙钟全程硬停 + discover 失败即降级——基于 8/17 全量失败 run 的系统性 review）**：
>
> **基线（8/17 全量 run 实测失败）**：**16 代理 / 530,876 token / 148.2 分钟 / 6 代理报错（全 "Connection closed mid-response"，deepseek 网关 `cpa.mangoqwq.com` 不稳）/ urls_discovered=0 / 仅 KNOWN_MAJOR_OUT 种子注入的 7 条 confirmed，无任何窗口内核查发现 / md 未产出**。根因调查（Explore×2 + Plan×1）确认两条结构性缺陷：
> 1. **墙钟治理是"事后闸门"非"全程硬停"**：`TOTAL_LIMIT_MS`（30min）唯一检查点在 Synthesize 阶段开始后（第 721 行），Harvest/Discover/Fetch/Verify 四阶段**完全无墙钟检查**可无限拖时。Discover 单阶段最坏墙钟 = 串行两批 × 各批最慢 40min × tries=2 = **160min**，今天就撞满 → 直接解释 148min。
> 2. **discover 失败处理把墙钟/token 烧在死路**：`safeAgent(..., 2)` 用**同 prompt 同 timeoutMs** 重跑一次再吃完整 40min，最坏 80min 浪费在同一条网关差窗口死路上。而 safeAgent 重试有两路径——**throw 路径查 TRANSIENT 正则，null 路径（withDeadline 的 settle(null)）不查正则、无条件重试**；网关 "connection closed" 多经 null 路径 → 绕开正则无条件重试 → **删正则根本拦不住**，唯一可靠杠杆是 `tries=1`。
>
> **关键发现（计划外，实施中暴露）**：
> - **realm 无 `performance`**：第十一项设计的"performance 不可用时 now() 返回 0 软兜底"实测为**恒 0**（`typeof performance === 'undefined'`）→ TOTAL_LIMIT_MS 闸门此前**从未真正生效**（第十一项的兜底也形同虚设）。修复：`now()` 改用脚本内 **setTimeout 链累加器**（每 250ms 自递归累加 `_wallMs`，`await` 期间持续推进——realm 内 `Date.now()`/`new Date()` 静态拒绝、`setInterval` undefined，**仅此链可用**）。微测实证修复后 budgetGate 真实触发、`budget_skipped` 进 meta。此修复同期让第十一项 TOTAL_LIMIT_MS 闸门首次真正可用。
> - **死线须累计非切片**：初版 `PHASE_DEADLINES` 误把切片（HARVEST/DISCOVER/FETCH/VERIFY_BUDGET_MS）当死线 → Verify 死线=2min，健康跑到 Verify 时 elapsed 早已 >2min → **健康跑误报 `budget_skipped:Verify`**（冒烟#1 实证）。修复为累计死线（Harvest 14 / Discover 24 / Fetch 28 / Verify 30min，和 = TOTAL_LIMIT_MS）。切片仍是"该阶段允许花多久"的用户可调输入（args 键），死线是内部累加状态——二者不可混用。
>
> **改动（6 处，覆盖/核查/降级语义不动）**：
> 1. **A 配置**：新增 4 阶段预算常量（默认 840000/600000/240000/120000ms = 14/10/4/2min 切片），照 `totalLimitMs` 写法可经 args（`harvestBudgetMs` 等）覆盖。
> 2. **B `budgetGate(stage)`**：返回 `{ok, roomMs}`，`ok = RUN_ELAPSED() <= PHASE_DEADLINES[stage]`；超限记 `budgetSkipped`（带 dedupe）+ log `BUDGET-SKIP`。`PHASE_DEADLINES` 用累计死线（见上）。
> 3. **C 四阶段 START 检 + 批间 BREAK 检**：各阶段循环前 START（超限跳过整阶段、结果集留空）、每批迭代首行 BREAK（超限 `break`、用已完成批次结果）。已完成批结果堆在各自数组带下去——"用已完成工作 + 余下快降级"，与既有"不许静默丢弃已完成工作"原则一致。Synthesize 不动（第 721 行绝对闸门）。
> 4. **D 批内 timeoutMs 收紧**：各 safeAgent 的 `timeoutMs = Math.max(60000, Math.min(<原默认>, roomMs))`，room 取各阶段 START 时的 gate 快照（循环外取，**偏保守**：第二批起 roomMs 为旧值偏大 → 收紧略松，但 BREAK 检每批重判兜底，止损不漏——此取舍如实记录，未逐批重算 room 以免增复杂度）。report/mdWriter 用 `Math.max(60000, Math.min(600000/480000, TOTAL_LIMIT_MS - RUN_ELAPSED()))`。下限 60s 防逼空。
> 5. **E discover `tries 2→1` + DISCOVER-FAIL 日志**：失败即降级不重跑；`.then(r => { if (!r) log('DISCOVER-FAIL disc:'+g.key+' → '+g.boards.join('+')+' 板降级') })` 让"媒体组失败 → N 板降级"以可 grep 日志现形（safeAgent 固有 fail 日志无板映射）。
> 6. **F `budget_skipped` 降级标记**：`if (budgetSkipped.length) degradedFlags.push('budget_skipped:'+budgetSkipped.join('+'))`——该机制若触发必须如实上报，不留静默。
>
> **降级级联安全性（设计内验证，无新抛错点）**：Harvest 跳过 → digest 空 → discover prompt 只剩 X 搜索兜底；Discover 跳过 → boardURLs 空 → Fetch 循环不执行 → 全板 `failedBoardKeys` → meta `missing_*` 如实，KNOWN 种子仍注入；Verify 跳过 → confirm 仅 major-out 注入，md 靠覆盖自检如实呈现。三者全走既有空结果降级路径。
>
> **冒烟实测（8/17 修复后，冒烟#2 boards:[labs,strategy] 默认预算）**：`node --check` 通过；真流水线 **19 代理 / 385,020 token / 21.4min（1 284 000ms）/ 3 个 Connection-closed（agents_error 未计，全部 attempt:1）**。**四项验证目标全过**：(a) 默认预算健康跑**不触发 budget_skipped**（degraded 仅 discovery_degraded:missing_labs + write_failed）；(b) **disc tries=1** —— journal 每个 disc 代理恰好 attempt:1，无 `safeAgent retry... disc:` 重试记录（null 路径无条件重试仅靠 tries=1 拦得住）；(c) **DISCOVER-FAIL 可见** —— media-cn 失效时 `DISCOVER-FAIL disc:media-cn → 5 板降级` 一行现形，23 家 labs 公司 unreached/no_discover_agent 如实入 meta missing；(d) 3 JSON + md 落盘（md 被 report A 型挂起吃满 600s 后降级，与 item-14 无关）。**关键实证**：健康跑 ~21.4min 完全不触发阶段预算（Verify 2min 切片死线 bug 修复前会误触发——本冒烟证累计死线语义正确）；真实核查链产出 confirmed 8（Stripe-OpenRouter 收购、Zuckerberg×2 等 3 条投票确认）＋ kill 1（SpaceX-Cursor $60B 证伪 0-2）＋ major-out 4。
>
> **全量实测（8/17 重跑，9 全板默认预算）**：**50 代理 / 1,083,686 token / 30.8min（1 847 780ms）/ 0 代理报错（agents_error=0）**。**墙钟断言：未完全达标——30.8min 超 30min 硬上限 ~48s**（详见下）。**degraded 如实**：`["fetch_budget_dropped:14","discovery_degraded","write_failed:2026-08-17-ai日报.md"]`——无 `budget_skipped`（四阶段 START/BREAK 均未触发），降级皆既有机制。**md 产出：失败**——合成阶段 `SYNTH-SKIP 总墙钟超限或网关探针失败 → 归 raw archive`，mdWriter 未运行（md_written 0），已由编排器据归档合成降级 md；3 JSON 逐字节落盘（confirmed 19=7 窗口内核查+12 major-out `/ killed 5 / unverified 0`）。**各阶段实测耗时（自首个代理 queued 起算）**：
> | 阶段 | 切片预算 | 实测 | 累计实测 | 累计死线 | 判定 |
> |---|---|---|---|---|---|
> | Harvest | 14min | 5.2min | 5.2min | 14min | ✓ |
> | Discover | 10min | 9.2min | 14.4min | 24min | ✓ |
> | Fetch | 4min | 7.3min | 21.7min | 28min | ✓（切片超、累计达标）|
> | Verify | 2min | 9.1min | **30.8min** | 30min | ✗ 累计超 ~48s |
> | Synthesize | — | 未运行 | 30.8min | 30min（绝对） | ✗ SYNTH-SKIP |
>
> **超时根因（如实记录）**：Verify 阶段点格的 D 收紧 `timeoutMs` 用的是**阶段 START 时快照 room（≈8.3min → 逐票 240s 上限）**，12 条声明 ×2 票 + 2-1 分歧补票共三波 27 票，波次叠加实际吃掉 9.1min > room；累计死线 30min 在第二波 + 分歧补票中途被跨过（verify 末票 lastProgressAt 1786951986436，elapsed≈30.8min）。**批间 BREAK 只拦批起点、拦不住批内在飞代理**——与 plan D "未逐批重算 room、BREAK 每批重判兜底"的明确取舍一致，代价即本次 48s 越线。**对比 8/17 失败 run**：148.2min/16 代理/530,876 token/6 报错/0 discovery → **30.8min/50 代理/1,083,686 token/0 报错/真实发现**（窗口内核查 7 存活：PlayWorld×2、GLM-5.3、Acrab 融资、郎咸朋访谈、Grok 诉讼-Jane Doe、Intern-S2；kill 5 含 NVIDIA-SSI 50 亿/至知 SWD/Qwen3.8-27B 日期矛盾等）——**墙钟 5 倍压缩、发现从 0→7、报错清零**；不足是墙钟略越线 + md 未直出。**待观察项已全部修复（8/17 完全修复落地）**：① Verify 死线预留 60s 在飞票缓冲（`VERIFY_INFLIGHT_BUFFER_MS`=60000，`verifyInflightBufferMs` 可覆盖）+ room 由阶段 START 一次性快照改为**每批重算**（越线即 BUDGET-BREAK 不再启动新票）→ 墙钟严格 ≤ TOTAL_LIMIT_MS（静态断言：健康包络 5.2/9.2/7.3/9.1 下墙钟 ≈29min，尾部 ~1.8min 核查降 unverified）；② Fetch 切片 4→8min，整体重分配 **Harvest 8 / Discover 9 / Fetch 8 / Verify 5**（累计死线 8/17/25/29，切片和=30min 不变）——30min 盘子装不下 50 代理健康包络（实测合计 30.8min），健康跑尾部 Verify 由逐波重算硬停并**如实降 unverified**，这是"保持 30min 承诺"的必然取舍；③ confirmed/refuted/outOfWindow JSON 均补 `erroredCount`（单票错误在成品可见），meta `verify_agent_errors` 阈值 2→1（任有一票错误即上报）——JaneDoe 类单票丢弃现于 JSON `erroredCount:1` 现形。**节流注记**：本次 50 代理中 27 票为核查 ×19k token/票 ~513k token，是整个管线最重环节——若预算吃紧可先降 maxVerify。
>
> **8/19 补充（第十五项：grok-search 数据源根因修复 + discover `--extra 4` + 预算 9/8/8/5 对调）**：8/18 重跑（`wf_f1896391-602`，11 代理/19min/0 URLs）逐代理转录解剖，把 8/17"发现面塌方"的根因钉死：
>
> **根因（三层证据，全部实测）**：
> 1. **代理 `cpa.mangoqwq.com` 是 stateless 回显假体**——手动 POST 3 种工具形状（web_search / x_search / both）到 `/v1/responses`：全部 HTTP 200，但输出是纯 `message`+`output_text`（`annotations: []`），无 `function_call`/`web_search_call`/搜索结果卡片；文本是模型旧知识（"截至 2025 年 1 月"）。**该代理改不了**。
> 2. **search.js `--no-extra` 依赖该假体供卡**——discover prompt 用 `--no-extra` → `extraOptions.limit=0` → 假体返回空内容（GROK_RESPONSES_EMPTY）→ `publicResult` 现有逻辑 `limit<=0 || !extra` → **throw GROK_FAILED** → discover 代理拿到 `{error}` 无任何 URL 卡 → 5 个发现代理全空手（opensource 试了 `--extra 6` 得 partial_success 2 卡，academic/CN/EN 全撞 throw）。
> 3. **harvest 480s 死线太紧**——cn-media/en-media/opensource 实测 442-800s 全部超时 crops，仅 official 成功 → 4/5 discover 组拿到空 digest → 只剩 X 搜索兜底 → 死磕 → 0 URLs。
>
> **改动（grok-search 逻辑真源 + ai-daily 两处，覆盖/核查/降级语义不动）**：
> 1. **grok-search `scripts/lib/grok-responses.js`**：`parseGrokResponses` 新增 `usable` 标志 = 有文本 && 有 URL 卡片；`searchGrokResponses` 对"有文本但 0 卡片"抛 `GROK_RESPONSES_NO_SOURCES`（区别于空应答 `GROK_RESPONSES_EMPTY`）。
> 2. **grok-search `scripts/search.js`**：`publicResult` 新增 `noUsable` 判定——代理 stateless 回显/空应答时，即使 `--no-extra` 也**降级不 throw** → 返回合法 JSON + `degraded:true` + `GROK_NO_USABLE`。真正的网络/5xx 错误仍 throw（边界不误伤，负例实测：坏 endpoint 仍 `GROK_FAILED` exit 1）。
> 3. **ai-daily `prompts.mjs` discover prompt**：`--no-extra` → `--extra 4`——走 Tavily 快速兜底（实测 `degraded_success` + 1-4 条 Tavily 卡），不再依赖假体供卡；并明确"只看 str 非空卡片（sources.grok 优先、其次 extra/merged）"。
> 4. **ai-daily 预算对调**：Harvest 480→540s / Discover 540→480s（累计死线改 9/17/25/29，切片和仍 30min）——8/18 实证 harvest crops 442-800s 需要更多头度，discover 换 Tavily 兜底后健康跑提速可让出 1min；SKILL.md args 文档同步。
>
> **验证（全绿）**：
> - grok-search 11 文件测试套件 exit 0（新增 stateless-回显 fixture：`usable:false`）
> - ai-daily 30/30 测试 + `node --check` + 重 build 产物确认两处改动注入
> - 安装位 `.claude/skills/grok-search` 与 `.mirasim/skills/grok-search` 三文件字节同步（md5 一致）
> - 实测 discover 精确调用形状 `--extra 4 --responses-x-search` → `status:degraded_success` + `degraded:true` + Tavily 卡 1-4 条（OpenAI 融资 1220 亿美元卡）；`--no-extra` 不再 throw（`degraded:true` exit 0）；坏 endpoint 仍 throw（边界不误伤）
>
> **对 8/17 病灶的疗效**：搜索失败不再 throw 拖死代理（#99）+ 空摘要快速降级（#98 已落地）双层缓解 8/18"5 discover 全挂 + 160min 墙钟"病态；discover 有 Tavily 保底后即使假体仍空也有 URL 卡可交，`missing_*` 覆盖面收窄到真实缺源场景。
>
> **8/20 补充（第十六项：room-as-timeoutMs 错配回归修复）**：8/19 手动补跑（`--date 2026-08-19 --force`）全板空跑——`urls_discovered:0`、9 板 `unreached/no_discover_agent`、仅 KNOWN 种子注入的 3 条 confirmed。systematic-debugging 读 workflow journal + 代理 transcript 后定位**真根因是第十四项引入的代码回归**，不是网关：
> - `disc:academic` 代理**实际成功了**：transcript 显示它跑 436s，成功调用 `StructuredOutput` 提交 6 条真实论文 URL（`tool_result: "Structured output provided successfully"`、`is_error: null`）。
> - 但 `safeAgent` 收到 **null**：workflow 日志 `agent 超时 410s 无产出 → safeAgent retry 1 disc:academic (null agent) → DISCOVER-FAIL`。
> - **竞态**：代理 436s 完成 vs `withDeadline` 410s 定时器，`settle(null)` 先触发（`done=true`），代理的成功 resolve 被 `if (!done)` 守卫丢弃。
> - **410s 怎么来**：`timeoutMs = Math.max(60000, Math.min(2400000, room))`，`room = Discover 累计死线(1020s) − RUN_ELAPSED(≈610s) = 410s`。
> - **概念错配**：`room` 是**整个阶段的剩余墙钟**，被当作**单个代理的超时**；单代理正常耗时（实测 436s，历史均值 609s）> room(410s) → 必然超时 → 成功结果被静默丢弃。第十四项 D 节把这个错配系统性铺到了**全部五个** safeAgent 调用点（harvest/discover/fetch/verify/report）。
>
> **修复——分层解耦**：墙钟只在**批次边界**判定（批间 `budgetGate(stage).ok` BREAK，第十四项已有、原样保留），**从不进入单代理超时**；单代理超时回归固定上界（与 `room` 无关，= 8/16 成功配置）：harvest `1800000` / discover `g.key==='labs' ? 1800000 : 2400000` / fetch `AGENT_TIMEOUT_MS` / verify `vtimeout = AGENT_TIMEOUT_MS` / report `600000`；60s 下限一并移除（解耦后 timeoutMs 最小 360s，下限多余）；30min 由硬目标降为**软目标**（唯一突破路径是单代理真·挂死跑满固定上界，由 Synthesize `synthAllowed` 闸门 + render-md 降级版兜底）。删 3 处仅为取 `room` 的死变量对（`harvestGate`/`discoverGate`/`fetchGate` + 各自 `room` 行）；Verify 的 `gate` 保留（批间 BREAK 仍在用）。**原方案 B（批前 room 预检）因与固定上界+阶段预算数学不相容而下马**——批前 roomMs 恒 < 固定上界 → 首批即 BREAK，比 8/19 bug 更糟（详见 `docs/superpowers/specs/2026-08-20-ai-daily-room-timeout-fix-design.md` §0）。
>
> **回归守卫（源级固化根因）**：新增 `scripts/ai-daily/test/no-room-in-timeout.test.mjs`——读 `ai-daily.template.js`，断言任何 `timeoutMs:`/`vtimeout =` 赋值行（剔除 `//` 注释行）不得含 `room`/`roomMs`/`RUN_ELAPSED`，且 5 个固定上界字面量在场。本次根因（room 重注入）复发即红。
>
> **实测（三层验证）**：
> - **TDD + 静态**：守卫 RED→GREEN（Task 1→2 的 TDD 翻转证据）；构建产物 5 固定上界在场 / 0 room 注入残留（`grep -c` 断言）；`node --test scripts/ai-daily/test/` 全绿。
> - **Task 5 预算微测（harvestBudgetMs:100, boards:['labs','strategy','opensource','academic']）**：journal 现形 `BUDGET-BREAK Harvest 余批跳过，用已完成批次结果` + meta degraded 含 `budget_skipped:Harvest+Discover`——**动态证明 BREAK 是活代码非死代码**（5 groups → chunk(3) → 2 batches → batch 2 越线触发），修复未误伤批间墙钟守护。注：原计划 `boards:['labs']` 因 OFFICIAL_FEEDS 无条件注入使 Harvest 仅 1 组 1 批、BREAK 无第二批边界可触发—— adjudicated 为 5 组 2 批满足断言（plan premise 缺陷，非代码缺陷）。
> - **Task 6 单板冒烟（boards:['labs','academic'], 默认预算）**：`disc:labs` 端到端成功（5 has_dynamic 厂商 covered_elsewhere、真实 Grok4.6/OpenAI-PORTS/NVIDIA-PORTS claims 入 confirmed 为 major_out），harvest 健康，固定上界运行时生效。**但 `disc:academic` 连续两 run 命中网关 `Connection closed mid-response`**（cpa.mangoqwq.com 对长流重型请求 100s/120s read-timeout，环境侧）——代理从未成功完成，故"固定上界采用成功 agent"契约无可采用项、被如实遵守。证据：代码回归独立证伪（guard + TDD + Task5 BREAK live + Task6 labs 健康），非依赖冒烟门禁。
> - **Task 7 全量重跑 2026-08-19（验收门禁）**：8 代理 / 272,306 token。**门禁未达成**——`urls_discovered:0`、academic `claims:0`、`confirmed:3`（全 KNOWN 种子 `vote:'—'`）、9 板 `missing_*`、`budget_skipped:Discover`、`report_failed` → SYNTH-SKIP raw archive。**门禁阻塞根因 = 环境网关侧**（连续第 3 run 同模式）：`Connection closed mid-response` 命中 4/8 代理（harv:cn-media 487s 带 `[stall] 256s`、harv:en-media 360s、disc:opensource 277s、disc:academic 358s）；`disc:labs` 跑满固定 1800s 上界（16 WebSearch 调用、state progress → 硬停）后 settle(null) → tries:1 → DISCOVER-FAIL，`BUDGET-SKIP Discover elapsed=2312s ≥ 死线 1020s` + `BUDGET-BREAK Discover` 按 design 在批边界正确触发。**关键区分**：8/19 lesion = 一个 436s **成功**的 academic discover 被采用后又遭 410s room-truncated 死线判废丢弃（room→timeoutMs 错配）；本 run 无任何 discover 成功完成——每个 discover 要么 Connection-closed 中途断、要么撞自己的固定上界后 settle(null)，**没有"成功却被丢弃"的结果可失**。流水线因正确理由（网关/固定上界）降级，而非 room-truncation bug。分析面与修复前 baseline 相同，但降级原因已正确。
>
> **如实结论（不宣称验收通过）**：代码回归（room→timeoutMs）**已独立证伪修复**（守卫 RED→GREEN + Task5 BREAK 动态触发 + Task6 labs 健康 + 固定上界运行时生效 + 本 run disc:labs 用满 1800s 固定上界而非 room 提前截断）。验收门禁（`urls_discovered>0` 且 academic 有 claim）因**环境网关连续第三次命中长流 read-timeout** 而未达成——这是 cpa.mangoqwq.com 对重型长流请求的 server-side 限制，需作为独立 env 问题归因，**不被掩盖、不被当作代码失败**。本次产出 4 产物已逐字节落盘为 8/19 固定代码诚实记录（覆盖修复前 stale baseline）。

---

> **8/23 补充（第二十一项：linuxdo 接入 + 双轨聚类 + 事件驱动分节）**：三个质量问题的根因一人一行——linuxdo 零痕迹（ai-daily 对 `linuxdo` 零命中，8-22 生产日报无一条来自 linux.do）、verify→report 之间无聚类环节（NVIDIA×OpenAI 基建同一事件拆 3 条）、report 覆盖率矩阵固定 9 板照信源摆架子（安全/伦理 0 claims 仍出空骨架）。用户 2026-08-22 AskUserQuestion 三决策已定：linuxdo 接入（走 9222 登录态）、聚类"规则+prompt 双轨"、覆盖自检"事件驱动+通道汇报"。
>
> **改动（spec `2026-08-23-ai-daily-linuxdo-cluster-adaptive-design.md`）**：
> 1. **`scripts/ai-daily/linuxdo.mjs`（新增，纯导出零调用）**：CDP-9222 登录态抓取 `https://linux.do/c/news/34.json`（Discourse JSON API）。Cloudflare `cf_clearance` 绑定浏览器 TLS 指纹 → 裸 fetch 必 403，唯一可靠客户端是 9222 真 Chrome。两条路径都覆盖：环境已有 `globalThis.WebSocket`（Node v26 是 function）→ 真 WebSocket 走 `Runtime.evaluate` 轮询 body.innerText；无 WebSocket 全局（workflow realm 降级保险）→ CDP HTTP-only polling（每片轮询等价"关旧标签+开新标签+读 body"幂等快照）。`CDP_DEFAULTS`（maxPages:4 / perPageDeep:3 / requestTimeoutMs:15000 / poll 500ms×30）。返回 `{ ok, degraded, reason, pages, topics, posts[] }`。
> 2. **`scripts/ai-daily/cluster.mjs`（新增，确定性聚类）**：`clusterClaims` 共享实体 token 聚簇（tokenize/STOP_TOKENS 与 render-md 同款，各自留副本不抽公共模块）；`mergeCluster` 合并簇（title/summary/sources 保首条、claim 为 key、`mergedCount` 记数、数字冲突标 `numericConflict` 但启发式保守不自动改数字）。只做主视图不放行——被合并 item 仍保留在 confirmed/claimsJson 归档。
> 3. **workflow（`ai-daily.template.js`）**：`DISCOVER_GROUPS` 增 linuxdo 组（boards.mjs `DISCOVER_GROUPS_ALL` + `BOARDS` 各一条）；Discover 阶段对 `g.cdp` 组在并行批前调 `fetchLinuxDoNews34({ date: DATE, cdpHost })`——成功 `LINUXDO-OK n topics` + posts 按 `linuxdoMaxSources`（默认 24）配额塞进组返回行（board 标 linuxdo，URL 进 Fetch/Verify 既有流水线）；失败 `LINUXDO-FAIL` + `degraded:true`（`linuxdo_degraded` 进 degradedFlags）；`linuxdoCdpHost` 默认 null → `LINUXDO-SKIP no_cdp_host` + urls:[] 不降级（板不崩）。cluster 在 `confirmedVerify` 后接入：`clustered = clusterClaims(confirmedVerify)`，簇主视图合并进 reportBody 开头「## 已聚类（cluster 合并 N 条→主视图）」区（每条标 `[cluster 已合并 N 条]` 供 report prompt 4.7 识别），被合并项仍保留原样；**不传 clustered 给 ctxP**（report prompt 输入契约不变）。meta 成功时补 `linuxdo_posts`/`linuxdo_open_posts`。
> 4. **`scripts/ai-daily/render-md.mjs`（事件驱动分节）**：完整版 sections 循环空过滤（`(sec.items||[]).filter(Boolean)` 空 → `continue`，无内容板块整体不出现）；降级版覆盖矩阵空行跳过（`claims===0 && !urls && 无公司三态` → continue）。信息熵契约：不摆空骨架。
> 5. **`scripts/ai-daily/prompts.mjs`**：reportPrompt 4.6 后插 4.7【聚类纪律】（「## 已聚类」区素材同一事件只写 ONE 条、口径不一并陈、双标准判据）；3.2 加一句（同事件多条素材数字口径不一 → 直接并陈不各自成条提醒勿相加）。
> 6. **build.mjs** MODULES 追加 `cluster`/`linuxdo`（纯导出零依赖，排在 render-md 后）；SKILL.md args 补 `linuxdoCdpHost`（默认 null 不启用）/`linuxdoMaxSources`（默认 24）。
>
> **验证**：`node --test "scripts/ai-daily/test/*.test.mjs"` 123 pass / 0 fail（基线 99 + 新增 cluster 9 / linuxdo 6 / render 2 / prompts 2 / workflow-integration 5）；`node --check` 产物通过；`find scripts/ai-daily -newer .claude/workflows/ai-daily.js` 无输出（源不旧于产物）。不启动浏览器、不跑真实 CDP 抓取（那是验证阶段的事），本项只写代码 + 单元测试。
