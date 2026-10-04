# ai-daily 开发文档（唯一总纲）

- **日期**: 2026-10-03
- **状态**: canonical — 开发/架构唯一总纲；运维/排障见 vault `Note/infra/ai-daily Workflow 运维.md`
- **取代**: `docs/` 下 4 篇 dated 设计文档（见 §13 历史索引）+ README 旧架构描述

## 速读（当前有效 · 维护于 2026-10-03）

- 生产 Windows 唯一：任务计划程序 `ai-daily`（每日 08:40）→ `run-daily-task.cmd` → `run-daily-win.sh` → `claude -p`（skill 编排）→ Workflow 产物 → `finalize.mjs` 落盘 vault `AI/DallyReport/<date>/`。Mac launchd 与 `~/.ai-daily` 已于 10-03 清流。
- 逻辑真源 = `scripts/ai-daily/*.mjs`（14 个 inline 逻辑模块 + 12 个宿主 CLI）+ `ai-daily.template.js`（编排骨架）；`build.mjs` inline 生成 3212 行自包含产物 `.claude/workflows/ai-daily.js`（repo 内），`--sync-vault` 一步同步产物 + SKILL.md 到 vault `.claude/`。
- 全链路预算：MAX_FETCH/MAX_VERIFY 16，五阶段墙钟切片 540/480/480/300s（总 1800s），report 单次 600s；对抗核查 2+1 票；跨天账本硬去重 + 昨日话题追踪 + 社区热度（10-03 五要素已上线）。
- 测试：`cd scripts/ai-daily && node --test test/*.test.mjs`（**必须 cd 进目录**，repo 根跑 glob 不中）；当前 453 项 444 pass / 0 fail / 9 有意 skip。
- 纪律红线：CDP 只复用 9222 已运行登录态 Chrome；日报正文写「社区」不点名站名；secrets 不入库不进 prompt；`--date` 全量重跑禁止（Iron Rule，单节修复 only）。

## 1. 系统总览

```
任务计划程序 ai-daily（08:40, StartWhenAvailable）
  └─ run-daily-task.cmd（Git Bash 包装，日志 C:/Users/mango/.ai-daily/task.*.log）
      └─ run-daily-win.sh
          ├─ 同日幂等（当日 md 已存在 → skip）
          ├─ linuxdo-prefetch.mjs（宿主 Node，CDP 只复用 9222 登录态 Chrome）→ linuxdo-prefetch.json 落盘
          ├─ claude -p「运行 ai-daily skill」× ORCH_LADDER 编排阶梯（每档先工具类探针）
          │    └─ skill → Workflow({scriptPath: .claude/workflows/ai-daily.js, args})
          │         ├─ Phase Harvest   分组批量串行抓 feed → 紧凑 digest
          │         ├─ Phase Discover  分组发现 + linuxdo 三态消费 + 兜底三级（harvest→static→救回）
          │         ├─ Phase Fetch     板间轮询公平配额 + linuxdo mint 直铸（不占配额）
          │         ├─ Phase Verify    2+1 对抗投票 + forum/blog 外部抽查票
          │         └─ Phase Synthesize report 阶梯合成 → render-md 确定性渲染 → return payloads
          ├─ artifact-check.mjs（宿主产物自检；workflow 失败时 host-finalize.mjs 找回）
          └─ 墙钟审计 + 日志轮转（keep 20）
```

**关键设计决策**：Workflow realm 无 fs/模块解析 → 产物单文件自包含，workflow 只 return payloads 不写盘；落盘提升为宿主确定性 Node 命令（finalize），消除 LLM 转录写盘的丢文件/control-char 类故障（8/21-8/22 实证）。

## 2. 仓库结构与双仓镜像

```
ai-daily/
├── ai-daily.template.js @ scripts/ai-daily/     # 编排骨架（1312 行）：realm 适配 + 五阶段编排
├── scripts/ai-daily/*.mjs                       # 逻辑模块真源 + 宿主 CLI
│   ├── 纯逻辑模块（build inline 进产物）：url-polyfill date-utils schemas boards dedup budget
│   │   wallclock ladder fallback prompts render-md cluster ledger linuxdo
│   ├── 宿主 CLI/模块（绝不 inline）：linuxdo-prefetch linuxdo-fetch cdp-fetch cdp-core
│   │   artifact-check host-finalize host-paths progress generate-poster finalize cli-main
│   └── test/*.test.mjs                          # 34 个测试文件，node --test 直调模块真源
├── .claude/workflows/ai-daily.js                # build 产物（repo 内，勿手改）
├── .claude/skills/ai-daily/SKILL.md             # skill 编排器（vault 侧另有同步副本）
├── run-daily-win.sh / run-daily.sh              # Windows 生产 / Mac（已清流，保留语义参考）
├── run-daily-task.cmd / register-task.ps1       # 任务计划程序包装与注册
├── docs/development.md                          # 本文档（唯一总纲）
└── docs/2026-08-*.md                            # dated 历史设计快照（见 §13）
```

**双仓镜像纪律**：`DallyReport/ai-daily/scripts/ai-daily/` 是版本管理真源（本仓）；vault `.claude/` 是运行时副本。**改模块逻辑 → 改 `.mjs` 真源；改编排 → 改 `ai-daily.template.js`；改完必须 `node scripts/ai-daily/build.mjs --sync-vault`**（构建 + 产物/SKILL.md 一步同步 vault，逐字节相同自动跳过；10-03 §12-⑥ 前为手工 cp）。`generate-poster.mjs` 有跨仓依赖（向上找 DallyReport 仓根 image-gen），两仓各一份镜像，层数不同。

## 3. 构建系统（build.mjs）

```
node scripts/ai-daily/build.mjs [--out <path>] [--check-only] [--sync-vault [vaultClaudeDir]]
# 默认写 ../../.claude/workflows/ai-daily.js（repo 内）
# --sync-vault（10-03 §12-⑥）：产物写盘成功后把「workflow 产物 + SKILL.md」同步拷入 vault
#   .claude/（默认 E:/profile/note/note/.claude，可跟目录参数或 AI_DAILY_VAULT_CLAUDE 环境变量）。
#   逐字节相同自动跳过（幂等）；同步失败只告警不判 build 失败。
```

四道护栏，任一失败不出产物：

