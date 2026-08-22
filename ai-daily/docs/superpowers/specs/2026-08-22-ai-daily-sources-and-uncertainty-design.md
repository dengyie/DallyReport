# ai-daily 完整版日报三契约缺口修复设计

> **For agentic workers:** 实现按 SDD 派子 agent，TDD（红→绿→重构），改完跑全测 + rebuild + 双端同步 + commit/push。本 spec 已用户批准三层全修、A+C 兜底、直接派 agent 实现（跳过 plan 步骤）。

## Context（为什么改）

2026-08-22 重跑 8/21 日报，对照用户另一生成器产出的 `AI.md`（位于 iCloud `Note/AI/DallyReport/2026-08-21/AI.md`），发现完整版日报有三个层面的缺口。用 8/21 已落盘 JSON 重建的降级版反而比完整版更接近 AI.md（有 `[n]` 角标 + 参考来源节，因降级版 source 是真 URL）。

系统排查定位三层根因：

**层 1（运行时，本次 md 缺角标的直接原因）**：风格优化（spec 2026-08-22-ai-daily-report-style-design.md 的 citation 角标逻辑）改动**从未 commit 到 obsidian 源仓库**——只在 working tree。`.claude/workflows/ai-daily.js` 是 git 追踪文件，HEAD 版**无 buildCitationMap**（已验证 grep 0）。run 启动时 workflow 文件处于旧版（无 citation），产出 0 角标 md。当前 working tree 文件已重新 build 含 citation，但源仓库 HEAD 仍是旧版。根因是**部署纪律缺失**：源端改动未提交、build 产物未提交。

**层 2（设计层，major-out 项结构性无 URL）**：`_mkMajor`（dedup.mjs:22）把 sourceUrl 硬编码为 `(多源公认)`。major-out 项来源两条：①KNOWN_MAJOR_OUT 种子（boards.mjs:52-55，字段 `name/date/note`，**无 url**）；②discover 代理上报的 `majorOutOfWindow`（schemas.mjs:14，required `name/date/note`，**无 url 字段**）。即使 citation 逻辑生效，这些项也永远挂不上 `[n]`（buildCitationMap 跳过非 URL）。而 AI.md 每条都有 `[n]` 溯源。

**层 3（措辞，未核查项不诚实）**：Astra 条（`verifiedByVote:false` / `status:'[窗口外·重大]'`）写"宣称已解决 10 道数学难题"带肯定倾向 + "预告药"错字。reportPrompt §4.5 已有不确定度要求，但**未区分未核查项与已核查项**——对未核查项没强制措辞约束，deepseek-v4-flash 没守住。AI.md 通篇"有用户称/暂不能确认"，对未确认事项不假装确定。

**目标**：三层全修——层 1 部署纪律（防 run 用旧版）、层 2 major-out 可溯源（A+C 兜底）、层 3 未核查项措辞诚实（prompt 硬约束 + render 机器徽标双保险）。**不改核查终判序、不改 9 板矩阵、不改 3 JSON 落盘语义**——纯渲染/合成/数据契约层。

## 不在范围（边界）

- **不刷新 KNOWN_MAJOR_OUT 种子内容**（不增删种子项，那是独立人工动作，见 [[ai-daily-age-gate-seed-refresh]]）——本次只给现有 2 条种子**加 url 字段**。
- **错字不纳入**（"预告药"是 deepseek-v4-flash 生成质量问题，render 层不能改写 summary，prompt 管不了错字）——靠代理质量 + 后续观察，若高频再考虑后处理。
- 不改核查终判序、不改 9 板覆盖矩阵、不改 3 JSON 落盘语义（md 内容变、payloads 字段结构不变）。
- 不动 DallyReport 镜像的 6 个用户未提交文件（README.md/logs/launchd.out.log/package.json/src/blog-draft.mjs/src/export-blog-draft.mjs/test/blog-draft.test.mjs）。
- 已核查项的 sources 不动（report 代理已能输出 URL，8/21 实测 4 条已核查项 sources 均为真 URL）。

