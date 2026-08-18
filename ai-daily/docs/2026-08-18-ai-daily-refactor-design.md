# ai-daily 大改设计：headless 修复 + md 去代理化 + workflow 模块化

日期：2026-08-18
状态：已批准（用户四节逐节认可）
前置：2026-08-13-ai-daily-report-design.md（第一~十四项优化）

## 背景与动机

8/18 深度 review 发现四个架构级问题（按严重度）：

- **P0 headless 自动化是断的**：`run-daily.sh` 用 `claude -p` 跑 skill，print 模式后台任务上限 600s；修复后健康全量跑 21-31min 远超此限。8/16、8/17 两次 launchd run 均为 `Background tasks still running after 600s; terminating` → rc=0 假成功退出，workflow 孤儿化、产物永不落盘。每日 08:40 自动跑从未成功产出过。
- **P1 md 走代理写盘是 LLM-throughput 瓶颈**：3 个 JSON 已走对路（payloads → orchestrator 落盘），但 md 仍经 mdWriter 代理（report JSON → prompt → LLM 渲染 → Write 工具）。纯确定性模板工作压在全链路最贵最脆弱环节上（8/18 冒烟 report 代理 600s 超时即撞此）。
- **P2 839 行单文件超荷**：schema(~76行)/花名册+种子(~150行)/日期与URL纯函数(~60行)/指纹去重(~40行)/prompt模板(~180行) 全挤一个文件。`_majorKey` 已攒 3 次 bug 修复（hassabis/jeff-dean 顺序、xAI 前缀、GPT5.6-math 漏指纹）——独立模块+单测下不可能活到第三次。
- **P3 治理逻辑验证靠"跑一遍看日志"**：预算闸门/终判序/轮询公平/指纹去重全是纯逻辑但无离线断言，每次改动靠 21min 端到端冒烟验证，反馈环太贵。

## 目标

1. headless 每日自动跑真正跑通（P0 根除）。
2. md 产出不再受网关波动影响；report 失败时降级 md 成为契约产物而非编排器临时孤儿（P1）。
3. 纯逻辑进 `node:test` 离线断言；workflow 文件认知负荷减半（P2/P3）。

## 目标架构

```
obsidian/
├── .claude/
│   ├── workflows/ai-daily.js          ← build 产物，~450 行编排（只留阶段编排+realm 适配）
│   └── skills/ai-daily/SKILL.md       ← 步骤5：md 也走 payloads 由主会话落盘
├── scripts/ai-daily/                  ← 纯函数模块（真源，可单测）
│   ├── schemas.mjs                    ← 6→5 个 schema（删 WRITE_RESULT_SCHEMA）
│   ├── boards.mjs                     ← BOARDS/OFFICIAL_FEEDS/KNOWN_MAJOR_OUT/LABS_ALIASES/GROUPS_RAW/DISCOVER_GROUPS_ALL
│   ├── date-utils.mjs                 ← pad2/normalizeDate/normURL/hostOf/chunkArr + makeClaimWindow(WIN_FROM,WIN_TO)
│   ├── dedup.mjs                      ← majorKey/makeAddMajor/allocateFetchBudget
│   ├── budget.mjs                     ← computePhaseDeadlines/makeBudgetGate(deadlines, elapsedFn, onSkip)
│   ├── prompts.mjs                    ← harvestPrompt/discoverPrompt/fetchPrompt/verifyPrompt/reportPrompt（ctx 显式注入）
│   ├── render-md.mjs                  ← renderMarkdown + renderDegradedMarkdown（mdWriter 替代）
│   ├── build.mjs                      ← 模板+占位符 inline → workflow 产物，node --check 护栏
│   └── test/                          ← node:test（date-utils/dedup/budget/render-md）
└── docs/superpowers/specs/2026-08-18-ai-daily-refactor-design.md

/Users/mango/.ai-daily/run-daily.sh    ← headless 修复 + artifact 摘要落 log
DallyReport/ai-daily/                  ← 镜像（含 scripts/，byte-identical）
```

## 关键架构决策

### ① workflow realm 不能 import → 模块真源 + build inline

workflow 脚本是自包含单文件（realm 内无 fs/无模块解析）。模块化形态：`scripts/ai-daily/*.mjs` 为 single source of truth；`build.mjs` 把模块函数体（剥 export）替换 `ai-daily.template.js` 中 `/* @inline: <mod> */` 占位符，生成 `.claude/workflows/ai-daily.js`。测试对模块跑（node 环境正常 import），workflow 用构建产物。这是唯一既让逻辑进 node:test、又不破坏 workflow 自包含约束的形态。

### ② md 渲染彻底去代理化

