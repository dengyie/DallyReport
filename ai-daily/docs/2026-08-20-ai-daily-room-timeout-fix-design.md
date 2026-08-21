# ai-daily room-as-timeoutMs 错配修复设计

> 日期：2026-08-20 · 关联：第十四项墙钟治理（2026-08-13-ai-daily-report-design.md）的回归修复
> 状态：设计已确认；**8/20 修正——方案 B（批前 room 预检）因与固定上界+阶段预算数学不相容而下马**（见 §0）

## §0 设计修正（2026-08-20）

brainstorm 阶段确认的**方案 B（批前 room 预检 `if (roomMs < 固定上界) break`）在落地前被发现与两项已确认约束数学不相容**，故下马：

- 固定上界（约束 3）：harvest 1800s / discover 1800s(labs)·2400s / fetch·verify 360s / report 600s。
- 第十四项累计死线（`budget.mjs` `computePhaseDeadlines` + template 行 56-62 切片 9+8+8+5=30min）：Harvest 540s / Discover 1020s / Fetch 1500s / Verify 1740s。

方案 B 预检在各阶段 START 时的 `roomMs` 为该阶段切片量级（Harvest≈540s、Discover 增量≈480s、Verify 增量≈240s），**全部 < 固定上界**（1800/2400/360s）→ 预检 `roomMs < 上界` 恒真 → **Harvest/Discover/Verify 首批即触发 BREAK**，比 8/19 bug 更糟（只有 Fetch 因上界 360s < room 480s 放行）。

**修正后的修复**：只做语义解耦的第一层——移除 `timeoutMs` 里的 `room`（与 60s 下限），恢复固定上界；**保留第十四项现有的批间 BREAK 检查**（`if (!budgetGate(stage).ok) break`，余批跳过）作墙钟兜底。这与 **8/16 成功配置**（固定 1800/2400s、无 room 注入、21.7min 成功产出）等价，外加第十四项的 BREAK 安全网。

**30min 由硬目标降为软目标**：健康跑（~22min，各 agent 远低于固定上界）天然达成；唯一突破路径是某个代理真·挂死跑满固定上界（discover 2400s=40min），现实罕见（deepseek 网关「connection closed」返回 null、不挂死；第十四项 tries=1 已消除 80min 串行死路）。突破时仍由 Synthesize 闸门（`synthAllowed`）+ render-md 降级版兜底产出。约束 5 的决策随之更新。

## Context（为什么改）

2026-08-19 手动补跑（`/ai-daily --date 2026-08-19 --force`）严重降级空跑：`urls_discovered:0`、9 板全 `unreached/no_discover_agent`、只剩 KNOWN_MAJOR_OUT 种子注入的 3 条。表象与 8/17 同源失败一致，一度判定为网关病态窗口。

systematic-debugging 读 workflow journal + 代理 transcript 后定位到**真实根因是第十四项引入的代码回归**，不是网关：

- `disc:academic` 代理**实际成功了**：transcript 显示它跑 436s，成功调用 `StructuredOutput` 提交 6 条真实论文 URL，`tool_result: "Structured output provided successfully"`、`is_error: null`。
- 但 `safeAgent` 收到 **null**：workflow 日志 `agent 超时 410s 无产出 → safeAgent retry 1 disc:academic (null agent) → DISCOVER-FAIL disc:academic`。
- **竞态**：代理 436s 完成 vs `withDeadline` 410s 定时器。`settle(null)` 先触发（`done=true`），代理的成功 resolve 被 `if (!done)` 守卫丢弃。
- **410s 怎么来**：`timeoutMs = Math.max(60000, Math.min(2400000, room))`，`room = Discover 累计死线(1020s) − RUN_ELAPSED(≈610s) = 410s`。
- **概念错配**：`room` 是**整个阶段的剩余墙钟**，被当作**单个代理的超时**。单代理正常耗时（实测 436s，历史均值 609s）> room(410s) → 必然超时 → 成功结果被静默丢弃。

历史方差证据（17 个 academic discover 样本）：min=96s, max=3825s, avg=609s。任何固定的 `timeoutMs` 都两头不讨好——但**错误不在固定值，而在把墙钟预算塞进代理超时**。

### 影响面

第十四项 D 节把这个错配模式系统性铺到了**全部五个 safeAgent 调用点**（harvest/discover/fetch/verify/report），不是局部。故修复需重新确立语义分层，不是单点补丁。

## 关键约束（用户已逐条确认，8/20 修正第 5 项）

