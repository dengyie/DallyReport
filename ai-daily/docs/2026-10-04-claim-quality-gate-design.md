# 声明质量门改造设计（claim-quality-gate）

> 2026-10-04 · 依据当日日报质量审计实证 · 状态：**已实施（同日，全量 476 测 467 pass / 0 fail / 9 有意 skip，产物 3303 行已 --sync-vault）**
> 审计对象：`AI/DallyReport/2026-10-04/`（四件套 + wf_0a0edc92/wf_9b02f3f6 两个 workflow payload + 生产账本）

## 0. 一句话

在 workflow 管线的声明（claim）流上增加**确定性质量门**（纯函数模块）+ **verify 选择门槛** + **verify 全错补投轮** + **提取 prompt 硬化**，根治「论坛附件标注/评论碎片被当成可证伪声明、穿透核查、污染账本、挤出真头条」的完整故障链。

## 1. 实证（10-04 审计证据，全部可复核）

### 1.1 垃圾声明穿透全链路

16 条提取声明中 ≥5 条是版面垃圾（原文逐字）：

| claim 原文 | 性质 |
|---|---|
| `image 580×286 7.97 KB` | 纯附件尺寸标注 |
| `如图： image 487×438 13.4 KB 不用忍受被封号，KYC了，直接200刀ultra` | 附件 caption + 评论碎片 |
| `这个参数和模型的数据知识量有关` | 无主语评论碎片 |
| `虽然技术报告都看过，但是看到切开来的电镜图还是有点起鸡皮疹药 哔哩哔哩 逻辑折叠深度解析` | 评论碎片 + 站名残留 |
| `https://www.nytimes.com/2026/09/29/us/anthropic-claude-morals-ai.html The Times` | 纯 URL 粘贴 + 残题 |

其中 `image 580×286 7.97 KB`（linux.do/t/2979428）在 12:55 版本（后被覆写）中是**唯一通过 2-0 核查投票的"已确认事实"**，并写入生产账本：

```json
{ "day": "2026-10-04", "url": "https://linux.do/t/2979428",
  "tokens": ["image", "7.97"], "title": "image 580×286 7.97 KB" }
```

核查代理给附件截图的尺寸说明投了 2-0 确认——verify 预算被垃圾消耗，垃圾进入账本。

### 1.2 真头条被挤出（垃圾的间接伤害）

`Antigravity 发布 Opus 5.5 / Sonnet 5.5`（两个独立帖 2979444 + 2979428 相互印证，当日最大模型新闻）与 `微软把 Rust 提为一级语言`（2977263）的 claim 恰好被提取成附件垃圾/碎片 → 合成无干净素材 → 正文选了更弱的条目（MIT"读心"材料残缺、Space-Bunny 匿名模型传闻）。

### 1.3 verify 档全灭（网关因，非逻辑因，但要韧性）

`verify_agent_errors:6` + `ladder_exhausted:verify` → **0/16 确认**。晚间 launch 输出自述"网关 524 风暴贯穿 Fetch/Verify"。verify 全错票的 claim 现状：直接落 unverified，无补投。

### 1.4 护栏实战（保持不动）

`report_source_hallucination:5`——报告代理编造的 5 个 URL 全被确定性白名单拦下（9/19 护栏真实工作）。本设计不动该机制。

## 2. 目标与非目标

**目标**：垃圾声明不进 verify、不进正文、不进账本；真头条不因提取噪声丢失；verify 全错有一次性补投；全链路可观测、可单测。

**非目标**：
- 不动 2+1 自适应票制语义（survives ⇔ valid≥2 && refuted<2）
- 不引入语义模型判垃圾（不可测、不可回归、成本高）——全部门槛都是**确定性纯函数**
- 不清洗既有账本（pruneLedger 60 天自愈；`tokens:["image","7.97"]` 指纹误伤真实新闻的概率≈0，运维笔记已记录该条目来源）
- 不改 render-md 结构与REPORT_SCHEMA
- 不处理双跑覆写（运维纪律问题，已在运维笔记记录：停 runner 后必须 `ps` 清理 claude 子进程）

## 3. 管线现状（接线事实，行号以 10-04 产物 3213 行版为准）

