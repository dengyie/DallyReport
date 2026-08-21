---
name: ai-daily
description: 生成 AI 每日日报（自动每天 08:40 由 launchd 触发，也可手动 /ai-daily [--date YYYY-MM-DD]）。确定性覆盖 9 大板块 × 必查厂商花名册，grok-search/X/RSS 发现，对抗式核查，产出 docs/daily/YYYY-MM-DD-ai日报.md + 原始数据存档。
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
- `--force`：允许覆盖当日已存在的产物（默认若 `docs/daily/<date>-ai日报.md` 已存在则询问是否重跑）。

### 2. 计算日期窗口
- 报告日 T（即 `--date`）；新闻窗口 = **[T-2, T]**（覆盖前两天到当天）。
- 用 Bash 计算：`from=$(date -v-2d +%F)`、`to=$(date +%F)`（若指定 --date 则先对 T 用 `date -j -f %F <T> -v-2d +%F` 计算）。
- 工作目录固定为 `/Users/mango/project/claude-project/obsidian`。

### 3. 准备输出目录
- 确保 `docs/daily/` 存在：`mkdir -p docs/daily`（Obsidian 库内，可被库引用）。
- `outDir` = `/Users/mango/project/claude-project/obsidian/docs/daily`（绝对路径）。

### 3.4. run 前 build 产物检查（部署纪律）
- 跑 workflow 前，若 `scripts/ai-daily/`（即源模块 `ai-daily/scripts/ai-daily/`）任何源文件比产物
  `.claude/workflows/ai-daily.js` 新，必须先重建产物：`node scripts/ai-daily/build.mjs`。
- 检测命令（工作目录 = 源仓库根 `/Users/mango/project/claude-project/obsidian`）：
  `find ai-daily/scripts/ai-daily -newer ai-daily/.claude/workflows/ai-daily.js`——有输出即需要重建。
- 原因：run 用的是磁盘上 workflow 文件那一刻的内容，源改动只改 `scripts/ai-daily/*.mjs` 而没重建 +
  提交产物，run 就会用旧版（缺失 citation/最新渲染逻辑）。build 产物与源模块必须同步提交。

### 4. 调用 Workflow
用 Workflow 工具，`scriptPath: /Users/mango/project/claude-project/obsidian/.claude/workflows/ai-daily.js`，
`args` 传 JSON 对象：

```json
{
  "date": "YYYY-MM-DD",
  "window": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
  "outDir": "/Users/mango/project/claude-project/obsidian/docs/daily",
  "maxFetch": 12,
  "maxVerify": 12,
  "agentTimeoutMs": 360000,
  "probeTimeoutMs": 20000,
  "totalLimitMs": 1800000,
  "harvestBudgetMs": 540000,
  "discoverBudgetMs": 480000,
  "fetchBudgetMs": 480000,
  "verifyBudgetMs": 300000,
  "verifyInflightBufferMs": 60000
}
```