| # | 约束 | 决策 |
|---|---|---|
| 1 | 墙钟 30min vs 救回踩线成功，谁优先 | **分层解耦**（两者都守） |
| 2 | 单代理超时不看 room 后取什么值 | **固定上限**（移除 room 收紧） |
| 3 | 上限取多少 | **沿用现有上界**（harvest 1800s / discover 1800s(labs)·2400s / fetch 360s / report 600s） |
| 4 | 批次启动后代理跑到死线外要不要中断 | **不中断，让它跑完** |
| 5 | 病态运行时墙钟能否被轻微突破 | ~~方案 B：批前 room 预检~~ → **8/20 修正：软目标 + 保留现有批间 BREAK 兜底**（见 §0） |

## 设计

### §1 核心语义分层

两个本该独立的职责被第十四项混淆，修复后完全解耦：

| 层 | 职责 | 管什么 | 触发动作 |
|---|---|---|---|
| **阶段级（墙钟）** | 守 30min 总预算（软目标） | "余批要不要继续" | 批间 `budgetGate(stage).ok` 检 → false 则 BUDGET-BREAK 跳过余批 |
| **代理级（超时）** | 防单代理挂死 | "单个代理跑多久" | `withDeadline` 到固定上界 → `settle(null)` |

**修复原则**：墙钟只在**批次边界**判定（第十四项现有的批间 BREAK 检），从不进入单代理超时。单代理超时用固定上界，与 room 无关。

**救回 academic 的机制**：解耦后 `disc:academic` 的 timeoutMs = 固定上界 2400s（discover 非 labs），436s 正常完成 → 结果被采用。

**30min 守护机制（8/20 修正）**：批间 BREAK 检（第十四项已有）在余批前查墙钟，超累计死线则跳过——健康跑永不触发（room≫死线），病态跑截断后续阶段、走既有降级路径。**不再有批前预检**（方案 B 已下马，见 §0）。唯一可突破 30min 的场景是单代理挂死跑满固定上界，由 Synthesize 闸门 + render-md 降级版兜底。

### §2 五个调用点的具体改动

全部 5 个 timeoutMs 表达式统一改法：**移除 `min(上界, room)` 中的 room 与 `max(60s, ...)` 下限，留固定上界**。不动批循环（第十四项现有批间 BREAK 保留）。

改动在**真源 `scripts/ai-daily/ai-daily.template.js`**，改完 `node scripts/ai-daily/build.mjs` 重新生成。

| 阶段 | template 行 | 现 timeoutMs | 改后 timeoutMs |
|---|---|---|---|
| Harvest | 200 | `max(60s, min(1800s, room))` | `1800000` |
| Discover | 273 | `max(60s, min(labs?1800s:2400s, room))` | `g.key === 'labs' ? 1800000 : 2400000` |
| Fetch | 303 | `max(60s, min(360s, room))` | `AGENT_TIMEOUT_MS` |
| Verify | 389 | `max(60s, min(360s, gate.roomMs))` | `AGENT_TIMEOUT_MS` |
| Report | 482 | `max(60s, min(600s, TOTAL_LIMIT_MS - RUN_ELAPSED()))` | `600000` |

**关键细节**：

1. **60s 下限一并移除**。解耦后 timeoutMs 是固定上界（最小 360s），不存在被压扁场景，下限成多余。

2. **死变量清理**：Harvest 行 190 `const harvestGate = budgetGate('Harvest')` + 行 193 `const room = harvestGate.roomMs`、Discover 259+262、Fetch 298+301 仅服务于已移除的 room 注入，删除（这些 START 快照只用于取 room；批间 BREAK 在循环内重新调 `budgetGate(stage)`，不依赖它们）。Verify 的 `gate`（行 387 `const gate = budgetGate('Verify')`）仍被批间 BREAK（行 388 `!gate.ok`）使用，**保留**。

3. **Report**：解耦后纯 `600000`，仍受 `synthAllowed`（行 464 `RUN_ELAPSED() <= TOTAL_LIMIT_MS && probeGateway('report')`）保护——墙钟过 totalLimit 时不启动 report，等价兜底。

4. **第十四项注释更新**：行 199「8/17 第十四项：timeoutMs 收紧到阶段剩余预算」改为「8/20 第十六项：timeoutMs 解耦到固定上界（与 room 无关）」并注明 8/19 disc:academic 436s 被 410s 判废的根因；行 383-385「room 由阶段 START 改每批重算…60s 下限」改为「vtimeout 取固定 AGENT_TIMEOUT_MS，与 room 无关；批间 BREAK 仍每批重算 gate」。

5. **保留不动的部分**（边界）：`budgetGate` / `PHASE_DEADLINES` / `budgetSkipped` 记账 / `BUDGET-SKIP`·`BUDGET-BREAK` 日志 / 预算常量 / 批间 BREAK 检 / `TRANSIENT` 正则 / `withDeadline` / `safeAgent` tries / `probeGateway` / KNOWN 种子 / 9 板覆盖矩阵 / 核查终判序 / 3 JSON 落盘语义 / render-md。