```
fetch 批次循环 L2649-2669 ──→ extracted.push(batchRes)
                                │  每条 claim 经 bindExtractedClaims(L269)：
                                │    sourceUrl = claim.sourceUrl(须 http) || src.url
                                │    附上 board/date/sourceQuality
linuxdo mint 直铸 ──────────────┤（rankedClaims 注释 L654：mint 排在 extracted 最前）
                                ▼
allClaims = sources.flatMap(s => s.claims)          ← L2673，两路汇合点
claimsByBoard / MAX_VERIFY 板块配额                 ← L2680-2705
rankedClaims = roundRobinTake(quotaMap, MAX_VERIFY) ← L2707，进 verify 的唯一入口
voteClaim（自适应 2+1，safeAgentWithLadder）         ← L2731
verify 批次循环 + VERIFY-SALVAGE（仅 verify 从未启动时） ← L2756-2779
voted → confirmed / refuted / unverified            → payloads（L3143 sourcesJson / L3206 payloads）
```

**关键结论**：`allClaims`（L2673）是 fetch 提取与 linuxdo mint 两路的唯一汇合点——质量门的接线点选这里，一处覆盖两路。`rankedClaims`（L2707）是 verify 预算的唯一入口——substance 门选这里。

## 4. 方案设计（六项）

### A. 新纯模块 `claim-gate.mjs`（进 MODULES）

```js
// claim-gate — 声明质量门（纯函数，realm 安全：无 process/fs/Date.now）
// 10-04 审计实证：附件标注/评论碎片被提取为 claim → 2-0 确认 → 入账本；真头条被挤出。

// A1 确定性垃圾模式（精度优先，全部锚定当日实证形态；宁漏勿滥——被漏的垃圾
//     由 D 节 substance 门挡在 verify 外，不会被确认为"已核实事实"）
const JUNK_RES = [
  /^image\s+\d+×\d+/i,                      // 附件尺寸标注开头（image 580×286 7.97 KB）
  /^\d+(\.\d+)?\s*(KB|MB|GB)\b/i,           // 纯大小串开头
  /(^|\s)image\s+\d+×\d+\s+\d+(\.\d+)?\s*(KB|MB)\b/i, // 内嵌附件标注（"如图： image 487×438 …"）
  /^如图[：:，,]?/,                           // 「如图」开头的图片说明碎片
  /^https?:\/\/\S+\s*$/,                    // 纯 URL 粘贴（无文字内容）
]
export const isJunkClaim = c => {
  const t = (c && typeof c.claim === 'string') ? c.claim.trim() : ''
  if (t.length < 8) return true             // 过短，不可证伪
  return JUNK_RES.some(re => re.test(t))
}

// A2 verify substance 门（不丢数据，只省预算）：无数字、无拉丁实体、CJK 不足一句
//     的声明不值得 2-3 张核查票；落 unverified 池照常可渲染，但不进 rankedClaims。
export const needsVerification = c => {
  const t = (c && typeof c.claim === 'string') ? c.claim : ''
  return /\d/.test(t) || /[A-Za-z]{2,}/.test(t) || (t.match(/[\u4e00-\u9fff]/g) || []).length >= 10
}

// A3 批量门（返回 clean/dropped 供记账；不改写 claim 对象本身）
export const gateClaims = claims => {
  const clean = [], dropped = []
  for (const c of claims || []) (isJunkClaim(c) ? dropped : clean).push(c)
  return { clean, dropped }
}
```

要点：
- **零依赖纯函数**——realm 约束（无 process/fs/Date.now）自动满足，build.mjs 的 `FORBIDDEN_INLINE` 守栏自动覆盖。
- **模式表即数据**——当日实证形态逐条入表，测试用真实垃圾原文做 fixture（回归金标准）。
- **宁漏勿滥**：被 pattern 漏掉的垃圾由 A2 挡在 verify 外（最多成为"未核查"素材，永远不会成为"已确认事实"）；被 pattern 误杀的损失也极小——被 gate 的 claim 本就大概率进不了 MAX_VERIFY 配额。

### B. 模板接线（ai-daily.template.js）

**B1 主门**：L2673 处替换：

```js
const _gate = gateClaims(sources.flatMap(s => s.claims))
const allClaims = _gate.clean
const noiseDropped = _gate.dropped.length
if (noiseDropped) log('CLAIM-GATE dropped=' + noiseDropped + ' :: ' +
  _gate.dropped.slice(0, 3).map(c => (c.claim || '').slice(0, 30)).join(' | '))
```

覆盖 fetch 提取与 linuxdo mint 两路；日志行进 run-daily.log 供事后审计。

**B2 substance 门**：`rankedClaims` 构造（L2707）前对 `claimsByBoard` 各板切片过滤：