1. **inline 顺序即依赖序**（MODULES 数组）：url-polyfill 最先（realm 无 URL 全局，缺失 → new URL() 抛错被 catch 吞 → 完整版 0 角标）；date-utils 在 boards/dedup 前（GROUPS_RAW 闭包引用 normURL）；cluster 在 ledger 前（指纹复用 clusterTokenize）。**10/03 起 cdp-core 移出 MODULES**——CDP 传输层（`fetch`/`WebSocket`）随 linuxdo 拆分归宿主 `linuxdo-fetch.mjs`，realm 不再需要。
2. **realm guards**：REQUIRED_MARKERS（linuxdoPrefetched / reportedLedger / webFetchViaCdp 消费入口必须在场）+ FORBIDDEN_INLINE（宿主 CLI 不得 inline、`process.*`/`require(`/裸 `fetch(`/`WebSocket`/`AbortSignal` 禁入 realm、禁裸调 fetchLinuxDoNews34）——防止「模板已改、产物仍走旧裸抓」的静默漂移。10/03 起从单条 `process.exit|require(` 扩为「宿主 Node 专有 API 整类拦截」，CDP 传输层偷渡不再可能。
3. **语法门**：产物 = 顶层 export(meta) + 顶层 await + 顶层 return 混合体，ESM/CJS 任一模式都非法。check 前断言顶层 export 有且仅有一行 `export const meta = {`，剥掉后整体包进 `async function __syntaxGate__(args)` 再 `node --check`（与 Workflow harness 以函数体语义加载同构）。
4. **占位符零残留**断言。

## 4. Workflow realm 约束（所有设计的根源）

| 约束 | 根因 | 适配 |
|---|---|---|
| 无 Date.now / new Date() / performance | 静态拒绝（resume 确定性） | setTimeout 250ms 自递归 tick 累加器 `_wallMs` 是唯一直接时钟；日期算术全走 date-utils 纯函数（`_calendarDayMinus` 纯日历逆推） |
| 无 fetch / WebSocket / fs / require / process | 单文件 realm | CDP 抓取前移宿主（linuxdo-prefetch）；落盘前移宿主（finalize）；产物只 return payloads |
| 无 URL 全局 | realm 未注入 WHATWG URL | url-polyfill 第一顺位 inline（仅 .href/.hostname/protocol） |
| args 可能以 JSON 字符串注入 | harness 偶发 | 模板头部兼容解包 |
| resume 从头跑 | 确定性要求 | tick 重新起算=重新计时；状态不跨 resume |
| TDZ 风险 | inline 后仍是函数体顺序 | REPORTED_LEDGER 等必须在对应模块 inline 之后赋值（09-20 实证事故） |

## 5. 五阶段流水线

模板常量（args 可覆盖）：`MAX_FETCH=16`、`MAX_VERIFY=16`、`MAX_URLS_PER_BOARD=6`、`AGENT_TIMEOUT_MS=360s`、`SYNTHESIS_LIMIT_MS=600s`、`LADDER_BUDGET_MS=900s`、`TOTAL_LIMIT_MS=1800s`、`WALL_CALIBRATE_MS=120s`（标定窗长，0=显式禁用）、`CDP_FETCH_CLI`（Windows 仓绝对路径）、`GROK_DIR`（C:/Users/mango/.agents/skills/grok-search）——后两项 10-03 P0-D 前硬编码 Mac 路径，Windows 生产下 9222 fetch 通道与 grok-search skill 全哑。

### Harvest（切片 540s）
- 唯一 feed 去重（feedMap，共享源只抓一次）→ GROUPS_RAW 5 组（official/cn-media/en-media/opensource/academic）→ `HARVEST_BATCH=3` 批量串行，`tries=1`，单代理上界 1800s（8/16-8/19 实证：360s 死线会丢弃已完成的慢结果）。
- 产出 digestByKey（normURL(feed) → entries≤15 + recent≤4），按 feed 标签归栈，未标 feed 的条目单 feed 组归该 feed、多 feed 组丢弃（防串栈）。
- arXiv 官方 API 源单独放宽 40000 字符（Atom XML 50 条目 ≈42KB，普通 12000 会截到 header）。

### Discover（切片 480s）
- DISCOVER_GROUPS_ALL 6 组随选板派生（labs/opensource/academic 单板 + media-cn/media-en 合组 + linuxdo）；`DISCOVER_BATCH=3`，labs 1800s / 其它 2400s，`tries=1`（8/17 实证 tries=2 在网关差窗口救不回反而烧 80min）。
- **linuxdo 组在代理批循环之外、之前三态消费**（不被断路器/批 break 丢掉）：skip（无 cdpHost，urls:[] 不降级）→ failed（无有效预抓数据，realm 不裸抓）→ OK（预抓 JSON → 窗口预过滤 + likeCount desc 排序 → slice 配额 `LINUXDO_MAX_SOURCES=12`）。
- 闸门顺序（批边界）：budgetGate('Discover') → `roomTo('Fetch') < 480s` 保留窗（8/26：慢 discover 不得拖垮 Fetch 整段跳过）→ `BREAKER.open()`（8/31：计数断路器是事件循环饱和下唯一可靠闸门）。
- **三级兜底**：① harvest-fallback（disc 失败组从 digestByKey 补 entries，合组 board 按 feed.boards∩g.boards 派生——CRITICAL-1）→ ② static-fallback（全组 missing 或 0 URL+自报 degraded → 注入常驻一级页，`url` 不伪造 date）→ ③ 账本硬过滤（近 3 天已报道候选丢弃，storyMatch）。

### Fetch（切片 480s）
- linuxdo 治理（mint 前）：**LINUXDO-GOVERN** 出链帖（snippet 含 GitHub/arXiv/官网外链）→ 把外链 URL 转为真实 fetch 目标（found_via=linuxdo-outlink，提权必先抓——9/19 F7 引用造假根因修复）；空 snippet 帖丢弃计数（匿名抓必 403，进配额即白烧）。
- **LINUXDO-MINT 在 allocateFetchBudget 之前**：cdp snippet 直铸 forum 源（claim=正文首句，quote 可溯源，heat{likes,views,replies} 随行），铸出的 URL 从 boardURLMap 剔除不占 MAX_FETCH（09-20 实证：mint 在配额后会挤掉整板官方源）。
- `allocateFetchBudget` 板间轮询公平（每轮每板至多 1）+ prefer 通道按通道轮询等分（preferCap=⌊16×0.5⌋=8，linuxdo-cdp/linuxdo-outlink/static-fallback 三通道）；`FETCH_BATCH=6` 首批固定（allocate 已混排，不得扩首批）。
- `tries=2`；`bindExtractedClaims`：static-fallback 索引页缺合法文章 sourceUrl 的 claim 丢弃计数（indexClaimDropped），文章页回落 src.url 不计数。