## 关键数据契约（基于调研事实，非臆测）

- **report 产物字段**（prompts.mjs:86）：`{ sections:[{board,title,items:[{title,summary,confidence,sources,vote,status}]}], oneLiner, execSummary, caveats, openQuestions }`。
- **item.sources**（schemas.mjs:65）：`{ type:'array', items:{type:'string'} }`——只约束 string，不验证 URL 格式。reportPrompt:81 要求"1-2 个 URL"。已核查项实测为真 URL，major-out 项为文字描述。
- **item.status**：`已核查 2-0` / `已核查 2-1` / `[窗口外·重大]` / `未核查` / `已否决`。
- **major-out claim 构造**（dedup.mjs:21-26）：`sourceUrl:'(多源公认)', sourceTitle:'行业客观公认事实', isMajorOut:true, vote:'—', verifiedByVote:false`。
- **KNOWN_MAJOR_OUT 种子**（boards.mjs:52-55）：`[{name,date,note}]`，当前 2 条（Astra 2026-08-02、DeepSeek V4-Pro 2026-08-13）。
- **discover majorOutOfWindow**（schemas.mjs:14）：required `name/date/note`，无 url。
- **buildCitationMap**（render-md.mjs:14-31）：遍历 items 的 sources，`new URL(s)` 成功才编号，非 URL 跳过（catch continue）。返回 `{map:Map<url,n>, list:[{n,url,title}]}`。
- **citationBadges**（render-md.mjs:35-46）：sources 里能 `new URL()` 且在 map 里的才产 `[n]`，否则跳过。
- **itemBlock**（render-md.mjs:48-57）：`tag`（status 徽标）挂标题后；`badges`（citationBadges）拼进 summary 末尾；`conf`（可信度）拼进 summary 末尾换行后。

## 设计

### A. 层 1 — 部署纪律（防 run 用旧 workflow 产物）

**问题**：风格优化改动只在 working tree，`.claude/workflows/ai-daily.js` HEAD 版无 citation，run 用旧版产出无角标 md。

**修复**：

1. **源端提交**：把 working tree 的风格优化改动（render-md.mjs/prompts.mjs/ai-daily.template.js/test/fallback.mjs 等）commit 到 obsidian 源仓库。这是漏掉的根本动作。
2. **build 产物纳入提交**：`.claude/workflows/ai-daily.js` 是 git 追踪文件，commit 最新 build 产物（含 citation）。run 前文件即正确，无需运行时检查。
3. **SKILL.md 加 run 前检查纪律**（第 3 步「准备输出目录」后）：新增一条——「跑 workflow 前，若 `scripts/ai-daily/` 任何源文件比 `.claude/workflows/ai-daily.js` 新，必须先 `node scripts/ai-daily/build.mjs`」。用 `ls -t` 或 `find -newer` 检测。防御性，即使忘 commit 也能在 run 前发现。

**为什么**：run 用的是磁盘上 workflow 文件那一刻的内容；源改动不提交 + 产物不提交 = run 永远用旧版。commit 产物最简单可靠。

### B. 层 2 — major-out 项可溯源（A+C 兜底）

**问题**：major-out 项 source 硬编码 `(多源公认)`，无 URL，buildCitationMap 跳过，永远无 `[n]`。

**修复**（A 补 URL + C 兜底无 URL）：