```js
for (const [k, arr] of claimsByBoard) claimsByBoard.set(k, arr.filter(needsVerification))
const substanceSkipped = <过滤前总数> - <过滤后总数>   // 记账用
```

注意：quota 分配（L2680-2705）必须**在过滤之后**计算——否则垃圾 claim 占配额、真声明被挤（正是 10-04 的次生伤害形态）。这是接线顺序的硬约束，实施时必须先过滤再分配。

**B3 记账**：
- `meta.stats` 增加 `claims_dropped_noise`（B1）与 `claims_substance_skipped`（B2）
- meta 顶层增加 `claim_gate: { dropped: N, substance_skipped: M }`
- payloads.claims 不加字段（被 gate 的声明不留尸体，payload 体积纪律）

### C. verify 全错补投轮（verify-retry）

现状：`voteClaim` 返回 `erroredCount`；所有票都失败的 claim 直接落 unverified，无第二次机会。10-04 的 524 风暴让 6 个核查票全灭。

设计：在 verify 批次循环结束之后、report 阶段之前插入**一轮**补投：

```js
const retryTargets = voted.filter(v => v.erroredCount > 0 && v.verdicts.length === 0)
  .slice(0, VERIFY_BATCH)               // 上限 = 一个批次（6 条），防雪上加霜
if (retryTargets.length && stageVerifyRan && budgetGate.roomTo('Verify') > 0) {
  log('VERIFY-RETRY re-voting ' + retryTargets.length + ' all-errored claims')
  const retried = await parallel(retryTargets.map(c => () => voteClaim(c, vtimeout)))
  /* 用 retried 原位替换 voted 中对应项；仍全错的保持 unverified（现有 verify_agent_errors
     降级旗标自然缩减） */
}
```

- **只补"全错票"**（`verdicts.length === 0`）——有分歧/部分成功的 claim 已有信号，重投不改变结论（2 票已定，补票语义由既有 2+1 终判规则覆盖）。
- **预算纪律**：复用 `budgetGate` 与 `verifyLadderT0` 共享阶梯预算；遵守 8/28 一次性状态注释（`stageVerifyRan` 已置位时不得重复调 `budgetGate('Verify')` 记账）。
- **记账**：meta 顶层 `verify_retry: { targets: N, recovered: M }`（recovered = 补投后 verdicts 非空数）。
- **墙钟安全**：上限一个批次 + roomTo 门控，最坏增加 ≤VERIFY_BATCH×2 票 ×AGENT_TIMEOUT_MS，由既有"墙钟是软目标，尾批可超"契约覆盖。

### D. fetch prompt 硬化（prompts 区块，'## Source Extractor'）

在现有规则列表中插入一条（编号顺延；**标题行一字不动**——progress.mjs `classifyPrompt` 锚点 `## Source Extractor` 依赖它）：

> 只提取**完整主谓结构、可证伪的事实陈述**（谁/什么/做了什么/含数字或专名）。以下内容**不得**提取为 claim：附件与图片的尺寸标注（如 `image 580×286 7.97 KB`）、「如图」开头的图片说明、无主语的评论碎片、纯 URL 或链接列表、楼层引用残留。论坛帖只提取**主帖正文**的事实性内容，评论区文字不提取。

prompt 层（语义）与 A 节确定性门（机械）互为双保险：模型漏网的被模式表拦，模式表误杀的由 prompt 层减少发生。

### E. sourcesJson 来源精度（低成本顺带）

L3143 的 sourcesJson 每源增加 `claimUrls`：

```js
claimUrls: [...new Set(s.claims.map(c => c.sourceUrl).filter(u => u && u !== s.url))]
```

10-04 实证：research.google 源条目只存了博客根 URL，具体文章地址 `…/toward-provably-private-learning-from-federated-data/` 只在 claim 里——溯源要二次拼。该字段让 sources.json 自含精确出处。**不改变既有字段**（向后兼容）。

### F. 账本卫生（零代码，纪律项）

- 今日已入账的垃圾条目（tokens `["image","7.97"]`）**不清洗**：指纹不构成对真实新闻的误伤威胁，pruneLedger 60 天自愈。
- 本设计生效后，垃圾 claim 在 A 节即被拦，**结构上不可能**再进入 confirmed → 不可能再入账本（记账只发生在 confirmed 集合）。

## 5. 不确定性坦白