report 代理保留（去重/分组/摘要/头条选择需 LLM 判断）；mdWriter 代理删除。report JSON + meta → `render-md.mjs` 确定性拼接 → `payloads.md` → orchestrator 落盘。

## 模块契约

### schemas.mjs（纯数据，零风险）
`DISCOVER/HARVEST/EXTRACT/VERDICT/REPORT_SCHEMA` 与现行逐字节相同；`WRITE_RESULT_SCHEMA` 删除（无 writer 代理）。

### boards.mjs（纯数据，零风险）
`BOARDS/OFFICIAL_FEEDS/KNOWN_MAJOR_OUT/LABS_ALIASES/GROUPS_RAW/DISCOVER_GROUPS_ALL` 逐字节搬移。以后加厂商只改此文件。

### date-utils.mjs（纯函数）
`pad2/normalizeDate/normURL/hostOf/chunkArr` 签名不变。`claimWindow` 闭包依赖全局 `WIN_FROM/WIN_TO` → 改工厂 `makeClaimWindow(WIN_FROM, WIN_TO)` 显式注入（唯一签名变化）。

### dedup.mjs（三个历史 bug 固化地）
- `majorKey(name)`：指纹顺序锁定 deepseek-v4 → harness → grok-4.6 → muse-glimmer → **hassabis → jeff-dean** → gemini → gpt5.6-math → 兜底。hassabis 必须在 jeff-dean 前（8/16 bug）。测试固化三用例：
  1. "Hassabis plans departure alongside Jeff Dean" → `hassabis`
  2. "xAI：Grok 4.6：Frontier-model release…" → `grok-4.6`（全 claim 命中，非 split 首段）
  3. "GPT-5.6 与 Fable 联手攻克…数学难题" → `gpt5.6-math`
- `makeAddMajor(majorOutClaims)` → `_addMajor(m, board)`：指纹去重、日期更具体者覆盖、全 claim 与首段各测一次。
- `allocateFetchBudget(boardURLMap, MAX_FETCH)` → `{ fetchTargets, dupes, budgetDropped }`：轮询公平（每轮每板至多 1 个）。测试断言 labs 占 80% URL 时 policy/safety/people 仍有名额。

### budget.mjs（第十四项语义可测试化）
- `computePhaseDeadlines({harvest,discover,fetch,verify,verifyInflightBuffer,totalLimit})` → 累计相加、Verify 减 buffer、Synthesize=totalLimit。测试断言 8/9/8/5+60s+30min → 死线 8/17/25/29/30min。
- `makeBudgetGate(deadlines, elapsedFn, onSkip)` → `budgetGate(stage)`。`elapsedFn` 注入时钟（workflow 里 `_wallMs` 累加器，测试里 mock）——realm 时钟限制的正确解耦点，模块不碰 setTimeout。

### prompts.mjs（纯模板，低风险需仔细）
5 个 prompt 闭包依赖（WINDOW_LABEL/WFROM/WTO/DATE/GROK_DIR/MAX_URLS_PER_BOARD/WEB_BUDGET_*）收敛为 `ctx` 显式传入。**字符串输出逐字节不变**（build 产物语义 diff 断言）。

### render-md.mjs（全新）
- `renderMarkdown({report, meta, coverage, windowMisses, degraded})` → markdown 字符串。输入即现行 mdWriter prompt 里 reportJson 同构数据。格式锁定现行 md 契约：
  ```
  # 🤖 AI 日报 · <DATE>
  > 覆盖 <window> 窗口…
  ## 📌 今日一句话 / ## 📄 执行摘要
  ### <每 board>：**标题**（[核查状态] 可信度）— 要点 — *来源*
  ## ⚠️ 待核实 / ## ⚠️ 未验证与局限 / ## 📎 窗口外参考 / ## ❓ 开放问题 / ## ✅ 覆盖自检
  ```
- `renderDegradedMarkdown({meta, confirmed, coverage, windowMisses, degraded})` → 降级版（冒烟 compose 脚本正式化）。
- 测试快照 4 形态：全确认/含 refuted/含 major-out/report 缺失降级版。以 8/17 正式 md 为金样本。

## md 数据流（新）

```
workflow 内:
  report = safeAgent(REPORT_PROMPT, ..., tries=1)          ← 保留
  md = report ? renderMarkdown(...) : renderDegradedMarkdown(...)
  return { ..., payloads: { claims, sources, meta, md } }

orchestrator 主会话（SKILL.md 步骤5 改）:
  4 产物全部主会话 Write 逐字节落盘（3 JSON + md）
```

- report 成功 → md 必然成功（纯字符串拼接），md 产出不再受网关波动影响。
- `md_written` 语义改为"report 是否成功"（1=完整版 md，0=降级版）。
- `write_failed:md` degraded 形态从机制上消失；report 失败改标 `report_failed`。