1. **KNOWN_MAJOR_OUT 种子加 url 字段**（boards.mjs:52-55）：给**有官方一手页可溯源**的种子加 `url` 字段，纯媒体口径预告无官方页的不加（降级 C 兜底）：
   - DeepSeek V4-Pro → `https://api-docs.deepseek.com/news/`（DeepSeek 官方 news 页，已 WebFetch 验证存在且提到 `DeepSeek-V4-Pro-0813` 与种子 date 2026-08-13 吻合）。
   - Astra → **不加 url**。其 note 明说"来源：多家媒体 2026-08-02，日期为预告日"，是媒体口径预告、无 OpenAI 官方 Astra 一手页（openai.com/news 对机器人 403 且无具体 Astra 页）。给它一个 OpenAI news 索引会暗示"OpenAI 官方发了 Astra 页"——误导。诚实做法是不给 url，降级到 C 兜底标 `[行业公认·无单一链接]`，与层 3 未核查措辞呼应。
   - **种子的 url 字段是可选的**（无 url 的种子降级 C 兜底，不报错）。这条同时验证了 A+C 兜底的真实覆盖：有官方页的角标、无官方页的诚实标注。
2. **discover majorOutOfWindow 加可选 url 字段**（schemas.mjs:14）：`properties` 增 `url:{type:'string'}`，**不进 required**（discover 不带 url 仍合法）。
3. **discover prompt 鼓励带 url**（prompts.mjs:42）：第 5) 点 majorOutOfWindow 描述末尾加：「若该事实有可溯源的官方/一手 URL，尽量在 `url` 字段带上（可选，无则不带）。」
4. **`_mkMajor` 用 m.url**（dedup.mjs:22）：`sourceUrl: m.url || '(多源公认)'`，`sourceTitle: m.url ? hostname(m.url) : '行业客观公认事实'`。有 url 的 major-out 项 sourceUrl 是真 URL → buildCitationMap 正常编号 → `[n]` 角标 + 参考来源节。
5. **render 兜底标注无 URL 的 major-out**（render-md.mjs itemBlock）：item 的 sources 全是非 URL（文字描述）且 `status` 含 `[窗口外·重大]` 或该 item 来源无可溯源 URL 时，summary 末尾追加 ` [行业公认·无单一链接]`（在 badges 之后、conf 之前）。**不进参考来源节**（诚实承认无链接，不假装）。

**判定逻辑**（render-md itemBlock，精确）：
- `badges = citationBadges(it.sources, citeMap)`（已有）
- `noUrl = !badges && sources 全是非 URL`（即 sources 存在但 buildCitationMap 没给编号）—— 新增判定
- summary 末尾顺序：`summary + badges + (noUrl ? ' [行业公认·无单一链接]' : '') + (conf ? '\n\n*可信度：X*' : '')`

**为什么**：A 补 URL 让 best case 的 major-out 也能溯源（最接近 AI.md）；C 兜底让无 URL 的 major-out 诚实标注不假装。两者结合：有 URL 角标、无 URL 诚实标注。

### C. 层 3 — 未核查项措辞诚实（prompt 硬约束 + render 机器徽标双保险）

**问题**：未核查项（`verifiedByVote:false` / `status:'[窗口外·重大]'` / `'未核查'`）措辞带肯定倾向，§4.5 未区分未核查与已核查。

**修复**（prompt 硬约束 + render 机器徽标）：

1. **reportPrompt §4.5 收紧**（prompts.mjs:82）：现有 §4.5 后追加硬约束：
   > **对 `status` 为 `[窗口外·重大]` 或 `未核查` 的 item（未经窗口内对抗投票验证），summary 必须用不确定度措辞（"据报""有媒体称""宣称""待官方确认""暂不能确认"之一），禁止用"已解决""完成""正式发布""确认"等肯定完成态措辞描述其事项**。已核查项（status 为 `已核查 2-0`/`已核查 2-1`）有 vote 支撑，可正常陈述。社区传闻与官方动态须用不同措辞区分。

2. **render 机器徽标双保险**（render-md.mjs itemBlock）：item 的 `status` 是 `[窗口外·重大]` 或 `未核查` 时，summary 末尾（badges + noUrl 标注之后、conf 之前）追加 `*[未核查·待证实]*` 小字。即使 report 代理漏写措辞，读者也能一眼看出这条未经投票验证。

**判定逻辑**（render-md itemBlock，精确）：
- `unchecked = it.status === '[窗口外·重大]' || it.status === '未核查'`
- summary 末尾顺序：`summary + badges + (noUrl ? ' [行业公认·无单一链接]' : '') + (unchecked ? ' *[未核查·待证实]*' : '') + (conf ? '\n\n*可信度：X*' : '')`