- **评论碎片无法全靠模式根除**：「这个参数和模型的数据知识量有关」（13 个 CJK 字符）能通过 A2 substance 门（≥10 CJK）。此类靠 D 节 prompt 硬化减少发生；确定性门槛只能拦"机械可识别"形态。设计上接受残余噪声落在 unverified 池（不进 verify、不可能 confirmed）——**危害上限被 A2 封死**。
- **误杀风险**：`^如图` 模式可能误杀"如图 X 所示，营收增长 30%"这类以图引入的正文声明——但该形态 claim 必含数字，建议模式改为 `/^如图[：:，,]?\s*(image|$)/i`（「如图」后紧跟附件标注或结尾才算），实施时以此为准。
- **配额顺序约束**：B2 若先分配后过滤，会复现"垃圾占配额"伤害。实施 checklist 单列此项，测试必须锁「过滤先于配额分配」。

## 6. 测试计划

| 测试 | 内容 |
|---|---|
| `test/claim-gate.test.mjs`（新） | ① 10-04 实证垃圾中**机械可拦截的三条**（#1 附件标注 / #2 内嵌附件 / #5 URL 残片）逐字断言 `isJunkClaim === true`（回归金标准）；② 两条语义残余（#3/#4 评论碎片）如实断言 `isJunkClaim === false` 并注明由 prompt 层（§4.D）负责——§5 坦白的覆盖边界，测试不说谎；③ 反例不误杀（含「如图 3 所示，营收增长 30%」——§5 收窄模式的防误杀锁）；④ `needsVerification` 三分支与边界（9 CJK 拒 / 10 CJK 收 / 数字 / 拉丁 / 空串 / null）；⑤ `gateClaims` 分账引用透传 |
| `test/build.test.mjs`（更新） | MODULES 含 `claim-gate`；realm 守栏自动覆盖新模块（FORBIDDEN_INLINE 断言跑在产物上） |
| `test/workflow-integration.test.mjs`（更新） | 模拟 fetch+mint 混合输入：垃圾 claim 不入 allClaims、quota 按过滤后分配（锁「过滤先于配额」）、substance-skipped 落 unverified 不进 rankedClaims |
| `test/prompts.test.mjs`（更新） | fetch prompt 含提取卫生规则文本；`## Source Extractor` 锚点首行不变 |
| 全量 + 部署 | `node --test`；`build.mjs --sync-vault`；产物零漂移检查照常 |

## 7. 实施清单（文件级）——全部完成 ✓

1. [x] `scripts/ai-daily/claim-gate.mjs`（新，A 节三导出）
2. [x] `scripts/ai-daily/test/claim-gate.test.mjs`（新，§6——含 10-04 真实垃圾原文 fixtures）
3. [x] `ai-daily.template.js`：`/* @inline: claim-gate */` 占位符（ledger/linuxdo 之间）+ B1 allClaims 门 + B2 substance 门（先于配额）+ C VERIFY-RETRY + F substance-unverified 不蒸发
4. [x] `scripts/ai-daily/build.mjs`：MODULES 追加 `'claim-gate'`（ledger 后、linuxdo 前）
5. [x] `scripts/ai-daily/prompts.mjs`：D 节声明卫生规则（rule 3 子行，锚点首行不动）
6. [x] sourcesJson：E 节 `claimUrls`
7. [x] meta（`claim_gate` + `verify_retry`）与 return stats（`claims_dropped_noise` + `claims_substance_skipped`）记账
8. [x] 测试：claim-gate 6 组 + prompts.test 卫生规则断言 + workflow-integration 接线顺序锁（含「过滤先于配额」「补投先于外部抽查」两条硬顺序）；全量 476 项 467 pass / 0 fail / 9 有意 skip；`build.mjs --sync-vault` 已同步（产物 3303 行）
9. [x] `docs/development.md` 变更记录 + 本文档状态改「已实施」

预估：模块+测试 ~150 行，模板接线 ~40 行，prompt ~3 行。半天内含测试可完成。

## 8. 观测与验收（下一 run）

- run-daily.log 出现 `CLAIM-GATE dropped=N :: …`（N>0 证明门在工作；若长期 N=0 说明提取端已干净或模式需更新）
- meta：`claims_dropped_noise` / `claims_substance_skipped` / `verify_retry`
- **质量验收口径**：confirmed 集合中不再出现附件标注形态；Antigravity/微软 Rust 类"多帖印证的模型/工程新闻"回到正文候选池
- 失败回滚：MODULES 摘除 `claim-gate` + 模板接线还原（单 commit revert 即可，无状态残留）