可省略 `maxFetch`/`maxVerify`（默认 12/12）。`agentTimeoutMs` 可选（默认 360000，即 6 分钟；超时视作失败，按阶段重试策略处理：harvest/discover/核查票不换新代理重跑，fetch 换一次，report 单次直出——8/15 起不再对昂贵代理做全新重跑，8/17 起 report 前由网关探针把关，失败即快速降级 raw archive，杜绝挂起空转拖满墙钟；8/18 大改后 md 不再经代理渲染，走 render-md 模块确定性拼接）。8/17 第十一项新增可选：`probeTimeoutMs`（默认 20000，Synthesize 前迷你探针超时）与 `totalLimitMs`（默认 1800000，主脚本总墙钟宽松兜底，超限跳过合成直接降级）。8/17 第十四项新增可选：`harvestBudgetMs`/`discoverBudgetMs`/`fetchBudgetMs`/`verifyBudgetMs`（默认 540000/480000/480000/300000 = 9/8/8/5min，即各阶段累计墙钟死线，超限跳过该阶段快速降级；切片和 = 30min 与 totalLimitMs 对齐；8/17 全量实测 50 代理健康包络 30.8min 装不进 30min 盘子——修复后 Verify **每批重算 room**、健康跑尾部被硬停并如实降 unverified，墙钟严格 ≤30min）。8/19 第十五项调序原因：discover 换 `--extra 4` 走 Tavily 快速兜底提速，harvest 保留 442-800s 慢但有效的 crops。8/20 第十六项：阶段预算只作**批间** BREAK 判定（墙钟守护在批次边界），单代理超时一律固定上界（harvest 1800s / discover labs 1800s·其余 2400s / fetch·verify 360s / report 600s），不随 room 收紧——8/19 回归（room 注入 timeoutMs 导致 436s 成功 discover 被 410s 判废）已由 test/no-room-in-timeout.test.mjs 源级固化。`verifyInflightBufferMs`（默认 60000）：Verify 累计死线在切片和后扣此缓冲（给最后一批在飞票的 60s timeoutMs 下限留位），保证批内在飞票拖满下限也越不过 Synthesize 总闸门。时钟源为脚本内 setTimeout 链累加器——Workflow realm 无 `performance`/`Date.now`，仅此链在 `await` 期间持续推进，故 budgetGate 真实生效。8/20 第十七项：`KNOWN_MAJOR_OUT` 保底种子 age gate——种子 `date` 距报告日 **≤21 天**注入，超期退役；无日期判超期；`SEED-AGE` 日志可见；`REPORT_DAY` 未知 fail-open 全注入。种子内容刷新（增 8 月里程碑）为独立人工动作。可选 `"boards": ["labs","strategy",...]` 限定**板块**子集（冒烟/单板调试用）。注意取值是**板块名**（labs/strategy/products/opensource/academic/funding/policy/safety/people），不是发现组名（如 `media-cn`/`media-en`/`opensource`/`academic` 是组名）——发现组按其覆盖的板块与 `boards` 求交集，若交集为空该组会被过滤掉。例：要激活 `media-cn` 组（覆盖 strategy/funding/policy/safety/people），传其中任一板块名（如 `["labs","strategy"]`），而非 `"media-cn"`。8/22 第十八项：降级判定改为**按板归属组统一**——`computeBoardStates`（boards.mjs）：板 `degraded` = 任一归属组失败（无返回）或 返回组自报 degraded；板 `missing` = 所有归属组全部无返回（无任何发现覆盖）。修复 8/21 bug：media-cn 组失败时，被 media-en 兜底的 strategy/funding/policy 之前既不上报 missing 也不标 `[degraded]`（同一失败组共享板静默 0 claims）；现在同组覆盖板全部如实标红，`discovery_degraded:missing_*` 只报真正无覆盖的独占板（safety/people）。新增 `test/coverage.test.mjs` 锁死该语义。8/22 第十九项：落盘改为**确定性 finalize.mjs**——workflow realm 无 fs（build 护栏：单文件自包含），workflow 只 return payloads 不写盘；此前落盘靠编排器手工 Write（SKILL 第 5 步），8/21 直跑 Workflow 工具时该手工步被跳过导致产物缺失。新增 `finalize.mjs`（Node fs 逐字节写 4 产物到 outDir/**，缺任一字段报错非 0 退出，CLI + 可 import 函数），`test/finalize.test.mjs` 锁保真/错误路径/幂等。收尾改为 `node scripts/ai-daily/finalize.mjs <workflow-result路径> --out <outDir>` 一键落盘。8/22 第二十项：兜底运行时 bug 修复——合组（media-cn/media-en）失败时兜底 entry 旧版 `board:null` 被下游全丢弃（兜底对历史高发的合组完全失效），改为按 `digest feed.boards ∩ g.boards` 派生归属板、交集中每板都补进 boardURLMap（dedup 跨板去重不重复抓取）；`computeBoardStates` 增第三参数 `recoveredKeys`，兜底救回的板 `missing` 降为 false（不再误标 unreached/无覆盖）但 `degraded` 保留 true（通道失败如实上报）并标 `recovered` 溯源。coverage 渲染补 `[recovered]`，meta 降级 flags 新增 `discovery_recovered:<boards>`。修复 §5.2 兜底的运行时缺陷（源级测试盲区，6 测新增固化）。

模型策略：本期全链路统一 deepseek-v4-flash（环境已配 `CLAUDE_CODE_SUBAGENT_MODEL`，无需在 args 指定）。勿覆盖模型。

### 5. 收尾与汇报
- 若 Workflow 返回 `artifacts` 且含 `payloads`：**4 个产物用 finalize 确定性落盘**——
  `node scripts/ai-daily/finalize.mjs <workflow-result路径> --out docs/daily`。finalize 从 result 的
  `payloads.{claims,sources,meta,md}` 逐字节写入 `docs/daily/<date>.verified-claims.json`、
  `<date>.sources.json`、`<date>.meta.json`、`<date>-ai日报.md`，缺任一字段报错非 0 退出（可一键重放、可单测，
  不再依赖主会话手工 Write——8/21 直跑 Workflow 工具时曾因跳过手工落盘而缺失产物）。md 由 workflow 内确定性渲染
  （render-md 模块）产出，report 成功即完整版、失败即降级版，**必然成功**，不再有 mdWriter 代理。
  - 直跑 Workflow 工具（非 skill 入口）时，workflow result 落在 task 的 output 文件，用上述 finalize 命令即可落盘。
- 确认 `docs/daily/<date>-ai日报.md` 等文件存在，向用户给出：
  - 统计：`stats`（抓取 URL 数 / 提取 claim 数 / 核查数 / 确认数 / 否决数 / **重大超窗事实数 `major_out`**——`[窗口外·重大]` 行业里程碑，非窗口内、未经投票，但应出现在正文/头条并如实标注）
  - 头条一句话：`headline`
  - 执行摘要：`summary`
  - 覆盖矩阵要点 + 确认无动态的厂商
  - **降级标记 `degraded`**（如 discovery_degraded / discovery_recovered / verify_agent_errors / fetch_budget_dropped / budget_skipped）——必须如实转达。`discovery_recovered:<boards>` 表示这些板 discover 代理失败但已从 harvest entries 兜底救回 URL（通道仍 degraded、内容已补，不再标 missing）。
- 若 Workflow 返回 `error` 或产物缺失：降级处理，产出一份"未核查日报"到 `docs/daily/<date>-ai日报.md`（标注降级原因），并保留已归档 JSON；如实向用户说明失败点。
- 不要向用户重复贴全文大 JSON；贴 md 文件路径 + 摘要即可。
- **生成完成后清理本会话开起的浏览器/进程**：若本次生成过程中，我（编排器）为开发/调试而调用过 Playwright MCP / 启动过浏览器或 node 进程，则收尾时**只关闭我自己开起的那几个**（精确按本会话子进程/本会话写入的标记关闭，或用 `pkill -f 'playwright-mcp.*<本会话唯一标识>'`）。**绝不**去关用户自己开的 Chrome/浏览器/其他 Claude Code 会话的工具进程——那些不属于日报系统。关闭前用 `ps -o pid,etime,lstart,command` 复核该进程确实是本会话拉起、且不是其它会话/用户正在用的，再终止。本条为流程纪律：生成完日报即清理自身资源，不遗留占用。

## 产出物命名
- `docs/daily/YYYY-MM-DD-ai日报.md`
- `docs/daily/YYYY-MM-DD.verified-claims.json`
- `docs/daily/YYYY-MM-DD.sources.json`
- `docs/daily/YYYY-MM-DD.meta.json`

## 手动补跑示例
```
/ai-daily --date 2026-08-12
/ai-daily --date 2026-08-13 --force
```