### §3 降级诚实性与边界

**降级标记不变**。`budget_skipped`（既有机制）如实记录被 BUDGET-BREAK 跳过的阶段，无新标记。

**降级级联安全性**（沿用第十四项已验证的空结果路径，无新抛错点）：
- Harvest BREAK → digest 空 → discover prompt 只剩 X 搜索兜底（无害）。
- Discover BREAK → boardURLs 空 → Fetch 不执行 → 该板 `failedBoardKeys` → meta `missing_*` 如实。
- Fetch BREAK → sources 空 → claims 空 → 确认只剩 KNOWN_MAJOR_OUT 注入。
- Verify BREAK → claim 降 unverified（既有行为），md 覆盖自检如实呈现。
- Report 不启动 → 走确定性 render-md 降级版（`synthAllowed=false` 既有路径）。

**健康跑行为不变**：8/16 成功 run（21.7min）即固定 1800/2400s、无 room 注入的配置 → 修复后行为一致。这是修复不引入回归的关键保证。

### §4 验证策略

从快到慢：

1. **静态检查**：`node --check` 构建产物 + `node scripts/ai-daily/build.mjs`（默认构建自带 zero-placeholder-residue 守卫）。

2. **回归守卫（源级，固化根因）**：新增 `scripts/ai-daily/test/no-room-in-timeout.test.mjs`——读 `ai-daily.template.js`，断言任何 `timeoutMs:` 或 `vtimeout =` 赋值行（剔除 `//` 注释行）不得含 `room`/`roomMs`/`RUN_ELAPSED`，且 5 个固定上界字面量在场。`node --test` 跑。本次根因（room 重注入）复发即红。

3. **既有单元测试**：`scripts/ai-daily/test/budget.test.mjs`（不改）仍覆盖 `makeBudgetGate` 在 room 不足时返回 `ok:false` + 正确 `roomMs`——批间 BREAK 机制依赖它，纯函数、mock 时钟、跑得快。无需新增 budget 测试（timeoutMs 不在 budget.mjs，回归由第 2 项守卫）。

4. **预算触发微测**（~1-2min，强制路径）：单板冒烟带 `harvestBudgetMs:100`（极端小预算）+ `boards:['labs']` → 断言：
   - batch 1 后 elapsed>100ms → 批间 BREAK 触发 `BUDGET-BREAK Harvest 余批跳过`（验证 BREAK 是活代码非死代码）；
   - `budget_skipped:Harvest` 进 meta degraded；
   - 后续阶段仍降级跑完、KNOWN 种子注入、4 产物落盘。

5. **单板冒烟**（`boards:['labs','academic'], maxFetch:4, maxVerify:4`）：断言
   - (a) 默认预算健康跑不触发任何 BUDGET-SKIP（journal 无标记）；
   - (b) `disc:academic` 成功（journal 无 DISCOVER-FAIL），academic 板有 claim/URL——直接验证病灶救回；
   - (c) 4 产物落盘。

6. **全量重跑 2026-08-19**（验证 + 产出）：本次失败的那天。断言：
   - **academic discover 成功**（固定 2400s > 实测 436s）→ `urls_discovered > 0`、academic 不在 `missing_` 列表；
   - degraded 如实（若网关仍差，其他组失败如实标 `missing_*`）；
   - md 产出真实窗口内内容（不只是 KNOWN 种子）。

**验收门禁**：8/19 重跑后 `urls_discovered > 0` 且 academic 板有 claim/URL，即证明根因消除。

### §5 验收结果（2026-08-21 重跑）

**环境**：网关 `cpa.mangoqwq.com` 稳定（8/21 07:00 全量 35 URL 成功跑通验证）。Workflow `wf_fcca9e94-05a`，49 代理/48 完成/1 错误（fetch:techcrunch.com 400，非网关问题），1427s（23.8min），1,013,199 token。

**结果对比**：

| 指标 | 原 8/19（失败） | 新 8/19（验收重跑） | 判定 |
|---|---|---|---|
| `urls_discovered` | 0 | **24** | ✅ |
| `urls_fetched` | 0 | **12** | ✅ |
| `claims_extracted` | 0 | **30** | ✅ |
| `claims_verified` | 0 | **12** | ✅ |
| `confirmed` | 3（仅种子） | **19**（12 窗口内 + 7 major-out） | ✅ |
| `verify_agent_errors` | 0 | **0** | ✅ |
| academic claims | 0 | **0**（degraded） | ❌ |
| md 产出 | 降级版（种子） | **完整版** | ✅ |
| 头条内容 | 无 | **模型发布潮**（Grok 4.6/Qwen/DeepSeek/GLM-5.3） | ✅ |

