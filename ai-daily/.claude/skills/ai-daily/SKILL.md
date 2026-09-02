---
name: ai-daily
description: 生成 AI 每日日报（自动每天 08:40 由 launchd 触发，也可手动 /ai-daily [--date YYYY-MM-DD]）。确定性覆盖 10 大板块 × 必查厂商花名册，grok-search/X/RSS 发现，对抗式核查，产出 ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport/<date>/YYYY-MM-DD-ai日报.md + 原始数据存档。
---

# AI 每日日报（ai-daily）

## 何时使用
- 用户要求"今天的 AI 日报 / 今日 AI 新闻 / 每日 AI 简报"。
- 手动补跑历史某天：`/ai-daily --date 2026-08-12`。
- 每日 08:40 由 launchd 以 headless 方式自动触发（无需用户在场）。

## 流程总览
编排器（本 skill，主会话）→ 调用 Workflow 工具跑 `.claude/workflows/ai-daily.js` → 子代理完成发现/抓取/核查/合成并**直接落盘** → 本 skill 汇报摘要 + 降级标记。

## 步骤

### 1. 解析参数
- 读取 `args` 或指令中的 `--date YYYY-MM-DD`；缺省 = 今天（`date +%F`）。
- `--force`：允许覆盖当日已存在的产物（默认若 iCloud DallyReport/<date>/<date>-ai日报.md 已存在则询问是否重跑）。

### 2. 计算日期窗口
- 报告日 T（即 `--date`）；新闻窗口 = **[T-2, T]**（覆盖前两天到当天）。
- 用 Bash 计算：`from=$(date -v-2d +%F)`、`to=$(date +%F)`（若指定 --date 则先对 T 用 `date -j -f %F <T> -v-2d +%F` 计算）。
- 工作目录固定为 `/Users/mango/project/claude-project/obsidian`。

### 3. 准备输出目录
- iCloud 路径：`~/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport/<date>/`（单斜杠，Obsidian 库内，可被库引用）。
- `outDir` = 该 iCloud 路径的绝对路径展开（`date` 替换为报告日）。

### 3.4. run 前 build 产物检查（部署纪律）
- 跑 workflow 前，若 `scripts/ai-daily/` 任何源文件比产物
  `.claude/workflows/ai-daily.js` 新，必须先重建产物：`node scripts/ai-daily/build.mjs`。
- 检测命令（工作目录 = 源仓库根 `/Users/mango/project/claude-project/obsidian`）：
  `find scripts/ai-daily -newer .claude/workflows/ai-daily.js`——有输出即需要重建。
- 原因：run 用的是磁盘上 workflow 文件那一刻的内容，源改动只改 `scripts/ai-daily/*.mjs` 而没重建 +
  提交产物，run 就会用旧版（缺失 citation/最新渲染逻辑）。build 产物与源模块必须同步提交。

### 4. 调用 Workflow
用 Workflow 工具，`scriptPath: /Users/mango/project/claude-project/obsidian/.claude/workflows/ai-daily.js`，
`args` 传 JSON 对象：

```json
{
  "date": "YYYY-MM-DD",
  "window": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
  "outDir": "/Users/mango/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport/YYYY-MM-DD",
  "maxFetch": 16,
  "maxVerify": 16,
  "agentTimeoutMs": 360000,
  "probeTimeoutMs": 20000,
  "totalLimitMs": 1800000,
  "harvestBudgetMs": 540000,
  "discoverBudgetMs": 480000,
  "fetchBudgetMs": 480000,
  "verifyBudgetMs": 300000,
  "verifyInflightBufferMs": 60000,
  "synthesisLimitMs": 600000,
  "modelLadder": ["deepseek-v4-flash", "grok-4.6", "claude-opus-4-8", "gemini-3.7-flash-high"],
  "ladderBudgetMs": 900000
}
```

> **headless vs 手动**：headless（run-daily.sh 每日调用）**在指令里显式传** `linuxdoCdpHost: "127.0.0.1:9222"`（复用 9222 登录态 Chrome）；手动 `/ai-daily` 默认**不启用**（避免离开 9222 环境误跑），如需启用手写 `"linuxdoCdpHost": "127.0.0.1:9222", "linuxdoMaxSources": 24`。