### Verify（切片 300s − 60s inflight buffer）
- 配额按板比例分配（重板 arXiv 不得挤掉财经头条）→ rankedClaims 跨板轮询。
- **2+1 自适应投票**（语义与 3 票时代逐字一致）：round0 并发 2 票；双否→kill、双过→存活；分歧/缺票补 1 票。survives ⇔ valid≥2 且 refuted<2。全 Verify 共享一个阶梯 t0（多票不得各自吃满 LADDER_BUDGET_MS）。
- **外部抽查票**：forum/blog 存活 claim 加 1 张允许 WebSearch 的独立佐证票（2+1 内部票禁外部搜索，「引语整齐但事件不实」的论坛转述恰好能通关）；`externalCheckState` 三态——refuted 翻转回 killed / unavailable 烘焙「未核查」（绝不冒充已核查）/ corroborated。
- 配额内被 salvage/BREAK 截断的 claim 记 unverified 不蒸发（09-21 实证）。

### Synthesize（report 单次 600s × tries）
- 探针 advisory（只观察，不否决合成——8/29 实证单次探针超时曾把 9 条已确认内容整块降 raw）。
- report tries：当日有 claim → 2，全空 → 1；有内容走全阶梯，空板仅首档。
- status 由编排层烘焙进素材行（`_bakedStatus`：[窗口外·重大] / 未核查 / 已核查 N-M）；`_heatLine` 社区热度行（浏览·赞·回复，全 0 不产）。
- **report 幻觉引用确定性过滤**：items.sources 只保留 confirmed 真实 sourceUrl 集合（normURL）命中的，丢弃计数 `report_source_hallucination:N`。
- 失败 → `renderDegradedMarkdown` 降级版 md（必然成功，纯字符串拼接）。

## 6. 关键子系统

### 6.1 墙钟与断路器（三道闸门，8/31 P1）
累加器在事件循环饱和下**只低估**（8/31 实测 Fetch gate 低估 ≥4.7×，4h13m run 零 BUDGET-SKIP）：

1. **budgetGate**（预算.mjs）：累计死线 = 切片和（Verify 另减 60s inflight buffer）；超限记 budget_skipped 一次性；`roomTo()` 纯读不记账（批边界用）。
2. **WALL 标定**（wallclock.mjs）：`withDeadline` 真超时是「真实经过 ≥ ms」的硬证据，与同窗口累加器增量相比得饥饿倍率 → `WALL.observe` 标定（maxFactor 20 封顶 + 单调闸防时间倒流）；探针/短窗超时传 `observe=false` 不污染倍率。**周期标定链（10-03 §12-③ 根因版 `makeWallCalibrator`）**：窗口首尾相接的标定仪器（fire 即续排下一窗，观测无缝隙），每窗 `wallCalibrateMs`（默认 120000，0=显式禁用，非法类型 fail-fast）喂 `WALL.observe`；**nominal 必须 ≫ tick 粒度（250ms）**——首版 nominal=250ms 时 delta 恒为整数拍、factor 只能取 {1,null}，2s 全饱和实证 factor=1（仪器 no-op，review 抓出后抽成可注入假时钟的工厂并行为级测试锁死）。健康跑 factor=1 零影响零日志；饱和跑 fire 晚到、delta 停在解除批次首拍 → factor=win/delta ≫1。meta 记 wallclock{raw_s, calibrated_s, starvation_factor, peak_factor, observations, calibrate_period_ms}，与宿主侧 epoch（run-daily-win.sh WALL_START）三方对账。
3. **BREAKER 计数断路器**：不依赖时钟（饱和下计数依然准确），连续 3 或累计 5 次代理失败跳闸 → Discover 余批跳过直连 static-fallback。Discover 入口 `resetConsecutive()`（Harvest 失败不外溢，已跳闸仍 open）。中间失败不得自吃计数（ladder 工厂不碰断路器）。

### 6.2 模型阶梯（两个层面，勿混淆）
- **realm 内 ladder**（ladder.mjs，作用于 report/verify 代理）：`DEFAULT_LADDER = [deepseek-v4-flash, grok-4.6, claude-opus-4-8, gemini-3.7-flash-high]`，args.modelLadder 可覆盖。仅 TRANSIENT（524/5xx/429/timeout/gateway）换级，null（超时）也换级（safeAgent 的唯一偏离），schema/end_turn 同级消化；LADDER_BUDGET_MS 900s 全程共享（verify 多票共享 t0）；中间失败不计入断路器。**重排决策待数据（10-03 §12-①）**：是否按网关实证把 opus 置首，等 10-04 run 的 `meta.ladder` 字段（report 实际尝试序 / verify 各档计数 / exhausted）确认 realm 内 deepseek 同病后再动——不盲改（verify 票全走首级，重排会把全部核查票抬到 opus 计价）。
- **宿主编排器阶梯**（run-daily-win.sh `ORCH_LADDER`，作用于整个 claude -p launch）：`[claude-opus-4-8, gemini-3.6-flash, deepseek-v4-flash, grok-4.6]`——10/02 网关实证后 opus 置首（deepseek 经 CLI 静默空回、gemini 把 launch 指令当闲聊不跑 skill）。每档先文件读 sentinel 探针（GATEWAY-TOOL-PROBE-SENTINEL，防短问答 200/tools 400 假阳性），快死 <600s 才重拉，≥600s 无产物 = workflow 深处失败不盲目重拉（SLOW_DEATH）。