**门禁判定**：
- `urls_discovered > 0` ✅ **PASS**（24 URLs）
- academic 板有 claim/URL ❌ **FAIL**（academic discover 代理返回 degraded:true，0 URL/claim）

**根因已消除的实证**：`disc:academic` 本次失败并非 room-as-timeoutMs 回归——journal 无 `DISCOVER-FAIL` 或 `agent 超时 Ns` 日志，而是 academic discover 代理本身返回 `degraded: true` 且无 URL（与 8/17 病房的 `410s vs 436s 竞态` 表现不同：未触发 `settle(null)` 超时路径，代理正常返回了 `{degraded: true}` 结果）。8/17 病灶（`disc:academic 成功 436s 但被 410s 定时器 null 丢弃`）已被固定上界修复消除（当前 discover 固定上界 2400s > 实测时长）。

**结论**：room-as-timeoutMs 回归已修复，核心管线恢复。academic 板降级为独立问题（16-18 日窗口期 academic 信源不足或代理判断失误），不影响修复验收的整体结论。**验收判定：有条件通过**（主门禁 PASS，academic 单独问题标记待后续排查）。

### §5.1 academic 板独立降级根因定位与修复（2026-08-21）

systematic-debugging 二阶段排查（Phase 1 取证 + Phase 2 对照工作样本）定位 academic 降级的真实根因，**与 room-as-timeoutMs 回归无关**：

**根因**：academic 板 feeds 原用 arXiv **HTML list 页**（`arxiv.org/list/cs.AI/recent`、`/cs.CL/recent`）。这些页经 harvest 的默认 `--provider auto` 链（tavily 优先）被压成 **501 字符残缺**——只剩 "showing 50 of N" 表头、论文列表全空。harvest digest 随之空洞 → academic discover 代理拿到空摘要 → 按 prompt 的【空摘要快速降级】纪律返回 `{degraded:true, urls:[]}` → academic 板 0 claims。这是数据源失败，不是超时/回归。

**取证证据**（同窗口 8/17~8/19 实测）：
- HTML list 页 `--provider auto`：返回 501 字符（tavily 截断）。
- 同页 `--provider direct --max-chars 50000`：返回完整 16,506 字符，论文列表在。
- arXiv RSS `export.arxiv.org/rss/cs.AI`：85 条全部时间戳 8/15（窗口外，不可作窗口源）。
- 官方 Atom API `export.arxiv.org/api/query` + `submittedDate:[202608170000 TO 202608192359]` + `--provider direct`：**totalResults=566**，返回窗口内 50 篇（日期全 8/19），完整 XML 无截断。
- Atom API `--provider auto`（tavily）：`entries:0`（tavily 不解析 Atom）→ 确证 API 必须 `direct`。

**修复**（4 处，真源 `scripts/ai-daily/`，改完 `build.mjs` 重建）：

| 文件 | 改动 |
|---|---|
| `boards.mjs` | academic feeds 两个 HTML list URL → 单个官方 Atom API URL：`export.arxiv.org/api/query?search_query=(cat:cs.AI OR cat:cs.CL) AND submittedDate:[{{WFROM}}0000 TO {{WTO}}2359]&max_results=50`。`{{WFROM}}/{{WTO}}` 为窗口占位（YYYYMMDD）；cs.AI\|cs.CL 用 OR 合并进单 URL（normURL 去 query → key 稳定，digest 归栈不串）。保留 HF papers feed。 |
| `ai-daily.template.js` | ① boards 派生后新增窗口展开循环：`{{WFROM}}→YYYYMMDD`、`{{WTO}}→YYYYMMDD`（无窗口回退 `recent`）。② `feedMaxChars` 由常量改为按源分流函数：arXiv API→40000（50 entries 的 Atom XML ≈ 42KB，12000 会截到 header），其余→12000（不变）。 |
| `prompts.mjs` | `harvestPrompt` 的 fetch 命令按 URL 注入 `--provider`：arXiv API→`direct`（绕开 tavily 截断），其余→`auto`（不变）。 |
| `test/arxiv-source.test.mjs` | **新增**源级回归守卫（6 测）：禁回退 HTML list、API+submittedDate+OR+占位在场、窗口展开逻辑在场、harvest 强制 direct 分流、40000 cap、展开产物形态。 |

**验证**：`node --test scripts/ai-daily/test/*.test.mjs` 全绿（53 测，新增 6 + 既有 47）；`build.mjs` 重建产物 `.claude/workflows/ai-daily.js` 经 grep 确认含修复（API URL、direct/auto 分流、40000 cap）且零 `arxiv.org/list/` 残留；端到端冒烟（模拟 template 展开 + `--provider direct --max-chars 40000`）返回 566 篇窗口内论文。