**为什么**：prompt 约束是代理自觉（deepseek-v4-flash 可能漏守）；render 机器徽标是确定性兜底（不依赖代理）。双保险确保读者不把未核查项误判为已确认。

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `scripts/ai-daily/render-md.mjs` | 完整版+降级版 md 渲染 | 改：itemBlock 加 noUrl 兜底标注 + 未核查项机器徽标（B.5 + C.2） |
| `scripts/ai-daily/prompts.mjs` | reportPrompt 合成要求 + discover prompt | 改：§4.5 收紧未核查措辞（C.1）；discover majorOutOfWindow 鼓励带 url（B.3） |
| `scripts/ai-daily/schemas.mjs` | discover schema | 改：majorOutOfWindow 加可选 url 字段（B.2） |
| `scripts/ai-daily/dedup.mjs` | major-out claim 构造 | 改：`_mkMajor` 用 m.url 作 sourceUrl（B.4） |
| `scripts/ai-daily/boards.mjs` | KNOWN_MAJOR_OUT 种子 | 改：2 条种子加 url 字段（B.1） |
| `scripts/ai-daily/test/render-md.test.mjs` | render-md 单测 | 增：noUrl 标注、未核查徽标、major-out 带 URL 角标 |
| `scripts/ai-daily/test/prompts.test.mjs` | prompts 单测 | 增：§4.5 未核查措辞硬约束断言、discover majorOutOfWindow url 鼓励 |
| `.claude/workflows/ai-daily.js` | build 产物 | rebuild + commit（A.2） |
| `.claude/skills/ai-daily/SKILL.md` | 编排纪律 | 加 run 前 build 检查（A.3） |
| `DallyReport/ai-daily/` 镜像 | 字节同步 | 改完同步 + secret-scan + commit/push |

## 全局约束

- **TDD**：每个 render-md/dedup 改动先写失败测（红）→ 实现（绿）→ 重构。测试直调纯函数，不跑 workflow。
- **向后兼容**：种子的 url 字段可选（无 url 降级 C 兜底）；discover majorOutOfWindow url 可选；schema 新字段不破坏旧产物。
- **不改 payloads 字段结构**：md 字符串内容变，workflow return 的 `payloads.{claims,sources,meta,md}` 字段不变，finalize 逐字节落盘不变。
- **中文一致性**：所有新增渲染文本中文（`[行业公认·无单一链接]`、`*[未核查·待证实]*`）。
- **测试断言**：
  - noUrl：item sources 全文字描述（如 `['HuggingFace 官方博客']`）+ status 含 `[窗口外·重大]` → md 含 `[行业公认·无单一链接]`、不含 `### 参考来源`（该项无 URL）。
  - 未核查徽标：status `[窗口外·重大]` → md 含 `*[未核查·待证实]*`；status `已核查 2-0` → 不含。
  - major-out 带 URL：种子带 url → `_mkMajor` sourceUrl 是真 URL → buildCitationMap 编号 → 角标 + 参考来源节。
  - prompts §4.5：含"`[窗口外·重大]` 或 `未核查`"措辞硬约束文本 + "禁止已解决/完成/正式"禁令。
  - discover prompt：含"majorOutOfWindow" + "url" 鼓励文本。
- **build.mjs**：改完 `node scripts/ai-daily/build.mjs` 重建产物，`node --check` 通过（注：DallyReport 镜像 `"type":"module"` 下 `node --check` 报 `Illegal return statement` 是已知 hybrid 语法现象，以 `node --test` 全绿为准）。
- **双端同步**：源 → 镜像（`fix/ai-daily-sources-uncertainty` 新分支，非 main）字节同步 + secret-scan + 仅 add ai-daily/。
- **源端提交**：改完在 obsidian 源仓库也 commit（这是层 1 的核心动作，之前漏了）。分支：obsidian 源仓库当前不在 git 仓库下（`Is a git repository: false`），实际 git 仓库在 DallyReport 镜像；源端改动通过镜像同步提交。