### 6.3 跨天账本（ledger.mjs）
- 路径 `C:/Users/mango/.ai-daily/published-ledger.json`（HOME 而非 vault——无头上下文读 vault 会被拒，8/31 P4 实证）。
- 条目 `{day, url, tokens(≤64 分桶截断), title(≤80), major}`；记录端 finalize **先落盘后记账**（顺序曾反转导致次日硬过滤压制正当报道，9/19 P2-1 恢复），账本损坏备份 `.corrupt` 再重建，tmp+rename 原子写，60d prune，烟测 outDir 隔离（PROD_DALLYREPORT_PREFIX 判定）。
- 消费端 `storyMatch` 四级硬判定：URL 归一命中 → overlap≥0.8 且共享≥5 token → 连字符≥8 强 ASCII 实体精确命中 → 特异 ASCII（非通用词表）共享≥2 或带数字版本号。
- 生产前缀判定 `isProdOutDir` 吃**前缀列表** `PROD_DALLYREPORT_PREFIXES`（10-03 P0-B：Windows vault 路径置首 + Mac iCloud 兜底 + AI_DAILY_PROD_PREFIX 环境变量；此前 Mac 单前缀在 Windows 恒 false → 生产 LEDGER-SKIP + poster 永不跑）。
- 三个消费点：fetch 配额前硬过滤（lookback 3d）/ 种子退役（报过一次即退役，不看 lookback）/ report prompt 软网 reportedBlock（兜同事件换 URL，账本按 day 过滤不能 slice 头部——头部是最老条目）。
- **buildYesterdayTopics**（10-03 五要素）：昨日+前日条目（lookback 2）+ 今日 confirmed 中 storyMatch 命中 = 「本次新增」；streak 连续天数从**条目自身 day-1** 纯日历逆推（从 t 回看会命中条目自己——实测修正），回看走 day→entries 倒排索引（10-03 §12-⑤，O(回看×全账本)→O(回看×当日桶)）。

### 6.4 linuxdo 链路（CDP 纪律）
只复用 9222 已运行登录态 Chrome，绝不启动/关闭浏览器本体（只 /json/new + /json/close 临时标签）。链路：宿主 prefetch（列表页收齐 → 噪声过滤 → likeCount desc 排序 → 只深抓前 16 条富化正文+探测出链）→ JSON 落盘（本体永不进 claude -p 命令行，标题引号破 shell）→ args 注入 → 窗口预过滤+配额 → GOVERN → MINT → verify 正文行「社区热度」。无预抓数据时 realm 不裸抓（裸 fetch 必 403），如实降级 linuxdo_degraded。

### 6.5 major-out 注入（窗口外·重大）
行业里程碑级公认事件直入正文/头条但不冒充投票（vote '—'，confidence null，verifiedByVote false）。双源：discover 代理 majorOutOfWindow（age gate 14d）+ KNOWN_MAJOR_OUT 种子（age gate 21d，url 全量强制——纯媒体口径不收录）。去重三道：majorKey 指纹（顺序锁定：hassabis 在 jeff-dean 前）→ storyMatch 对本轮 confirmedVerify/majorOutClaims/账本互斥（MAJOR-DUP）→ 种子 splitSeeds 退役。

### 6.6 确定性渲染（render-md.mjs）
md 由 workflow 内纯字符串拼接产出，**必然成功**，report 成功即完整版、失败即降级版。节清单（存在才渲染=信息熵契约，不摆空骨架）：🔥 今日亮点（highlights）→ 一句话 → 执行摘要 → 🔁 昨日话题追踪（yesterdayTopics）→ 各板块 sections → 📎 窗口外参考 → 开放问题 → 📊 数据概览（漏斗表）→ 🧭 今日技术趋势（trend）→ 覆盖自检。buildCitationMap + buildCitationMap 幻觉防线（编号只挂真实 sourceUrl）。10-03 五要素（亮点/追踪/热度/漏斗/趋势）全部确定性渲染，report 代理不写这些节。

### 6.7 schema 契约（schemas.mjs）
REPORT_SCHEMA required = [oneLiner, execSummary, sections, caveats, openQuestions]；10-03 新增可选 `highlights`（≤4 条 {title,why}）与 `trend`——required 不变，旧产物/降级路径不填照常过 schema。item.status 枚举字面量（render 依赖精确值判定）。VERDICT_SCHEMA 含可选 `toolsUnavailable`（外部票三态判定的唯一可信信号）。

## 7. 降级旗标全表（排障核心，如实进 meta.degraded 与用户汇报）

| 旗标 | 触发 |
|---|---|
| `discovery_degraded:missing_<boards>` / `discovery_degraded` | 归属组全部无返回 / 有组自报 degraded |
| `discovery_recovered:<boards>` | disc 失败但 harvest entries 已补（通道 degraded、内容已补，不再标 missing） |
| `fetch_budget_dropped:N` | fetch 预算硬上限丢弃（meta.dropped_detail 分桶：linuxdo_cdp/static_fallback/other） |
| `verify_agent_errors:N` | 核查票代理错误 ≥1 |
| `budget_skipped:<stages>` | 阶段墙钟累计死线跳过 |
| `breaker_open:<reason>` | 计数断路器跳闸（consecutive_failures/total_failures@label） |
| `wallclock_starved:<f>x` | 饥饿倍率观测 >1.5 |
| `linuxdo_degraded:<reason>` | linuxdo 通道失败（no_cdp_host 跳过不算降级） |
| `ladder_used:<label:model…>` / `ladder_exhausted:<stage>` | report/verify 非首级救回 / 阶梯全废 |
| `index_claim_dropped:N` | 索引页 claim 缺合法文章 sourceUrl 被丢弃 |
| `external_check_unavailable:N` | forum/blog 外部抽查未完成（status 已烘焙「未核查」） |
| `report_source_hallucination:N` | report 编造的 URL 被确定性过滤 |
| `ledger_unavailable` | 无账本注入，本轮跨天去重关闭（fail-open 不阻断成稿） |
| `report_failed` | report 阶梯全废 → 降级 raw archive（仍出 md） |

meta.json 另有 `ledger_recorded`（recorded/skipped/failed，finalize 回写）与 `wallclock` 三方对账块。**所有降级必须如实转达用户，不得静默。**

## 8. 产物契约

`AI/DallyReport/<date>/` 下 4+1 个文件，全部 tmp+rename 原子写：
`<date>-ai日报.md`、`<date>.verified-claims.json`（confirmed/refuted/unverified/outOfWindow）、`<date>.sources.json`、`<date>.meta.json`、`AI.png`（海报，isProd 才生成）。md 由编排器从 payloads.md 落盘。缺任一 payload 字段 finalize 报错非 0 退出。