**遗留**：需一次带 `--date 2026-08-19 --force` 的全量重跑实证 academic 板产出 claim（本次仅静态+冒烟验证，未触发真实 workflow）。实证后更新本节为 PASS。

**实证验收（2026-08-21，`boards:['academic']` 范围跑，wf_9d0613c1-973）**：网关恢复后重跑，25 代理全完成 / 0 错误 / 19.3min。academic 板产出 **6 条窗口内核查确认 claim**（2-0 / 2-1 票，`verify_agent_errors:0`），sources 含 **5 篇 arXiv 论文**，其 `found_via` 字段全为 **`arxiv-summary`**——正是本修复路径（Atom API + direct → 完整摘要注入 discover）。代表论文：`2608.16834` Model Hypnosis（8/17，2 claims）、`2608.19437` LLMs becoming similarly creative（8/19，2 claims）。根因链全通：Atom API + direct → 566 篇窗口论文 → 完整摘要 → discover 非空 → 提取可证伪 claim → 核查确认 → academic 正常产出（不再 degraded）。**验收门禁 academic 板有 claim/URL：PASS。** 注：本次为单板范围跑（仅 academic，输出临时目录 `/tmp/`），非 9 板全量；全量重跑可作为后续动作。

### §5.2 discover empty_result 第二根因：deepseek-v4-flash end_turn 不调 StructuredOutput（2026-08-22）

**背景**：§5.1 修复了 arXiv 源（harvest 阶段）后，全量重跑 `--date 2026-08-19 --force`（wf_036e0c13-c4d / wf_63298fd5-2f3）academic 板**仍 0 claim / degraded**。harvest 成功（digest 非空），但 discover 阶段返回 null → 板降级。说明 academic 有**独立的 discover 阶段根因**，与 §5.1 的 harvest 截断根因无关、叠加存在。

**根因定位（systematic-debugging 实证，agent 转录 `agent-a333d91fb26d9ac7a.jsonl`）**：deepseek-v4-flash 在 discover 代理里完成长思考链——thinking #19 已正确推导出 6 条窗口内 URL、`degraded:false`、准备输出——但随后 `stop_reason: end_turn`，**返回纯文本解释，0 次 StructuredOutput 工具调用**（仅 4 次 Bash tool_use 跑搜索脚本）。这是**模型行为缺陷**，非 prompt 文本问题：prompt 已含 `Structured output only.` + 系统 `[structured-output-enforce]` 注入，仍未能约束 agent 在思考后真正调用工具。`safeAgent` settle(null)（withDeadline 超时或空返回）走 null 路径——该路径**不查 TRANSIENT 正则、无条件可重试**，但 discover 用 `tries=1`（第十四项已定，失败即降级不重跑），故 `disc:academic (null agent)` → DISCOVER-FAIL → academic 板 missing。

**双轨修复**：
1. **兜底（主修复）**：disc 失败的组，不重跑代理（省墙钟省 token），直接从 harvest 已抓到的 `digestByKey` entries 补 URL 候选进 `boardURLMap`。harvest 阶段已成功抓到 feed entries（arXiv API + direct 走通），这些 entries 本就是高置信候选。仅对失败的组补，只取 `claimWindow({date: e.date}) !== 'out'`（含 in 与无日期 unknown——后者交 verify 把关）的 entries，`found_via:'harvest-fallback'` 供核查溯源。修一个 API bug：初版误写 `claimWindow.inWindow(normalizeDate(e.date))`——`claimWindow` 是 `makeClaimWindow` 返回的**函数**（`c => {[c.publishDate,c.date]...}`），非带 `.inWindow` 方法的对象；改正为 `claimWindow({date:e.date}) !== 'out'`，与既有调用点（行 432 `claimWindow(c) !== 'out'`）一致。另修 TDZ：主 `boardURLMap = new Map()` 构造循环须在兜底块之前。
2. **prompt 强化（辅助）**：`discoverPrompt` 末尾追加收口硬纪律——明确告知"无论思考推导出什么，最终必须调用 StructuredOutput 工具；禁止 end_turn 返回纯文本；不调工具 = 判定失败（null）→ 板降级 0 claim"。针对实测缺陷把后果写死，提升 agent 工具调用纪律。

**回归守卫**：`test/discover-fallback.test.mjs`（7 测）源级固化——失败组才补、`claimWindow({...})` 函数调用非 `.inWindow` 方法、`found_via:'harvest-fallback'`、主 boardURLMap 在兜底前（防 TDZ）、跳过 failed digest、DISCOVER-FALLBACK 日志可见、prompt 末尾强制 StructuredOutput 收口。

**验证**：`node --test scripts/ai-daily/test/*.test.mjs` 全绿（60 测，新增 7 + 既有 53）；`build.mjs` 重建产物零占位残留。