## headless 修复（run-daily.sh）

```diff
+ export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0   # 后台 workflow 不限 600s，等真完成
  claude -p "..." --model deepseek-v4-flash --dangerously-skip-permissions
```

完成时 artifact 摘要落 log（观测性）：
```sh
for f in "docs/daily/${TODAY}".*.json; do
  echo "  artifact: $f ($(wc -c < "$f" 2>/dev/null) bytes)" >> "$LOG"
done
# meta.json 存在则抽 degraded/confirmed/killed 一行摘要
```

`com.mango.ai-daily.plist` 不动（08:40 调度正确）。8/18 冒烟产物（4 文件）删除——不再阻塞 skip。

## build/test 管线

**build.mjs**（~50 行）：读 template + 各模块 → 剥 export inline → 输出 workflow。护栏：build 后 `node --check` 产物 + `node --test` 全绿才算构建成功；失败不出产物、不碰线上 workflow。

**测试**（node:test 零依赖，~150 行）：

| 文件 | 断言数 | 覆盖 |
|---|---|---|
| date-utils | ~12 | normalizeDate 全格式、窗口门 in/out/unknown、跨年边界 |
| dedup | ~10 | 三历史指纹 bug + 轮询公平分配 |
| budget | ~6 | 死线累加、Verify 缓冲、越线不重复 push |
| render-md | ~8 | 4 形态快照 + 核查状态标注 + major-out `—` 不冒充 |

**workflow 体积**：839 行 → 模板 ~450 行编排 + 模块 ~600 行可测纯逻辑。

## 语义不变式（测试护栏）

1. 9 板覆盖矩阵 + 花名册三态（no_dynamic/has_dynamic/unreached）不变
2. 核查终判序（双否 kill / 双过存活 / 分歧补 1 票）不变
3. `[窗口外·重大]` 注入 + `verifiedByVote:false`、`vote:'—'` 不冒充投票不变
4. 预算死线数学（切片累加、Verify 减 60s 缓冲、逐波重算）不变
5. 3 JSON orchestrator 逐字节落盘不变；md 改由 `payloads.md` 落盘

## 错误处理矩阵

| 失败点 | 新架构行为 | 变化 |
|---|---|---|
| harvest/discover/fetch/票失败 | 不变（既有降级路径） | — |
| 阶段超墙钟 | 不变（budget.mjs 有测试） | — |
| 网关探针失败 | 不变（SYNTH-SKIP → raw archive） | — |
| report 代理失败 | renderDegradedMarkdown 确定性产出降级 md 仍落盘，degraded 标 `report_failed` | ✅ 契约化 |
| mdWriter 代理失败 | 失败点消失（无此代理） | ✅ 根除 |
| headless 600s 截断 | CEILING_MS=0 等真完成 + log 摘要 | ✅ 修复 |
| build 产物与模块漂移 | 唯一新失败点；build 护栏（node --check + test）不出坏产物 | 🆕 有护栏 |

## 风险与回退

| 风险 | 概率 | 缓解 |
|---|---|---|
| prompt 字符串漂移（模板拼接差空格） | 中 | 语义 diff 脚本逐字节断言；漂移则 build 失败不出产物 |
| render-md 与历史 md 格式不一致 | 低 | 8/17 正式 md 金样本快照测试 |
| build 增加日常改动摩擦 | 低 | 一条命令；SKILL.md 注明改模块后必须 build |
| 大改落地失败破坏线上 | 低 | 现行 839 行版 git 已提交（a5ba706），单点回退 `git checkout`；验收门禁全过才替换 |

**回退策略**：`.claude/workflows/ai-daily.js` 恢复 a5ba706 + SKILL.md 步骤5 单独 revert。scripts/ 新增目录不影响现行 workflow。

## 验收门禁（实施时逐条过）

1. `node --test` 全绿
2. build 产物 `node --check` 通过
3. build 产物 vs 现行 839 行版语义 diff——prompt 字符串/常量/schema 逐字节一致（脚本化断言）
4. 单板冒烟（boards [labs,strategy], maxFetch/Verify 4）——行为与 8/18 基线一致 + md 由 payloads 落盘（不再 write_failed）
5. 删 8/18 冒烟产物；三镜像同步 + secret-scan + 推送

## 明确不做（YAGNI）

- report 代理确定性化（合成需 LLM 判断，保留）
- discover/fetch 并发模型重构（3/6 批次已实测调优）
- plist 调度变更（08:40 正确）

## 实施顺序

1. scripts/ai-daily/ 六模块 + 四测试（纯新增不碰线上）
2. node --test 全绿
3. build.mjs + 语义 diff 护栏，生成候选产物
4. 候选产物验收 → 替换 workflow
5. SKILL.md 步骤5 改 md 落盘语义
6. run-daily.sh headless 修复 + 观测性
7. 单板冒烟（对照 8/18 基线）
8. 删冒烟产物；changelog；镜像同步 + secret-scan + 推送