## 实施顺序

1. **B.1+B.4**：boards.mjs 种子加 url + dedup.mjs `_mkMajor` 用 m.url + 测（红→绿）。
2. **B.2+B.3**：schemas.mjs majorOutOfWindow 加 url + prompts.mjs discover 鼓励带 url + 测。
3. **B.5+C.2**：render-md.mjs itemBlock 加 noUrl 兜底 + 未核查徽标 + 测。
4. **C.1**：prompts.mjs §4.5 收紧未核查措辞 + 测。
5. build.mjs 重建 + `node --check`（源端）+ 全测绿。
6. SKILL.md 加 run 前 build 检查纪律（A.3）。
7. 镜像同步 + secret-scan + commit/push `fix/ai-daily-sources-uncertainty`（A.1 源端提交随镜像提交完成）。
8. 回归验证：用 8/21 JSON 重跑降级版渲染（确认无回归）+ 构造含 major-out（带 url 和不带 url）+ 未核查 item 的 report 样例喂 renderMarkdown，断言角标/兜底标注/未核查徽标齐全。

## 验证

1. `node --test scripts/ai-daily/test/*.test.mjs` 全绿（现有 79 + 新增约 8-10）。
2. `node scripts/ai-daily/build.mjs` exit 0。
3. 构造样例 report 喂 renderMarkdown：①major-out item 带 URL sources → `[n]` 角标 + 参考来源节；②major-out item sources 全文字 → `[行业公认·无单一链接]` + 无该条参考来源；③status `[窗口外·重大]` item → `*[未核查·待证实]*`；④status `已核查 2-0` item → 无 `*[未核查·待证实]*`。
4. 确认 `.claude/workflows/ai-daily.js` rebuild 后含 noUrl/未核查徽标逻辑（grep）。

## 语义守住（回归清单）

- 9 板覆盖矩阵 + 花名册三态不变；`[窗口外·重大]` 注入 + KNOWN_MAJOR_OUT age gate（≤21d）不变。
- `verifiedByVote:false`、`vote:'—'` 不冒充投票；新增 `[行业公认·无单一链接]`/`*[未核查·待证实]*` 是**呈现层**标注，不改 claim 数据的 vote/verifiedByVote 字段。
- 3 JSON 逐字节落盘不变；md 字符串内容变、payloads 字段结构不变。
- 核查终判序不变；降级走既有路径，无新抛错点。
- KNOWN_MAJOR_OUT 种子**内容**不增删（只加 url 字段）；age gate 阈值 21d 不变。
- reportPrompt 既有头条优先序、禁工具调用、新闻式标题≤25字、§4.5 现有不确定度措辞全保留，仅增量收紧未核查项措辞。

## 追加根因（2026-08-22 烟雾验证发现）：workflow realm 无 URL 全局

三层修复（A/B/C）落地后，8/22 单板 labs 烟雾 run 实证：report 代理已正确返回真 URL sources（`https://api-docs.deepseek.com/news/`、`https://x.ai/news/grok-4-6`、`https://openai.com/index/stampli` 等），但完整版 md 仍是 **0 [n] 角标、0 参考来源节、全项 [行业公认·无单一链接] 兜底**。源端 `renderMarkdown` 在同一 report 上却产 12 角标——同代码同数据不同输出，悖论。

**根因（Workflow 脚本 realm 实证）**：Workflow 工具的脚本 realm 是受限 JS 环境，**无 Node 全局 `URL`**（`typeof URL === 'undefined'`；`Map`/`Set`/`JSON` 等 JS 内置可用）。`render-md.mjs` 风格优化新增的 `buildCitationMap`/`citationBadges`/`hostname` 用 `new URL(s).href` → 抛 `ReferenceError: URL is not defined` → 各处 `catch { continue }` / `catch { return s }` 静默吞掉**每一个 URL** → citeMap 空 → 0 角标、0 参考来源节、`noUrl` 兜底全项触发。`dedup.mjs` `_hostnameOf` 的 `new URL(s).hostname`（catch→null）同病但影响小（只丢 sourceTitle）。