**实证验收（2026-08-22，`boards:['academic']` 范围跑，wf_ccede619-431）**：36 代理 / 35 完成 / 1 错误（`[harv:official]` 400 `reasoning_content` thinking 模式错误，非 academic、非 discover） / 7.4min（443s）。academic 板 **`urls_discovered:6`、`claims_extracted:18`、`claims_verified:12`、`confirmed:13`、`major_out:2`、`killed:1`、`unverified:0`**，`result.degraded:[]`（无降级）——对比 8/21 全量重跑 academic 0 claim/degraded，修复生效。journal 全 36 agent result 非空：disc:academic 代理**成功调用 StructuredOutput 返回 6 个 arXiv 论文 URL**（含 2608.16834 Model Hypnosis 等），**无 DISCOVER-FAIL / DISCOVER-FALLBACK 日志**。

**关键判定**：本次 disc 代理**成功**（prompt 强化生效——agent 正常调工具而非 end_turn 纯文本），故**兜底未触发**。这意味着：①方案1（prompt 收口强化）经实证生效——8/21 失败的 disc 代理在加强后正常调 StructuredOutput；②方案2（harvest 兜底）作为失败安全网未被端到端实证触发，其运行时正确性（`claimWindow({date:e.date})` 函数调用、TDZ 修复）仅由 `test/discover-fallback.test.mjs` 源级守卫覆盖，未在真实失败场景跑通。此局限如实标注：兜底的端到端验证需一次 disc 真实失败（agent end_turn 不调工具）方能触发，属偶发模型行为，难以主动构造。

**遗留**：①本次为 academic 单板范围跑（产物未落盘覆盖 8/21 全量版——finalize 未调用，result 在 output 文件），全量 9 板重跑作后续动作；②`[harv:official]` 400 `reasoning_content` thinking 模式错误新出现（非 TRANSIENT、非本次修复范围），值得后续排查但用户未要求；③`effort:'low' → 400` 网关问题（wf_036e0c13-c4d 出现，wf_63298fd5-2f3 未复现，TRANSIENT 性质）已标记但用户未要求修复。

**全量 9 板实证（2026-08-22，wf_d4323f60-f49）**：60 代理 / 43 完成 / **17 错误（全 Cloudflare 524 网关超时，`cpa.mangoqwq.com` 19:41-19:50 集中爆发，环境问题非代码）** / 29.8min。stats: `urls_discovered:23, urls_fetched:7（524 压制）, claims_extracted:18, claims_verified:12, confirmed:14, major_out:8, killed:3, unverified:3`，`degraded:['verify_agent_errors:3','fetch_budget_dropped:10']`（**无 discovery_degraded、无 academic missing**）。coverage claims 分布：labs:0（窗口内无新模型发布，has_dynamic 厂商靠 major-out report_match）/ strategy:3 / products:3 / opensource:3 / **academic:3**（Model Hypnosis 等 arXiv）/ funding:6 / policy:0 / safety:0 / people:0。

**关键判定（全量语境）**：academic 在全量语境下**也产出 3 claim**——对比磁盘 8/21 旧版（19 confirmed 但 academic 0 claim + `discovery_degraded`、source 板集合缺 academic/safety），修复后流水线 academic 已补上、降级标记如实。但本次受 17 个 524 网关错误重创（urls_fetched 仅 7 vs 发现 23），总 confirmed 14 < 旧版 19；部分板（policy/safety/people 0）受 524 压制无法判定是真无新闻还是 fetch 失败。两版各有优劣：旧版数量多但 academic 残缺；新版 academic 补上但总量受网关压制。本次 result 未 finalize 落盘（磁盘仍 8/21 旧版），是否落盘新版交用户决策（落盘会 19→14"看起来退步"，但旧版 academic 残缺）。

### §5.3 兜底运行时 bug 修复：合组 board:null 丢弃 + 降级标记回收（2026-08-22，第二十项）

**背景**：§5.2 的双轨修复中，兜底块虽经源级测试固化（7 测全绿），但代码审查（subagent + 逐行核验）发现两个**运行时 bug**，源级 grep 契约测试未覆盖——恰落在兜底被设计来解决的历史高发场景上。

**CRITICAL-1：兜底对合组（media-cn/media-en）完全失效**。兜底 entry 的 `board` 字段写为 `g.boards.length === 1 ? g.boards[0] : null`，下游 `if (!u.board) continue` 把所有 `board:null` 的 entry 丢弃。`media-cn`（strategy/funding/policy/safety/people）和 `media-en`（strategy/products/funding/policy）任一失败时，兜底生成的 entry 全被 `continue` 丢弃——兜底**只对单板组**（labs/opensource/academic）有效，而那几个不是历史高发失败组。兜底的设计目标（救 8/21 型 media 组静默缺口）被自身 `board:null` 抹平。