## 9. 落盘与自检链（宿主 CLI）

| 脚本 | 职责 |
|---|---|
| `finalize.mjs` | 4 产物逐字节落盘 + 账本记账 + 海报；先落盘后记账 |
| `host-finalize.mjs` | 编排器死在 Write 前时，从 `~/.claude/projects/<cwd-slug>/<uuid>/workflows/wf_*.json` 找回 completed payloads 落盘（report 已在盘则 SKIP）。会话目录由 cwd 推导（`host-paths.mjs`），不再硬编码 Mac 会话名；`run-daily-win.sh`/`run-daily.sh` 都在 artifact-check **之前**调用 |
| `host-paths.mjs` | 宿主路径单一真源：`os.homedir()` + cwd slug → Claude 会话目录；`~/.ai-daily` 运行时目录。三个宿主 CLI 共用，杜绝 `process.env.HOME || ''`（无头 shell 下为空）与硬编码会话名 |
| `artifact-check.mjs` | 宿主产物自检摘要（md_bytes/confirmed/degraded/killed）；Windows 显式传 --dir（默认是 Mac iCloud 路径，HOME 取 `os.homedir()`） |
| `progress.mjs` | headless 终端单行进度（不画假百分比：墙钟 vs 30min / 五阶段推进 / 真实票数）；日志/会话路径走 `host-paths` |
| `cdp-fetch.mjs` | fetch 子代理经 Bash 调用的通用文章页 CDP 抓取（webFetchViaCdp:true 时，失败回落 WebFetch） |
| `linuxdo-fetch.mjs` | 宿主专用 linux.do CDP 抓取（`fetchLinuxDoNews34`，10/03 自 linuxdo.mjs 拆出）；复用 `cdp-core.mjs` 传输层，不 inline 进产物 |

## 10. 测试体系

- **必须 `cd scripts/ai-daily` 跑** `node --test test/*.test.mjs`（repo 根跑 glob 不中 → 0 tests 假绿）。
- 当前 453 项：444 pass / 0 fail / 9 有意 skip（2026-10-03 第四轮根因修复：Windows runner 契约测试 7 项新增（此前 7 条 shim 断言在 Windows 全 SKIP）、host-paths 6 项、标定链 rejection 兜底 2 项、build 护栏「宿主 API 整类拦截」1 项；10-04 烟测再补预抓失败日志 rc 捕获回归 1 项）。
- 测试原则：**纯函数直调**（测试直调 buildFallback/externalCheckState 等真实实现，不 grep 模板源码——消除 forward-test 缺陷）；realm 隔离（wallclock/budget 时钟注入 mock）；fail-open 契约固化（坏输入→null/[]，不抛穿）；skill-doc-contract 锁 SKILL.md 关键字面量（改 SKILL.md 前先看该测试）。
- 改动门禁：模块/模板改动 → 全量测试 + `node scripts/ai-daily/build.mjs --check-only` + 产物 cp 同步 vault + 两仓提交。

## 11. 历史设计文档索引

| 文档 | 状态 |
|---|---|
| `2026-08-13-ai-daily-report-design.md` | 历史快照——初版设计（Mac launchd + seed 扫描架构，seed_URLs.json 已不存在）；需求/目标/覆盖模型仍有溯源价值 |
| `2026-08-18-ai-daily-refactor-design.md` | 历史快照——模块化重构（模块真源 + build inline + md 去代理化），机制仍是当前架构核心，changelog 已止于 8/18 |
| `2026-08-20-ai-daily-age-gate-design.md` | 历史快照——种子 age gate 设计，机制仍有效 |
| `2026-08-20-ai-daily-room-timeout-fix-design.md` | 历史快照——room-as-timeoutMs 错配修复史；语义已演进为「固定上界 + 批间 BREAK」（8/20 第十六项） |
| `superpowers/specs/2026-08-22/23-*.md` | 历史快照——sources-uncertainty / linuxdo-cluster-adaptive 设计快照 |

8/22 之后至 10-03 的迭代（windows 迁移、账本、prefetch 隔离、wallclock 标定、断路器、阶梯、mint/govern、索引页治理、五要素对齐）**无独立设计文档**，决策依据记录在各模块头注释与 vault 运维文档变更记录——本文档 §5-§7 即当前状态的权威描述。

## 12. 设计债务（2026-10-03 review → 同日第二轮清偿）

首轮 review 记录 6 项；同日第二轮开发清偿 5 项 + 新发现 4 项 P0 Windows 迁移缺陷（均已修，见 §13）：

1. ~~**realm 内阶梯首档与网关现状不匹配**~~ → **观测先行（已实现，重排待数据）**：meta 新增 `ladder{report:{used,tried}, verify:{tried_total,by_model}, exhausted}` 结构化账目；DEFAULT_LADDER 顺序暂不动（verify 票全走首级，盲排 opus 置首会把全部核查票抬到 opus 计价），等 10-04 run 的 meta.ladder 实证 realm 内 deepseek 是否同病后再决策。
2. ~~**`preferStaticFirst` 死导出**~~ → **已删除**（dedup.mjs 导出与 prefer-static.test.mjs 一并移除；allocateFetchBudget prefer 通道语义由 dedup.test.mjs P2 系列全覆盖）。
3. ~~**墙钟标定观测盲区**~~ → **已根因重建（review 后二次修复）**：review 实证 250ms 首版是 no-op 仪器（nominal==tick 粒度 → factor∈{1,null}，2s 全饱和 factor=1）且 0=禁用被默认分支吞掉。根因修复 = 仪器抽为 `wallclock.mjs makeWallCalibrator` 纯工厂（窗口首尾相接 + nominal≫tick 约束写进契约 + setTimer/readAccum/observe 全注入），默认窗 120s=480 拍；6 项行为级测试锁死健康/饱和/cap/幂等/禁用/fail-fast。
4. ~~**Windows 通知未实现**~~ → **已接 PowerShell WinRT toast**（run-daily-win.sh notify()；失败回落 log-only，真机验证通过；review 后补 `ps_escape` 单引号转义 + 撇号文案端到端验证）。
5. ~~**streakOf 复杂度**~~ → **已改倒排索引**（day→entries 预分组一次建表，每步只 match 当天桶；行为逐字节不变，29 项 ledger 测试全绿）。
6. ~~**双仓手工 cp 漂移**~~ → **build.mjs 已加 `--sync-vault`**（产物 + SKILL.md 一步同步，逐字节相同跳过；review 后补：失败路径 VAULT-SYNC-WARN 且 exit 0 有测试；去掉 `export` 防「import 即 main() 写盘」雷区）。

