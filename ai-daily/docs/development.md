# ai-daily 开发文档（唯一总纲）

- **日期**: 2026-10-03
- **状态**: canonical — 开发/架构唯一总纲；运维/排障见 vault `Note/infra/ai-daily Workflow 运维.md`
- **取代**: `docs/` 下 4 篇 dated 设计文档（见 §13 历史索引）+ README 旧架构描述

## 速读（当前有效 · 维护于 2026-10-03）

- 生产 Windows 唯一：任务计划程序 `ai-daily`（每日 08:40）→ `run-daily-task.cmd` → `run-daily-win.sh` → `claude -p`（skill 编排）→ Workflow 产物 → `finalize.mjs` 落盘 vault `AI/DallyReport/<date>/`。Mac launchd 与 `~/.ai-daily` 已于 10-03 清流。
- 逻辑真源 = `scripts/ai-daily/*.mjs`（15 个模块）+ `ai-daily.template.js`（编排骨架）；`build.mjs` inline 生成 3269 行自包含产物 `.claude/workflows/ai-daily.js`（repo 内），再手工 cp 同步到 vault `.claude/`。
- 全链路预算：MAX_FETCH/MAX_VERIFY 16，五阶段墙钟切片 540/480/480/300s（总 1800s），report 单次 600s；对抗核查 2+1 票；跨天账本硬去重 + 昨日话题追踪 + 社区热度（10-03 五要素已上线）。
- 测试：`cd scripts/ai-daily && node --test test/*.test.mjs`（**必须 cd 进目录**，repo 根跑 glob 不中）；当前 433 项 425 pass / 0 fail / 8 有意 skip。
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
├── ai-daily.template.js @ scripts/ai-daily/     # 编排骨架（1273 行）：realm 适配 + 五阶段编排
├── scripts/ai-daily/*.mjs                       # 15 个逻辑模块真源 + 6 个宿主 CLI
│   ├── 纯逻辑模块（build inline 进产物）：url-polyfill date-utils schemas boards dedup budget
│   │   wallclock ladder fallback prompts render-md cluster ledger cdp-core linuxdo
│   ├── 宿主 CLI（绝不 inline）：linuxdo-prefetch cdp-fetch artifact-check host-finalize
│   │   progress generate-poster finalize cli-main
│   └── test/*.test.mjs                          # 32 个测试文件，node --test 直调模块真源
├── .claude/workflows/ai-daily.js                # build 产物（repo 内，3269 行，勿手改）
├── .claude/skills/ai-daily/SKILL.md             # skill 编排器（vault 侧另有同步副本）
├── run-daily-win.sh / run-daily.sh              # Windows 生产 / Mac（已清流，保留语义参考）
├── run-daily-task.cmd / register-task.ps1       # 任务计划程序包装与注册
├── docs/development.md                          # 本文档（唯一总纲）
└── docs/2026-08-*.md                            # dated 历史设计快照（见 §13）
```

**双仓镜像纪律**：`DallyReport/ai-daily/scripts/ai-daily/` 是版本管理真源（本仓）；vault `.claude/` 是运行时副本。**改模块逻辑 → 改 `.mjs` 真源；改编排 → 改 `ai-daily.template.js`；改完必须 `node scripts/ai-daily/build.mjs`**，再 cp 产物 + SKILL.md 到 vault。`generate-poster.mjs` 有跨仓依赖（向上找 DallyReport 仓根 image-gen），两仓各一份镜像，层数不同。

## 3. 构建系统（build.mjs）

```
node scripts/ai-daily/build.mjs [--out <path>] [--check-only]
# 默认写 ../../.claude/workflows/ai-daily.js（repo 内）
# vault 同步：cp .claude/workflows/ai-daily.js  <vault>/.claude/workflows/
#            cp .claude/skills/ai-daily/SKILL.md <vault>/.claude/skills/ai-daily/
```

四道护栏，任一失败不出产物：

1. **inline 顺序即依赖序**（MODULES 数组）：url-polyfill 最先（realm 无 URL 全局，缺失 → new URL() 抛错被 catch 吞 → 完整版 0 角标）；date-utils 在 boards/dedup 前（GROUPS_RAW 闭包引用 normURL）；cluster 在 ledger 前（指纹复用 clusterTokenize）；cdp-core 在 linuxdo 前。
2. **realm guards**：REQUIRED_MARKERS（linuxdoPrefetched / reportedLedger / webFetchViaCdp 消费入口必须在场）+ FORBIDDEN_INLINE（宿主 CLI 不得 inline、process.exit/require 禁入 realm、禁裸调 fetchLinuxDoNews34）——防止「模板已改、产物仍走旧裸抓」的静默漂移。
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

模板常量（args 可覆盖）：`MAX_FETCH=16`、`MAX_VERIFY=16`、`MAX_URLS_PER_BOARD=6`、`AGENT_TIMEOUT_MS=360s`、`SYNTHESIS_LIMIT_MS=600s`、`LADDER_BUDGET_MS=900s`、`TOTAL_LIMIT_MS=1800s`。

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
2. **WALL 标定**（wallclock.mjs）：`withDeadline` 真超时是「真实经过 ≥ ms」的硬证据，与同窗口累加器增量相比得饥饿倍率 → `WALL.observe` 标定（maxFactor 20 封顶 + 单调闸防时间倒流）；探针/短窗超时传 `observe=false` 不污染倍率。meta 记 wallclock{raw_s, calibrated_s, starvation_factor, peak_factor}，与宿主侧 epoch（run-daily-win.sh WALL_START）三方对账。
3. **BREAKER 计数断路器**：不依赖时钟（饱和下计数依然准确），连续 3 或累计 5 次代理失败跳闸 → Discover 余批跳过直连 static-fallback。Discover 入口 `resetConsecutive()`（Harvest 失败不外溢，已跳闸仍 open）。中间失败不得自吃计数（ladder 工厂不碰断路器）。

### 6.2 模型阶梯（两个层面，勿混淆）
- **realm 内 ladder**（ladder.mjs，作用于 report/verify 代理）：`DEFAULT_LADDER = [deepseek-v4-flash, grok-4.6, claude-opus-4-8, gemini-3.7-flash-high]`，args.modelLadder 可覆盖。仅 TRANSIENT（524/5xx/429/timeout/gateway）换级，null（超时）也换级（safeAgent 的唯一偏离），schema/end_turn 同级消化；LADDER_BUDGET_MS 900s 全程共享（verify 多票共享 t0）；中间失败不计入断路器。
- **宿主编排器阶梯**（run-daily-win.sh `ORCH_LADDER`，作用于整个 claude -p launch）：`[claude-opus-4-8, gemini-3.6-flash, deepseek-v4-flash, grok-4.6]`——10/02 网关实证后 opus 置首（deepseek 经 CLI 静默空回、gemini 把 launch 指令当闲聊不跑 skill）。每档先文件读 sentinel 探针（GATEWAY-TOOL-PROBE-SENTINEL，防短问答 200/tools 400 假阳性），快死 <600s 才重拉，≥600s 无产物 = workflow 深处失败不盲目重拉（SLOW_DEATH）。

### 6.3 跨天账本（ledger.mjs）
- 路径 `C:/Users/mango/.ai-daily/published-ledger.json`（HOME 而非 vault——无头上下文读 vault 会被拒，8/31 P4 实证）。
- 条目 `{day, url, tokens(≤64 分桶截断), title(≤80), major}`；记录端 finalize **先落盘后记账**（顺序曾反转导致次日硬过滤压制正当报道，9/19 P2-1 恢复），账本损坏备份 `.corrupt` 再重建，tmp+rename 原子写，60d prune，烟测 outDir 隔离（PROD_DALLYREPORT_PREFIX 判定）。
- 消费端 `storyMatch` 四级硬判定：URL 归一命中 → overlap≥0.8 且共享≥5 token → 连字符≥8 强 ASCII 实体精确命中 → 特异 ASCII（非通用词表）共享≥2 或带数字版本号。
- 三个消费点：fetch 配额前硬过滤（lookback 3d）/ 种子退役（报过一次即退役，不看 lookback）/ report prompt 软网 reportedBlock（兜同事件换 URL，账本按 day 过滤不能 slice 头部——头部是最老条目）。
- **buildYesterdayTopics**（10-03 五要素）：昨日+前日条目（lookback 2）+ 今日 confirmed 中 storyMatch 命中 = 「本次新增」；streak 连续天数从**条目自身 day-1** 纯日历逆推（从 t 回看会命中条目自己——实测修正）。

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
| `host-finalize.mjs` | 编排器死在 Write 前时，从 `~/.claude/projects/<session>/workflows/wf_*.json` 找回 completed payloads 落盘（report 已在盘则 SKIP） |
| `artifact-check.mjs` | 宿主产物自检摘要（md_bytes/confirmed/degraded/killed）；Windows 显式传 --dir（默认是 Mac iCloud 路径） |
| `progress.mjs` | headless 终端单行进度（不画假百分比：墙钟 vs 30min / 五阶段推进 / 真实票数） |
| `cdp-fetch.mjs` | fetch 子代理经 Bash 调用的通用文章页 CDP 抓取（webFetchViaCdp:true 时，失败回落 WebFetch） |

## 10. 测试体系

- **必须 `cd scripts/ai-daily` 跑** `node --test test/*.test.mjs`（repo 根跑 glob 不中 → 0 tests 假绿）。
- 当前 433 项：425 pass / 0 fail / 8 有意 skip（2026-10-03）。
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

## 12. 设计债务与后续优化（2026-10-03 review）

按优先级，均为观察记录、未擅自改动生产行为：

1. **realm 内阶梯首档与网关现状不匹配**：`DEFAULT_LADDER` 仍 deepseek-v4-flash 置首，而 10/02 实证 deepseek 经 claude CLI 静默空回（编排器阶梯已 opus 置首）。ladder 作用于 realm 内 report/verify 代理（不經 CLI 层），行为未必同病，但值得下次运行 meta.ladder_used 数据确认后重排。
2. **`preferStaticFirst` 死导出**：9/01 P0 后模板不再消费（allocateFetchBudget Phase 1 已按通道轮询），仅 prefer-static.test.mjs 引用。可删或保留作回归样例。
3. **墙钟标定的观测盲区**：健康跑零真实超时 → 零观测 → 累加器低估无旗标（meta.wallclock.raw_s 与宿主 epoch 对账是唯一兜底）。可考虑周期性定时器观测（每 60s 一发短 withDeadline observe=true），代价是跑批内多 N 次微超时。
4. **Windows 通知未实现**：`notify()` 是 log-only；toast/推送可后续接入（任务计划程序上下文）。
5. **`buildYesterdayTopics.streakOf` 复杂度** O(回看天数 × 账本条目)：60d prune 上限内（单日几十条）可控；账本若膨胀需倒排索引（day → entries 预分组）。
6. **双仓镜像手工同步**：generate-poster 跨仓依赖 + 产物/SKILL 手工 cp，漏 cp 即漂移（build REQUIRED_MARKERS 只护产物内容、不护「是否 cp 过」）。可考虑 build.mjs 增加 --sync-vault 一步到位。

## 13. 变更记录

- **2026-10-03**: 建立本文档为唯一总纲；吸收 4 篇 dated 设计文档与 README 旧架构描述（均已加历史快照标注）；依据 15 个模块真源 + 模板 1273 行逐一核对契约（含 10-03 五要素：亮点/昨日话题追踪/社区热度/数据概览/趋势收尾）；记录设计债务 6 项（§12）。同日完成 10-03 五要素对齐（主仓 `7e14ea3`）、433 项测试全绿（425/0/8）、产物 3269 行。