---

## 实施记录（changelog，2026-08-18）

### 已落地

- **scripts/ai-daily/ 7 模块 + 4 测试**：date-utils（makeClaimWindow 工厂）/ schemas（WRITE_RESULT_SCHEMA 删）/ boards / dedup（majorKey+makeAddMajor+allocateFetchBudget）/ budget（computePhaseDeadlines+makeBudgetGate）/ prompts（ctx 注入）/ render-md。`node --test 'scripts/ai-daily/test/*.test.mjs'` 30/30 全绿。
- **build.mjs**：`/* @inline: <mod> */` 占位符替换 + `node --check` + 占位符零残留断言。临时文件用 `.js` 后缀（本仓库无 type:module，走 CJS 判定顶层 return/export 合法，`.mjs` 强 ESM 会报 Illegal return）。
- **workflow 替换**：`.claude/workflows/ai-daily.js` 998→1002 行（inline 模块 + 编排骨架）。语义 diff 5/5 prompt 字符串字面量逐字节一致 + 常数/schema 全一致 + mdWriter/WRITE_RESULT_SCHEMA 零活动代码。可重复 build（shasum 一致）。
- **SKILL.md 步骤5**：4 产物全部 orchestrator 从 `payloads.{claims,sources,meta,md}` 落盘；md 不再经代理。
- **run-daily.sh**：`export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`（P0 headless 修复）+ 完成时 ARTIFACT-OK/ARTIFACT-FAIL 摘要落 log。
- **冒烟产物**：8/18 四件已删（设计授权）。

### 实施中发现的 bug（已修）

- **boards TDZ**：模板最初在 `BOARDS_SELECTED` 后、inline BOARDS 前放 `const boards = BOARDS_SELECTED ? BOARDS.filter(...) : BOARDS` → 产物在 BOARDS 声明前访问 BOARDS → ReferenceError（首跑 21ms 即挂）。修复：改放到 inline 区后、`impRank` 前（BOARDS 已就绪）。

### 冒烟实测（8/18，boards [labs,strategy]，maxFetch/Verify 4，run wzvmrbpk5）

**8 代理 / 216,958 token / 27.1min（1 628 534ms）/ 3 代理报错（全部 attempt:1，Connection closed mid-response）——网关差窗口**。与 8/17 同类（`cpa.mangoqwq.com` 不稳），本轮同样撞上：disc:media-cn / harv:en-media / harv:cn-media 三个代理 API 断连。**代码层面验收通过**——重点验证 8/18 大改的 md 确定性渲染路径在降级分支下正确工作：

- **md 由 payloads 落盘（硬指标）**：report 代理失败（A 型首调用挂起，journal 显示 `state:"start"` 无结果行）→ `report_error:'report agent failed; reverting to raw archive'` → `renderDegradedMarkdown` 确定性产出降级合成版 md → orchestrator 从 `payloads.md` 逐字节落盘。**不再有 mdWriter 代理、无 write_failed、artifacts_failed:[]**。
- **degraded 如实**：`discovery_degraded:missing_strategy+products+opensource+funding+policy+safety+people`（strategy 由 media-cn/media-en 覆盖、两 disc 代理一死一空 → 7 板降级）＋`budget_skipped:Fetch`（阶段预算闸门在 Fetch 触发，预算把 last in-flight 拒掉——预算纪律生效，未拖满）。KNOWN_MAJOR_OUT 种子注入 3 条（DeepSeek V4 / Grok 4.6 / DeepSeek Harness，`vote:'—'`/`verifiedByVote:false`）。
- **墙钟受控**：27.1min < 30min 总闸门，未重试死路（各失败代理均 attempt:1）。
- **发现并修复契约缺口（report_failed）**：refactor 契约第 107/156 行——"report 代理失败 → degraded 标 `report_failed`"。本轮冒烟 meta 的 degraded **缺** `report_failed`（只有 discovery_degraded + budget_skipped，报告失败仅经 `report_error` 字段反映）。已修：模板在 `const reportErr = ...` 后加 `if (reportErr) degradedFlags.push('report_failed')`，重建产物（1003 行），`node --check` + 30/30 测试全绿。（本轮冒烟产物是修复前跑出的，故其 meta 不含 `report_failed` —— 修复本身以模板/产物/镜像一致 + 测试验证。）

**验收结论**：代码层面全面通过——md 确定性渲染（完整/降级双路径）、payloads 落盘、degraded 契约化、阶段预算硬停、tries=1 失败即降级，全部按设计工作。网关失败是环境问题（8/17 同类实证），非代码缺陷。