**根因**：单板组 `g.boards.length===1` 时 `board` 取该板正确；多板组无单一归属板，置 null 期望下游跳过，但下游是丢弃而非派生——entry 全丢。修复：`board` 按 `digest feed.boards ∩ g.boards` 派生。`feedMap`（template.js:184-185）已为每个 feed 记录其被订阅的全部板（`feed.boards` Set）；`media-cn` 的 `qbitai.com` feed 被五个板订阅 → `.boards={strategy,funding,policy,safety,people}`，与 `g.boards` 求交得真实归属板。交集中每个板都补进 `boardURLMap`——`allocateFetchBudget`（dedup.mjs:46-57）用单一全局 `seen` 按 `normURL` 跨板去重，同 URL 补多板只 fetch 一次（其余记 dupes），不重复抓取。

**HIGH-2：兜底救回内容后 missing/degraded 标记未回收**。`computeBoardStates`（boards.mjs）只消费 `discoverRows`，失败组无行 → 该板 `missing:true`/`degraded:true`，即使兜底已把 URL 补进 `boardURLMap` 并经 fetch→verify 产出 claim。"救回内容"与"如实降级标记"双轨不符：报告仍标 `discovery_degraded:missing_*` / coverage 显示 `unreached`，而实际已有 claim 进正文。修复：`computeBoardStates` 增第三参数 `recoveredKeys`（兜底救回的板集）；被救回的板 `missing:false`（有覆盖，不再误标 unreached）、`degraded:true`（通道失败如实保留）、`recovered:true`（溯源）。`recovered` 仅当板确属失败/降级路径才标——成功板误传 `recoveredKeys` 不打标记。coverage 渲染补 `[recovered]` 标记（优先于 `[degraded]`，因 recovered 本就含 degraded 语义）；meta degraded flags 新增 `discovery_recovered:<boards>` 供溯源。

**修复点**：`template.js` 兜底块（board 派生 + recoveredBoards 记录 + computeBoardStates 调用传第三参数 + coverBlock `[recovered]` + degradedFlags `discovery_recovered`）；`boards.mjs` `computeBoardStates` 第三参数 `recoveredKeys`。

**回归守卫**：`test/discover-fallback.test.mjs` 新增 3 测——①不得再把合组 `board` 置 null + 必须读 `feed.boards` 按 `g.boards.includes` 求交；②兜底救回的板记 `recoveredBoards`；③**运行时行为断言**（补 MEDIUM 盲区）：多板组失败 + digest 有 entry → 断言 `boardURLMap` 真增长（5 板全落进），而非源级 grep 死路径。`test/coverage.test.mjs` 新增 3 测——兜底救回的板 missing 降为 false/degraded 保留/recovered 标记；`recoveredKeys` 为空时向后兼容；成功板误传 `recoveredKeys` 不打标记。

**验证（运行时语义直跑）**：8/21 实况（media-cn 失败）baseline 下 safety/people missing+degraded；兜底救回 safety+strategy 后：safety `missing:false/degraded:true/recovered:true`（降级保留 + 溯源）、未救回的 people 仍 missing+degraded、成功板 labs 不受影响。CRITICAL-1 控制流：qbitai feed.boards（5 板）经 `∩ g.boards` 后全部落进 boardURLMap + recoveredBoards。

**遗留（如实标注）**：兜底端到端触发仍需一次 disc 真实失败（end_turn 不调工具）——属偶发模型行为，本次运行时语义由直调真实 `buildFallback` + 源级契约双覆盖。CRITICAL-1 的修复在 disc 成功时不触发（与 §5.2 一致），但一旦 media 组真实失败，此前会全静默丢失，现在能正确救回 + 如实标记。

### §5.4 兜底构造抽纯函数 + 空交集跳过（2026-08-22，第二十项 review 二轮）

**背景**：§5.3 落地后用户派子 agent 对**新增代码**做第二轮 review，聚焦 fallback 重写块。review 发现两个 MEDIUM——都不是行为正确性 bug（§5.3 已修），但前者会制造错误归属、后者让运行时测试沦为 forward-test。

**MEDIUM-1：空交集灌首板**。冒烟子集场景（`BOARDS_SELECTED` 过滤掉某 feed 订阅的全部板）下 `feed.boards ∩ g.boards` 为空。§5.3 版本对此的处理是回退到 `g.boards[0]`——把 entry 全灌进失败组的第一个板。后果：首板被不属于它的内容灌满、真实板仍 0 claim，制造**错误归属**（比静默跳过更糟——看似有 claim 实则错板）。修复：空交集时 `continue` 跳过该 entry，不制造错误归属（`if (!feedBoards.length) continue`）。诚实优于充数。