**review 第三轮补修（同日）**：② build.mjs 去 export + 失败路径测试；③ run-daily-win.sh `mkdir -p` 挪到 PATH 导出后（PATH 导出点之前不得有外部命令的纪律收口）+ notify() 参数 PS 转义；⑤ finalize `AI_DAILY_PROD_PREFIX` 改惰性读取（isProdOutDir 每次调用组装，不再模块加载期突变导出数组）+ 子进程 env 测试。
**遗留观察（不阻塞生产）**：① DEFAULT_LADDER 重排决策（等 10-04 meta.ladder 数据）；② artifact-check.mjs 默认 --dir 仍是 Mac iCloud 路径（Windows 生产显式传 --dir，无实际影响）；③ generate-poster 跨仓双镜像布局（有探测兜底，风险低）。

## 13. 变更记录

- **2026-10-03（第四轮 · 深度 review 根因修复）**：对第三轮做深度 review，八项全部根因修复：
  - **[P1-① 恢复路径从未接线]** `run-daily-win.sh`/`run-daily.sh` 此前只在 artifact-check——09-21 建的 `host-finalize.mjs`（编排器 422 死在 Write 前时从 completed `wf_*.json` 找回 payloads 落盘）从未被 Windows runner 调用（10-02 移植时从 Mac git 外 shim 丢掉该步）。现两 runner 都在 artifact-check **之前**跑 `host-finalize.mjs --date --out --since-epoch $WALL_START`；且 `host-finalize` 的 `DEFAULT_PROJECTS` 旧版硬编码 Mac 会话名 → 改由 cwd 推导。
  - **[P2-② HOME 判据]** `host-finalize`/`artifact-check`/`progress` 各写 `process.env.HOME || ''`（非登录 shell 下为空 → 路径退化）。新增 `host-paths.mjs` 单一真源（`os.homedir()` + projectSlug + env 覆盖）。
  - **[P2-③ realm 死代码]** 旧版把 linuxdo 抓取连同 `cdp-core`（fetch/WebSocket）inline 进产物、realm 永不执行还让护栏盯不住。拆 `linuxdo-fetch.mjs`（宿主），`linuxdo.mjs` 只留纯解析；`cdp-core` 移出 MODULES；build 护栏从单条扩为宿主 Node API 整类拦截（`process.*`/`require(`/裸 `fetch(`/`WebSocket`/`AbortSignal`）。
  - **[P2-④ 契约测试盲区]** 旧 shim 测试在 Windows 全 SKIP（7 断言），HOST-FINALIZE 回归不可见。新增 `run-daily-win.test.mjs` 锁仓内 runner（6 测，跨平台跑）。
  - **[P3-⑤ 标定链 rejection]** `makeWallCalibrator` `once().then(chain)` 对 rejection 零兜底 → 窗内 try/catch + 链尾 `.catch` 日志停链。
  - **[P3-⑥ 海报默认路径]** `generate-poster` CLI 默认 outDir 硬编码 Mac iCloud → `AI_DAILY_REPORT_DIR` 覆盖 → win32 vault 生产根 → 其余 Mac 兜底。
  - **[P3-⑦ 空 STAMP]** runner 早退日志 STAMP 空 → `${STAMP:-unknown-time}` 兜底。
  - 全量 **452 项 443 pass / 0 fail / 9 有意 skip**；产物 3212 行 `--sync-vault` 已同步。