**为什么三层修复没拦住**：三层都在代码/schema/prompt 层，而这是 realm 运行时缺失全局。8/21 完整版第一次 run 也是 0 角标——当时误判为"产物未含引用逻辑"（层 1），但实测 HEAD 产物确含 buildCitationMap；真正原因即此 realm 缺失，从风格优化上线起一直静默失效。

**修复（层 4 — realm 适配）**：新增 `scripts/ai-daily/url-polyfill.mjs`——最小 WHATWG URL polyfill（仅 `.href`/`.hostname`/`.protocol`，非 URL 抛 TypeError 保留各处 catch 语义，幂等：已有全局 URL 则跳过），模块加载即 `globalThis.URL = MinURL`。`build.mjs MODULES` 置 `url-polyfill` 第一（在任何用 `new URL()` 的模块前 inline 执行）。`render-md.mjs` import 并在顶部 `installUrlPolyfill()`（node:test 直跑时全局 URL 已在，幂等跳过；realm 时由最先 inline 的 url-polyfill 已注入）。`test/realm-url.test.mjs` 模拟 realm（删 globalThis.URL）断言：①无 URL 时 citeMap 空（复现 bug）②注入后产 URL 条目 ③完整版 md 含 [n] 角标+参考来源节 ④href 幂等 ⑤hostname 正确 ⑥非 URL 抛错。

**验证**：93/93 测绿（87+6 realm-url）。端到端确认（2026-08-22 烟雾 run wf_8708dac6-4c0，report 代理 600s 超时走降级路径）：降级版 md 含 `[1]`/`[2]`/`[3]` 正文角标 + `### 参考来源` 4 条（hostname 正确：openai.com / blogs.nvidia.com / api-docs.deepseek.com）+ 非 URL `(多源公认)` 正确跳过。降级路径走 `renderDegradedMarkdown` → `buildCitationMap`（与完整版 `renderMarkdown` 同一函数、同一 `new URL()`），故降级版产角标即证 polyfill 修复完整版同样生效（0 角标 bug 根因消除）。完整版真实 run 待 report 代理稳定产出 sections 后再补端到端截图。

## 追加 C.3（2026-08-22）：状态标签容错 + status 枚举收口

层 4 修复后的完整版首 run（09:05 生产日）暴露一个相邻缺陷：正文里 7 条 major-out 只有 1 条挂了 `*[未核查·待证实]*` 徽标——6/7 的 status 写成无方括号的 `窗口外重大`，`render-md.mjs` C.2 判定精确匹配 `'[窗口外·重大]'`，漏判。这是报告代理产出 status 写法不统一 + 判定过严双重原因，层 4 前完整版 0 角标看不到正文所以没显形。

**修复（双轨）**：①render 容错——`render-md.mjs` 新增 `normalizeStatus`（全半角括号归一半角、去全半角空白、全角 `（）［］` 归半角）+ `isUncheckedStatus` 判定，`窗口外·重大`/`窗口外重大`/`未核查`/带空白变体统一挂徽标，`已核查 2-x`/`已否决` 不误判；②源头收口——`REPORT_SCHEMA.status` 加枚举（`已核查 2-0`/`已核查 2-1`/`[窗口外·重大]`/`未核查`/`已否决`），`reportPrompt` 增加"必须写枚举之一、窗口外重大必带方括号"的强制说明。

**测试**：`render-md.test.mjs` 新增 C.3（6 个应挂徽标变体 + 8 个不应挂形态矩阵）；`status-enum.test.mjs` 新增 3 测锁死 schema 枚举字面量 + 不含变体 + prompt 强制说明。全套 97/97 绿。产物重建 1406 行，`node --check` OK。