> **8/27 Task 2 预抓隔离数据流**：linux.do 的 CDP 登录态抓取**前移到宿主 Node**——headless 由 `run-daily.sh` 在调 Workflow 前先跑 `node scripts/ai-daily/linuxdo-prefetch.mjs --host 127.0.0.1:9222 --max-sources 24`，stdout 成功 JSON **落盘** `~/.ai-daily/linuxdo-prefetch.json`。**9/01 P2**：JSON 本体**不得** `$(cat)` 进双引号 `claude -p`（帖子标题含引号会破 shell）；编排器 **Read 该文件** 后把对象作为 `args.linuxdoPrefetched` 传入。**数据流**：`linuxdo-prefetch.mjs（宿主 Node CLI，复用 linuxdo.mjs 的 fetchLinuxDoNews34）→ stdout 成功 JSON（ok:true + posts）→ 落盘 prefetch 文件 → 编排器 Read → `args.linuxdoPrefetched` → Workflow realm 内严格校验 `ok===true && posts 含非空 url/title` → LINUXDO-OK 消费进 linuxdo 板（`found_via:'linuxdo-cdp'`，consume 保留 `snippet`）。**9/01 覆盖韧性**：`allocateFetchBudget` 之后，配额内带非空 snippet 的 linuxdo 由 `mintLinuxdoSource` **直铸** forum claim 进 `extracted`（日志 `LINUXDO-MINT n 条配额内 snippet 直铸`），并从 fetch 批剔除——**跳过 fetch 代理**（linux.do 无 cookie 的裸 WebFetch 是结构性弱路径），铸出的 claim 仍走 Verify，不标 `isMajorOut`。空 snippet 仍走既有 fetch 代理。配额外的 linuxdo 只在 `budgetDropped`，不铸。realm **仍不得**调 `fetchLinuxDoNews34`。**失败契约**：prefetch 失败/空 stdout → run-daily.sh 一律把 `{"ok":false,"reason":…}` 写入同一文件（**绝不以 stderr 文本当成功 JSON**）；realm 内无有效 `linuxdoPrefetched` 时**绝不调用裸 fetchLinuxDoNews34**（realm 无 fetch/WebSocket 全局）→ 走 `LINUXDO-FAIL no_fetch_realm` 稳定降级（meta `linuxdo_degraded:no_fetch_realm`，板不崩、无 ReferenceError）。**手动 `/ai-daily` 默认不产生 prefetch** → linuxdo 板走 no_cdp_host 空板或不启用；**绝不在 realm 内裸抓 CDP**。`linuxdo-prefetch.mjs` 是**宿主 Node CLI，build 时不 inline 进产物**（build.mjs 的 MODULES 不含它；`build.test.mjs` F2 断言产物无 `prefetchLinuxDo`/无 `require(`/无裸 `await fetchLinuxDoNews34(`）。

可省略 `maxFetch`/`maxVerify`（默认 16/16——8/31 由 12 上调，8/30 实证 45 发现仅 12 抓取、预算掐头去尾）。`agentTimeoutMs` 可选（默认 360000，即 6 分钟；超时视作失败，按阶段重试策略处理：harvest/discover 不换新代理重跑，fetch 换一次，verify/report 走阶梯（零素材只跑首级，有素材才爬满四级）——8/15 起不再对昂贵代理做全新重跑；8/30 起 report 前探针仅观察不否决（advisory），真死网关由 report 自身 600s 超时 + 模型阶梯兜底后如实降 raw archive（探针 20s 失败不再一票否决整份 report），杜绝挂起空转拖满墙钟；8/18 大改后 md 不再经代理渲染，走 render-md 模块确定性拼接）。8/23 新增可选 `linuxdoCdpHost`（默认 null → 不启用；传如 `"127.0.0.1:9222"` 即启用 linux.do 登录态 CDP 独立发现组——复用用户常开的 9222 登录态 Chrome 抓 `https://linux.do/c/news/34.json`，产出 URL 进 linuxdo 板；配额内带 snippet 的帖由 `mintLinuxdoSource` 直铸 forum claim（日志 `LINUXDO-MINT`）再走 Verify，空 snippet 才进 Fetch 代理，日志 `LINUXDO-OK n topics`、失败即标 `linuxdo_degraded`）与 `linuxdoMaxSources`（默认 24，按配额轮换进 linux.do 板的 URL 候选）。**headless 启用**：run-daily.sh 每日调用会显式传 `linuxdoCdpHost: "127.0.0.1:9222"`；**手动补跑默认不启用**，需在 args 里传 `"127.0.0.1:9222"` 才启用（避免离开 9222 Chrome 环境误跑）。**纪律**：linux.do CDP 只**复用** 9222 浏览器的**登录态**、只在其**打开一个临时标签**（`/json/new`）抓完即关（`closeTab` try/finally），**绝不关闭 9222 浏览器本身、绝不新开独立 Chrome**。8/17 第十一项新增可选：`probeTimeoutMs`（默认 20000，Synthesize 前观察探针超时——8/30 起仅记录网关饱和度，不否决合成）与 `totalLimitMs`（默认 1800000，仅约束 Harvest–Verify 切片死线，合成入口不再看总墙钟）。9/01 方案 D 新增可选：`synthesisLimitMs`（默认 600000 = report 单次 timeout；合成与总墙钟脱钩，进入 Synthesize 即无条件尝试 report，只受自身 timeout × reportTries 约束）。8/17 第十四项新增可选：`harvestBudgetMs`/`discoverBudgetMs`/`fetchBudgetMs`/`verifyBudgetMs`（默认 540000/480000/480000/300000 = 9/8/8/5min，即各阶段累计墙钟死线，超限跳过该阶段快速降级；切片和 = 30min 与 totalLimitMs 对齐；8/17 全量实测 50 代理健康包络 30.8min 装不进 30min 盘子——修复后 Verify **每批重算 room**、健康跑尾部被硬停并如实降 unverified，墙钟以批次边界为软目标——末批在飞 360s 与真死网关时 report 重试（≤2×600s）可越过 30min）。8/19 第十五项调序原因：discover 换 `--extra 4` 走 Tavily 快速兜底提速，harvest 保留 442-800s 慢但有效的 crops。8/20 第十六项：阶段预算只作**批间** BREAK 判定（墙钟守护在批次边界），单代理超时一律固定上界（harvest 1800s / discover labs 1800s·其余 2400s / fetch·verify 360s / report 600s），不随 room 收紧——8/19 回归（room 注入 timeoutMs 导致 436s 成功 discover 被 410s 判废）已由 test/no-room-in-timeout.test.mjs 源级固化。`verifyInflightBufferMs`（默认 60000）：Verify 累计死线在切片和后扣此缓冲（给最后一批固定 360s 在飞票留余量）；批内尾部超死线由软目标容忍，不保证严格钉在 30min。时钟源为脚本内 setTimeout 链累加器——Workflow realm 无 `performance`/`Date.now`，仅此链在 `await` 期间持续推进，故 budgetGate 真实生效。8/20 第十七项：`KNOWN_MAJOR_OUT` 保底种子 age gate——种子 `date` 距报告日 **≤21 天**注入，超期退役；无日期判超期；`SEED-AGE` 日志可见；`REPORT_DAY` 未知 fail-open 全注入。种子内容刷新（增 8 月里程碑）为独立人工动作。可选 `"boards": ["labs","strategy",...]` 限定**板块**子集（冒烟/单板调试用）。注意取值是**板块名**（labs/strategy/products/opensource/academic/funding/policy/safety/people/linuxdo），不是发现组名（如 `media-cn`/`media-en`/`opensource`/`academic` 是组名）——发现组按其覆盖的板块与 `boards` 求交集，若交集为空该组会被过滤掉。`linuxdo` 板需配合 `linuxdoCdpHost` 启用 CDP 才有内容，默认空板。例：要激活 `media-cn` 组（覆盖 strategy/funding/policy/safety/people），传其中任一板块名（如 `["labs","strategy"]`），而非 `"media-cn"`。8/22 第十八项：降级判定改为**按板归属组统一**——`computeBoardStates`（boards.mjs）：板 `degraded` = 任一归属组失败（无返回）或 返回组自报 degraded；板 `missing` = 所有归属组全部无返回（无任何发现覆盖）。修复 8/21 bug：media-cn 组失败时，被 media-en 兜底的 strategy/funding/policy 之前既不上报 missing 也不标 `[degraded]`（同一失败组共享板静默 0 claims）；现在同组覆盖板全部如实标红，`discovery_degraded:missing_*` 只报真正无覆盖的独占板（safety/people）。新增 `test/coverage.test.mjs` 锁死该语义。8/22 第十九项：落盘改为**确定性 finalize.mjs**——workflow realm 无 fs（build 护栏：单文件自包含），workflow 只 return payloads 不写盘；此前落盘靠编排器手工 Write（SKILL 第 5 步），8/21 直跑 Workflow 工具时该手工步被跳过导致产物缺失。新增 `finalize.mjs`（Node fs 逐字节写 4 产物到 outDir/**，缺任一字段报错非 0 退出，CLI + 可 import 函数），`test/finalize.test.mjs` 锁保真/错误路径/幂等。收尾改为 `node scripts/ai-daily/finalize.mjs <workflow-result路径> --out <outDir>` 一键落盘。8/22 第二十项：兜底运行时 bug 修复——合组（media-cn/media-en）失败时兜底 entry 旧版 `board:null` 被下游全丢弃（兜底对历史高发的合组完全失效），改为按 `digest feed.boards ∩ g.boards` 派生归属板、交集中每板都补进 boardURLMap（dedup 跨板去重不重复抓取）；`computeBoardStates` 增第三参数 `recoveredKeys`，兜底救回的板 `missing` 降为 false（不再误标 unreached/无覆盖）但 `degraded` 保留 true（通道失败如实上报）并标 `recovered` 溯源。coverage 渲染补 `[recovered]`，meta 降级 flags 新增 `discovery_recovered:<boards>`。修复 §5.2 兜底的运行时缺陷（源级测试盲区，6 测新增固化）。

> **8/26 静态兜底（static-fallback）真实降级契约**：discover 某板**所有归属组全失败**且 harvest-fallback 未救回时，从 `boards.mjs` 的 `STATIC_FALLBACK_SOURCES`（精选常驻一级/官方新闻页 URL）注入该板 `boardURLMap`（`found_via:'static-fallback'`），fetch/verify 仍对抗式处理。**三个诚实契约**：① 静态注入在 `allocateFetchBudget` **之前**（实获配额）；② 静态项**只进 boardURLMap、不进 discoverRows.urls → `urls_discovered` 绝不包含静态项**（统计只算真 discovery 行）；③ `degraded` 保留如实上报（discover 代理失败不因兜底内容而伪健康）。`budget_skipped:<阶段>` **仅表示整段阶段被跳过**（该阶段累计墙钟死线超限），不代表单批失败；`fetch_budget_dropped:N` 是 fetch **启动前**按配额算的丢弃计数（不是真抓了 N 条）。linux.do：`no_cdp_host`（默认）→ LINUXDO-SKIP 空板不降级；`no_fetch_realm`（有 host 但无有效 prefetch）→ `linuxdo_degraded:no_fetch_realm` 诚实降级。**
>
> **9/01 覆盖韧性（Fetch 首批混排 + linuxdo snippet 直铸 + breaker 阶段隔离）**：① `allocateFetchBudget` Phase 1 已按通道轮询混排 `linuxdo-cdp` / `static-fallback`；编排层**不再**二次静态前置，`FETCH_FIRST_BATCH === FETCH_BATCH`（默认 6）——首批必须是 prefer 通道混合物，预算一紧不得把已获配额的 linuxdo 整批蒸发。`preferStaticFirst` 函数本体留在 `dedup.mjs` 作纯函数，编排层不调用。② 配额内 linuxdo+snippet 由 `mintLinuxdoSource` 直铸（见上数据流）。FETCH-SALVAGE 改看 `!stageFetchRan`（Fetch 批未跑），不因 mint 已写入 `extracted` 而关闭救护。③ `phase('Discover')` 之后、代理批循环之前调 `BREAKER.resetConsecutive()`——清连续失败计数，不清 `failures`/`successes`/`reason`；已跳闸仍 open。`total=5` 仍是 run 级保险丝。

> **8/31 P1 墙钟标定与计数型断路器（新增可选 args）**：realm 唯一时钟是 `setTimeout` 链累加器，它计的是 **tick 发生次数 × 250ms**，事件循环饱和时 tick 被饿死 → **只低估、永不高估**（8/31 生产 run 实测 Fetch gate ≥4.7×、Verify ≥6.6×、synth ≥7.6×，4h13m 的 run 零 `BUDGET-SKIP`，30min 软目标形同不存在）。修法两条：① **墙钟标定**——`setTimeout(ms)` 绝不早于 ms 真实毫秒触发，故每次真超时都证明「真实经过 ≥ ms」，与同窗口累加器增量相比即得饥饿倍率（`wallclock.mjs`），所有闸门读的 `RUN_ELAPSED` 已是标定后读数（**单调不减**，倍率回落不让已越线阶段复活；倍率封顶 20×；无观测时逐字节等价旧行为，健康跑零影响）；② **计数型断路器**——失败计数不依赖时钟，饱和下依然准确，`safeAgent` 终局失败/成功均记账，Discover 批首查 `BREAKER.open()`，跳闸即跳**代理**余批直连 static-fallback → Fetch（8/31 实测 Harvest 烧 70min、Discover 再烧 129min，而失败信号早已密集）。**linuxdo 是宿主预抓通道，消费在代理批循环之前，断路器跳闸不得丢掉已预抓 posts。** **9/01**：`phase('Discover')` 入口调 `BREAKER.resetConsecutive()`（清连续计数，不清累计 failures；已跳闸仍 open），Harvest 垫高的 consecutive 不得让 Discover 第一失败即跳闸。新增可选 args：`breakerConsecutive`（默认 3，连续失败跳闸阈值）、`breakerTotal`（默认 5，累计失败跳闸阈值）。**可审计**：日志 `BREAKER-OPEN Discover 余批跳过`、`[墙钟标定 … 饥饿倍率 N.NN×]`；降级旗标 `breaker_open:<reason>`、`wallclock_starved:<N>x`（**峰值**倍率 >1.5 且有真实观测时——先饿后恢复不抹旗标）；meta 增 `wallclock{raw_s,calibrated_s,starvation_factor,peak_factor,observations}`（`starvation_factor` 为最新倍率、`peak_factor` 为本 run 最高）与 `breaker{open,reason,failures,successes,consecutive}` 便于与宿主侧 `run-daily.sh` 记录的**真实 epoch** 三方对账。探针超时 `withDeadline(..., false)` **不**喂 `WALL.observe`（短窗不得污染标定）。

> **9/02 模型阶梯（仅 report + verify）**：`args.modelLadder` 默认 `deepseek-v4-flash` → `grok-4.6` → `claude-opus-4-8` → `gemini-3.7-flash-high`；`args.ladderBudgetMs` 默认 900000（15 分钟）。**仅 report / verify 走阶梯**（`safeAgentWithLadder`）；**harvest / discover / fetch 不走阶梯**，仍继承环境 `CLAUDE_CODE_SUBAGENT_MODEL` 经 `safeAgent`（不传 `model:` 字面量）。仅 TRANSIENT（422/429/5xx/524/timeout/gateway/cloudflare/model not found/upstream）或 `withDeadline` 超时 null 换级；schema / end_turn 等同级消化。**`withDeadline` reject 必须透传错误进工厂 catch**（不得 `settle(null)` 抹消息，否则生产里 schema 与 524 都长得像 `(null)`）。中间级失败不 `BREAKER.record`；终局 null 才由调用方记账。预算在当前级失败后再查，超了停在当前级；`ladderBudgetMs<=0` 关闭检查。**Verify 全阶段共享 `verifyLadderT0`**，票不得各自重新吃满 `ladderBudgetMs`。`reportTries` 仍是外层闸门（`allClaims.length === 0 ? 1 : 2`）：零素材只跑 `MODEL_LADDER[0]`，有素材才爬满四级。`generated_by` / frontmatter `model:` / 横幅跟 report 实际用到的模型（换级后的），不是永远 `MODEL_LADDER[0]`。降级旗标 `ladder_used:<label>:<model>+…`（非首级救回）、`ladder_exhausted:report|verify`（该阶段阶梯耗尽）。

### 5. 收尾与汇报
- 若 Workflow 返回 `artifacts` 且含 `payloads`：**4 个产物用 finalize 确定性落盘**——
  `node scripts/ai-daily/finalize.mjs <workflow-result路径> --out "<iCloud DallyReport/<date> 路径>"`。finalize 从 result 的
  `payloads.{claims,sources,meta,md}` 逐字节写入 `<date>.verified-claims.json`、
  `<date>.sources.json`、`<date>.meta.json`、`<date>-ai日报.md`，缺任一字段报错非 0 退出（可一键重放、可单测，
  不再依赖主会话手工 Write——8/21 直跑 Workflow 工具时曾因跳过手工落盘而缺失产物）。md 由 workflow 内确定性渲染
  （render-md 模块）产出，report 成功即完整版、失败即降级版，**必然成功**，不再有 mdWriter 代理。
  - 直跑 Workflow 工具（非 skill 入口）时，workflow result 落在 task 的 output 文件，用上述 finalize 命令即可落盘。
- 确认 `<iCloud DallyReport/<date>/<date>-ai日报.md>` 等文件存在，向用户给出：
  - 统计：`stats`（抓取 URL 数 / 提取 claim 数 / 核查数 / 确认数 / 否决数 / **重大超窗事实数 `major_out`**——`[窗口外·重大]` 行业里程碑，非窗口内、未经投票，但应出现在正文/头条并如实标注）
  - 头条一句话：`headline`
  - 执行摘要：`summary`
  - 覆盖矩阵要点 + 确认无动态的厂商
  - **降级标记 `degraded`**（如 discovery_degraded / discovery_recovered / verify_agent_errors / fetch_budget_dropped / budget_skipped / `ladder_used:` / `ladder_exhausted:`）——必须如实转达。`discovery_recovered:<boards>` 表示这些板 discover 代理失败但已从 harvest entries 兜底救回 URL（通道仍 degraded、内容已补，不再标 missing）。`ladder_used:<label>:<model>+…` 表示 report/verify 在非首级模型救回；`ladder_exhausted:report|verify` 表示该阶段四级/预算耗尽。
- 若 Workflow 返回 `error` 或产物缺失：降级处理，产出一份"未核查日报"到 `<iCloud DallyReport/<date>/<date>-ai日报.md>`（标注降级原因），并保留已归档 JSON；如实向用户说明失败点。
- 不要向用户重复贴全文大 JSON；贴 md 文件路径 + 摘要即可。
- **生成完成后清理本会话开起的浏览器/进程**：若本次生成过程中，我（编排器）为开发/调试而调用过 Playwright MCP / 启动过浏览器或 node 进程，则收尾时**只关闭我自己开起的那几个**（精确按本会话子进程/本会话写入的标记关闭，或用 `pkill -f 'playwright-mcp.*<本会话唯一标识>'`）。**绝不**去关用户自己开的 Chrome/浏览器/其他 Claude Code 会话的工具进程——那些不属于日报系统。关闭前用 `ps -o pid,etime,lstart,command` 复核该进程确实是本会话拉起、且不是其它会话/用户正在用的，再终止。本条为流程纪律：生成完日报即清理自身资源，不遗留占用。

## 产出物命名
- `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport/YYYY-MM-DD/YYYY-MM-DD-ai日报.md`
- `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport/YYYY-MM-DD/YYYY-MM-DD.verified-claims.json`
- `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport/YYYY-MM-DD/YYYY-MM-DD.sources.json`
- `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport/YYYY-MM-DD/YYYY-MM-DD.meta.json`

## 手动补跑示例
```
/ai-daily --date 2026-08-12
/ai-daily --date 2026-08-13 --force
```