- **2026-10-04（质量审计 + 声明质量门设计文档）**：对当日日报做全链路质量审计（四件套 + 双 workflow payload + 生产账本），抓到**管线真实 bug**：论坛附件标注被提取为可证伪声明（`image 580×286 7.97 KB`）→ 通过 2-0 核查投票 → 写入生产账本；连带后果——`Antigravity 发布 Opus 5.5/Sonnet 5.5`（两帖印证的当日最大模型新闻）与微软 Rust 一级语言因 claim 被提取成附件垃圾/评论碎片而被挤出正文。反幻觉护栏实战通过（`report_source_hallucination:5` 全拦）。产出 **`docs/2026-10-04-claim-quality-gate-design.md`**（六项改造：claim-gate 纯模块确定性垃圾模式 / 模板 allClaims 单点接线（fetch+mint 双路覆盖）/ verify substance 门（过滤必须先于配额分配）/ 全错票补投轮 / fetch prompt 提取卫生硬化 / sourcesJson claimUrls 精度；含 10-04 真实垃圾原文回归 fixtures 与实施清单）。**已实施（同日）**：claim-gate.mjs + 6 组测试、模板 8 处接线（allClaims 门 / substance 门先于配额 / VERIFY-RETRY 全错票补投 / substance 声明落 unverified 不蒸发 / sourcesJson claimUrls / meta `claim_gate`+`verify_retry` / stats 两字段）、fetchPrompt 声明卫生规则；新增 prompts 卫生断言与 workflow-integration 接线顺序锁（「过滤先于配额」「补投先于外部抽查」两条硬顺序）。全量 **476 项 467 pass / 0 fail / 9 有意 skip**；产物 **3303 行** `--sync-vault` 已同步。下次 08:40 生效，验收口径：log 出现 `CLAIM-GATE dropped=N`、meta 三新字段、confirmed 无附件标注形态。
- **2026-10-04（第五轮 · review 全量根因修复 + 部署确认）**：对本轮 F1–F6 修复变更再做一次生产 review（4×P3 + 1×Suggestion，无阻塞项），全部根因修复：
  - **[F1 终态收口（两 runner）]** 成功/失败/探针耗尽三态 `done rc=` 统一收口在 artifact-check 之后、WALLCLOCK 之前（旧版只有 ATTEMPT=0 分支写 done，成功路径 RC 被强制 0 后 `if [ "$RC" != "0" ]` 跳过 → 进度台终态永不可达恒「运行中」）；rc=0 以 `[ -f "$REPORT" ]` 为主判据（host-finalize 抢救成功也算成功）；幂等 skip 路径补 `done rc=0 (skip-existing)`（skip 日不再显示陈旧终态）。`run-daily-win.test.mjs` 用发射专属 needle（`$STAMP done rc=0 =====` / `printf 'WALLCLOCK`）锁三态位置契约，防注释抢先匹配。
  - **[F3 finalize.mjs CLI 门控]** 旧版 CLI 无条件摊模块顶层——import 时宿主 argv 里的非 `--` 参数被当 result 路径 → import 即写盘（实证）；`--out <dir> <result>` 顺序把 dir 当 result → ENOENT。根因修复：`isCliMain` 门控 + 旗标带值解析（位置参数与旗标值互不污染，顺序无感）+ 无参 usage exit 1。回归：import-only wrapper 零写盘、旗标前置顺序、无参 usage、`--out` 末参无值回落。
  - **[F2→F-1 生产根单一真源]** F2 修复时 artifact-check 新写的三级默认根解析与 `generate-poster.defaultReportRoot` / `finalize.PROD_DALLYREPORT_PREFIXES` 三处同构字面量 → 收敛 `host-paths.prodDallyReportRoot()`（`AI_DAILY_REPORT_DIR` env → win32 生产根 → Darwin iCloud），artifact-check 改调用点惰性求值，generate-poster 删本地副本（os import 清理），finalize 前缀引用同一常量（`[0]` 仍为 win 字面量，ledger.test 钉住）。单测锁「artifact-check 不得再持生产根字面量」。
  - **[新发现 P1 · 宿主 CLI「今天」用 UTC]** 部署 smoke 实证 `progress --once` 03:00 显示 `ai-daily 2026-10-03`——`new Date().toISOString()` 是 UTC 日期，本地 00:00–08:00（CST）「今天」= 昨天 → 标签错天、artifact-check/generate-poster 无参默认查错日。`host-paths.localDateStr()`（本地时区 YYYY-MM-DD）三处替换 + 已知 UTC 时刻回归（CST 02:00 → 当天）。
  - **[F4/F6 progress]** `phaseCounts` 导出 + `inflight` clamp≥0（重复 result 事件如重试续写会让 done 超转录计数 → 负在飞）+ fakeIo 单测（转录归类/probed/负 clamp/缺目录静默）；真实 runner 成功日志 fixture（Windows 无时区 + Mac CST）锁 F1 发射格式——DONE0/DONE1 自此有真实生产发射方。
  - **格式卫生**：win runner 终态信息块缩进恢复 2 空格、finalize.mjs 末尾补换行。
  - **部署验证（全绿）**：全量 **468 项 459 pass / 0 fail / 9 有意 skip**；产物零漂移（fresh build == 仓内 `.claude/workflows/ai-daily.js` == vault 产物逐字节相同，SKILL.md 同——本次全部变更均为宿主 CLI/runner，不在 build MODULES，产物无需重建）；smoke：`artifact-check` 无 `--dir` 命中 win32 生产根 `ARTIFACT-OK`（真实 10-02 产物）、`progress --once` 正确显示 2026-10-04、`host-finalize` SKIP report_exists。**10-05 08:40 起为首个发射 `done rc=` 终态行的生产 run**；10-02/10-03 缺口日维持不补齐（未授权）。
- **2026-10-04（第四轮后续 · 深度 review 根因修复）**：对第四轮+烟测后的代码再走一遍深度 review（宿主 CLI 侧），抓到 `progress.mjs` 两处「只有 CST 才能工作」的解析缺陷并根因修复：
  - **[P1] progress.mjs START_RE/DONE_RE 写死 `CST` 字面量 → 进度台在 Windows 恒「未启动」**：Mac launchd 宿主 `date '+%Z'` 出 `CST`，但 Windows Git Bash **出空串** → `run-daily-win.sh` 实际写出 `===== 2026-10-04 02:55:53  start run-daily-win（CEILING_MS=0）=====`（时间戳后**两个连续空格**、无时区标记），旧正则 `(\S+ \S+) CST start` 永不匹配 → 整个 Windows 平台的进度台恒显「run-daily.log 无本次 start 标记」，墙钟/五阶段/522 计数全哑。时区标记改可选 `(?: \S+)?`，空格分隔改 ` +`（一个或多个——无时区时的双空格是实测形态）。
  - **[P1] DONE_RE 不认 `(probe-exhausted)` 后缀 → 终态在两平台都测不到**：两 runner 的探针耗尽分支都写 `===== … done rc=2 (probe-exhausted) =====`，旧 `rc=(\d+) =====` 因括号后缀失配 → 终态永不判定，rc=2 的 run 永远显示「运行中」。后缀改可选 `(?: \([^)]*\))?`，rc 仍取第一个捕获组。
  - 实证：对真实生产日志（`~/.ai-daily/run-daily.log`，含 10-02 带戳 start + 10-03 空戳行）跑 `progress.mjs --once`，修复前恒「未启动」，修复后如实报出「2026-10-03 | ⚠1951m28s/30m | 编排器阶段」——正确暴露 10-02 run 有 start 无 done 的遗弃态。
  - `progress.test.mjs` 补两条回归（Windows 双空格/无时区 start 可识别 + `done rc=2 (probe-exhausted)` 判终态），并锁 CST 旧格式不回归。progress.mjs 是宿主 CLI（不在 build MODULES），产物不需重建。全量 **455 项 446 pass / 0 fail / 9 有意 skip**。