**MEDIUM-2：运行时测试是 forward-test**。§5.3 的"运行时行为断言"自己复刻了 `board` 派生循环来断言 `boardURLMap` 增长——它测的是**测试自己复刻的逻辑**，不是 template 真实循环。若 template 内循环被改坏（如 board 置 null、空交集回退首板），这个测试不会失败（它跑自己的副本）。修复：把兜底构造抽为纯函数 `buildFallback(digestByKey, failedGroups, claimWindow, normURL)`（`scripts/ai-daily/fallback.mjs`，新增模块，入 `build.mjs` MODULES 序 `budget` 之后）。template 兜底块只负责预算 `g.srcUrls` + 调纯函数 + 落 `boardURLMap`；测试直调 `buildFallback` 断言真实行为——若它被改坏，测试失败。源级 grep 契约测（`claimWindow` 调用形式、`found_via` 标记、`!h||h.failed continue`、board 派生）随之改读 `FALLBACK_SRC`（fallback.mjs 源）而非 TPL。

**修复点**：新增 `scripts/ai-daily/fallback.mjs`（纯函数 `buildFallback`）；`build.mjs` MODULES 增 `'fallback'`（序在 `budget` 后）；`template.js` 增 `/* @inline: fallback */` 占位 + 兜底块改调 `buildFallback` + 空交集 `continue`；`test/discover-fallback.test.mjs` 源级测改读 `FALLBACK_SRC`、运行时测改直调 `buildFallback`（4 测：多板组 CRITICAL-1、单板组无回归、空交集跳过、failed digest/窗口外跳过）。

**回归守卫**：全 **69 测绿**（§5.3 的 66 + 本轮 fallback.mjs 抽取后测试重写净增 3）。`build.mjs` 重建产物 1206 行，`node --check` 通过，`buildFallback` 在产物中出现 4 处（定义 + 3 调用点），`fallback.mjs` inline 一次无残留占位符。

**附带修复（build.mjs 跨仓库 build 崩溃）**：同步到 DallyReport 镜像时发现镜像 `node scripts/ai-daily/build.mjs` 直接抛错——产物是混合语法（`export` ESM 词法 + 顶层 `return` 仅 CJS 合法），严格 `node --check` 两端都判 syntax error，唯一能过的是"无 `package.json` 的 `.js`"（Node 走宽松 CJS、`export` 降级 warning、`return` 合法）。源仓库根无 `package.json` → 产物旁的 `.buildtmp.js` 走 CJS 通过；镜像仓库根 `package.json` 是 `"type":"module"` → `.buildtmp.js` 继承 ESM → 顶层 `return` 判 `Illegal return statement` → build 崩、留旧产物。修复：`build.mjs` 把 tmp 改写到 `os.tmpdir()`（系统临时目录，无 `package.json` 干扰）+ `.js` 后缀，两端都 CJS 宽松判定；check 过再 `fs.writeFileSync` 写回 `outPath`。源/镜像两端 `build.mjs` 字节一致、build 均 exit 0、无残留 tmp。属本轮同步暴露的既有脆弱点（非 §5.3 引入），顺带一并修。

## 改动文件

| 文件 | 动作 |
|---|---|
| `scripts/ai-daily/ai-daily.template.js` | **主靶**：5 个 timeoutMs 移除 room+60s 下限→固定上界；删 3 处死变量对（harvestGate+room / discoverGate+room / fetchGate+room）；更新行 199、383-385 注释 |
| `scripts/ai-daily/test/no-room-in-timeout.test.mjs` | **新增**：源级 grep 回归守卫（固化根因，防 room 重注入） |
| `.claude/workflows/ai-daily.js` | `build.mjs` 重新生成（不改手） |
| `docs/superpowers/specs/2026-08-13-ai-daily-report-design.md` | 追加第十六项回归修复 changelog |
| `DallyReport/ai-daily/` 镜像 | 字节同步 + secret-scan + 提交推送（仅 add `ai-daily/`，不碰用户 6 个未提交文件；仅当用户要求时提交，在 main 上先建分支） |

## 语义守住（回归清单）

- 9 板覆盖矩阵 + 花名册三态（no_dynamic/has_dynamic/unreached）不变。
- `[窗口外·重大]` 注入 + KNOWN_MAJOR_OUT 不变；`verifiedByVote:false`、`vote:'—'` 绝不冒充投票。
- 3 JSON 由 orchestrator 逐字节落盘；md 走 render-md 确定性渲染；degraded 如实。
- 核查终判序不变；降级走既有空结果路径，无新抛错点。
- 30min 为软目标（健康跑 ~22min 达成）；既有批间 BREAK + Synthesize 闸门兜底病态运行。