- **2026-10-04（第四轮后续 · 烟测实证修复）**：对第四轮变更做受限烟测（临时 projects 目录伪造 completed workflow json + 临时 outDir + 临时 AI_DAILY_HOME；只复用 9222 登录态 Chrome 开/读/关临时标签）。**恢复链全绿**：host-finalize 找回 payloads → 落盘 4 产物（LEDGER-SKIP，非生产 outDir 不记账）→ 二次调用 `HOST-FINALIZE-SKIP report_exists` → 无匹配日期 `no_matching_workflow` rc=1 → artifact-check `ARTIFACT-OK` → linuxdo-prefetch 走 9222 `ok:true posts=8` → build --check-only OK。烟测抓到一个真 bug 并根因修复：
  - **[P2] run-daily-win.sh / run-daily.sh 预抓失败日志吞退出码**：`echo "LINUXDO-PREFETCH-FAIL exit=$?"` 写在 `printf > "$PREFETCH_JSON"` **之后**，`$?` 取到的是 printf 的退出码（恒 0），node 预抓的真实 rc 被吞 → 日志永远 `exit=0`，CDP 失败/崩溃/524 不可审计。先在 else 分支入口（`$?` 仍是条件命令 node 的 rc）捕获 `PREFETCH_RC=$?` 再写 JSON，日志引用真实码。两 runner 同修；`run-daily-win.test.mjs` 补回归锁（断言不含 `exit=$?`、含 `PREFETCH_RC=$?` 与 `exit=$PREFETCH_RC`）。全量 **453 项 444 pass / 0 fail / 9 有意 skip**。
- **2026-10-03（第三轮 · code review 根因修复）**：对第二轮变更做 final review（P2×1 / P3×2 / Suggestion×2），全部根因修复：
  - **[P2] 周期标定仪器重建**：review 用 tick 链模拟实证 250ms 首版是 no-op（nominal==tick 粒度 → delta 恒整数拍 → factor∈{1,null}，2s 全饱和 factor=1；nominal 1000ms 对照组 factor=4）。根因修复 = 仪器抽为 `wallclock.mjs makeWallCalibrator` 纯工厂：窗口首尾相接（fire 即续排，观测无缝隙）、nominal≫tick 契约写进注释、setTimer/readAccum/observe 全部可注入；默认窗 120s=480 拍（健康 factor=1 零日志，饱和 fire 晚到 factor=480→cap 20）。行为级测试 6 项（假时钟）当场再抓出一个真 bug：**0=显式禁用被默认分支吞掉**（args.wallCalibrateMs=0 关不掉仪器）——改为 0 合法禁用、非法类型 fail-fast。workflow-integration 断言同步更新。
  - **[P3] build.mjs**：去掉 `export syncVault`（脚本即入口形态不得 export——import 即触发底部 main() 写盘真实产物，build.test.mjs 头注释记载的事故形态）；补同步失败路径测试（vault 目标不可写 → VAULT-SYNC-WARN 且 exit 0、产物不受影响）。
  - **[P3] run-daily-win.sh**：`mkdir -p "$LOGDIR"` 挪到 PATH 导出后（纪律收口：PATH 导出点之前不得有外部命令——mkdir 也是 /usr/bin 外部命令，留在前面则 LOGDIR 缺失场景全 run 静默失日志）；notify() 加 `ps_escape`（单引号翻倍转义），含撇号文案端到端 toast 验证通过。
  - **[Suggestion] finalize.mjs**：`AI_DAILY_PROD_PREFIX` 改惰性读取（isProdOutDir 每次调用组装前缀，不再模块加载期突变导出数组）；补子进程 env 覆盖测试（命中/不命中/导出数组不被突变三断言）。
  - 测试 436 项 428 pass / 0 fail / 8 skip；产物 3354 行；`--sync-vault` 已同步（SKILL.md identical 自动跳过）。下次生效 10-04 08:40。
- **2026-10-03（第二轮 · 按 §12 清偿 + 生产 P0 修复）**：
  - **P0-A run-daily-win.sh 整轮空转修复**（10-03 08:40 生产实证）：任务计划程序调起的 bash.exe 非登录 shell，PATH 无 Git `/usr/bin` → `date/seq/tr/wc` 全部 command not found，四档探针被 `seq` 失败全灭、**零 launch** 即 rc=2 放弃，10-03 日报缺口。修：PATH 前插 `/e/code/Git/usr/bin`、STAMP 挪到 PATH 导出后、TODAY 空值守卫早退。最小 PATH 模拟验证通过。**10-03 无日报（09-25 以来第二个缺口日），如需补偿须用户授权单日跑（Iron Rule：已有产物日期禁 --date 全量重跑）。**
  - **P0-B finalize.mjs 生产前缀 Windows 化**：`PROD_DALLYREPORT_PREFIX`（Mac iCloud 单前缀）→ `PROD_DALLYREPORT_PREFIXES` 列表（Windows vault 置首 + Mac 兜底 + AI_DAILY_PROD_PREFIX 覆盖）。旧版在 Windows 上 isProdOutDir 恒 false → 生产 LEDGER-SKIP（跨天去重失效）+ poster 永不跑。**注意：10-02 产物若出自 Windows 路径，其账本未记账；10-04 起恢复正常。**
  - **P0-C SKILL.md Windows 路径对齐**：frontmatter/触发器/日期命令（GNU date）/outDir/scriptPath/build 检查/finalize 命令/产出物命名/headless 契约（linuxdoMaxSources 12）全部改 Windows 实路径，残留 Mac 叙述字样清零；新增 cdpFetchCli/grokDir 可选 args 说明。
  - **P0-D 模板 Mac 硬编码路径清除**：`CDP_FETCH_CLI` 与 `GROK_DIR` 旧硬编码 `/Users/mango/...` → args 可覆盖 + Windows 生产默认（旧版在 Windows 生产下 9222 fetch 通道静默哑火、grok-search skill 指向不存在文件）。加 `assert.doesNotMatch(/['"]\/Users\/mango\//)` 源级防回归。
  - **§12 六项清偿**：① meta.ladder 阶梯观测账（重排待 10-04 数据）② 删 preferStaticFirst ③ 周期墙钟标定（wallCalibrateMs 默认 600s）④ PowerShell toast 通知 ⑤ streakOf 倒排索引 ⑥ build.mjs --sync-vault。
  - 测试 429 项 421 pass / 0 fail / 8 skip；产物 3309 行；`--sync-vault` 已同步 vault 产物 + SKILL.md。下次生效 10-04 08:40。
- **2026-10-03（第一轮）**: 建立本文档为唯一总纲；吸收 4 篇 dated 设计文档与 README 旧架构描述（均已加历史快照标注）；依据 15 个模块真源 + 模板 1273 行逐一核对契约（含 10-03 五要素：亮点/昨日话题追踪/社区热度/数据概览/趋势收尾）；记录设计债务 6 项（§12）。同日完成 10-03 五要素对齐（主仓 `7e14ea3`）、433 项测试全绿（425/0/8）、产物 3269 行。
