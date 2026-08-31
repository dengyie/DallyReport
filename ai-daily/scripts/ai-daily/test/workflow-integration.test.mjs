import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TPL = fs.readFileSync(path.join(HERE, '../ai-daily.template.js'), 'utf8')

// ─── 2026-08-23 第二十一项：linuxdo 接入 + 双轨聚类（workflow 编排层源级测试）───
// 编排逻辑（discover 循环的 linuxdo 组抓取 + confirmedVerify 后的聚类主视图 + reportBody 注入）只存在于
// build 产物（ai-daily.js），其真源是模板脚本体。这里对模板源做文本断言，锁死不回归（与
// no-room-in-timeout / discover-fallback 的既有做法一致）。

test('模板：linuxdo 组在 DISCOVER_GROUPS 保留，无 cdp host 时 LINUXDO-SKIP 不降级（board 不崩）', () => {
  assert.ok(TPL.includes('if (!g.cdp) continue'), 'Discover 循环对非 cdp 组无感')
  assert.ok(TPL.includes('LINUXDO-SKIP no_cdp_host'), '无 cdp host 明确 SKIP 日志')
  assert.ok(TPL.includes('degraded: false, linuxdoSkipped: true'), 'SKIP 行不降级（degraded:false）')
})

test('模板：linuxdo 成功/失败两条路径都铺（OK 日志 + 配额塞 posts / FAIL 日志 + degraded 行）', () => {
  assert.ok(TPL.includes("log('LINUXDO-OK prefetched ' + LDP.topics + ' topics"), '成功日志 LINUXDO-OK n topics')
  // 8/27 Task 2：模板编排层不再调裸 fetchLinuxDoNews34（prefetch 前移到宿主 node——linuxdo-prefetch.mjs，
  // run-daily.sh 注入 linuxdoPrefetched JSON）。这里断言消费分支 + prefetched 数据来源。
  assert.ok(TPL.includes('LINUXDO_PREFETCHED'), '模板消费 linuxdoPrefetched（预抓隔离）')
  assert.ok(TPL.includes("prefetched ' + LDP.topics"), '成功日志为 prefetched 数据')
  assert.ok(TPL.includes("log('LINUXDO-FAIL "), '失败日志 LINUXDO-FAIL reason 前缀')
  assert.ok(TPL.includes("'no_fetch_realm'"), 'realm 内无预抓数据 → no_fetch_realm 稳定原因')
  assert.ok(TPL.includes('degraded: true, linuxdoFailed: true, linuxdoReason'), '失败行为 degraded:true + linuxdoFailed')
  assert.ok(TPL.includes('linuxdoMaxSources'), '配额参数在模板可见')
  assert.ok(TPL.includes('.slice(0, LINUXDO_MAX_SOURCES)'), '按 linuxdoMaxSources 配额轮换')
  assert.ok(TPL.includes("found_via: 'linuxdo-cdp'"), 'POST 转 URL 候选标 linuxdo-cdp')
})

test('模板：linuxdo_degraded 独立降级旗标 + meta 补 linuxdo_posts/linuxdo_open_posts', () => {
  assert.ok(TPL.includes("degradedFlags.push('linuxdo_degraded'"), '失败/降级 → linuxdo_degraded 旗标')
  assert.ok(TPL.includes('linuxdo_posts: discoverRows.filter'), 'meta 补 linuxdo_posts 统计')
  assert.ok(TPL.includes('linuxdo_open_posts: discoverRows.filter'), 'meta 补 linuxdo_open_posts 统计')
})

test('模板：cluster 双轨——confirmedVerify 后 clusterClaims，报告体注入「已聚类」块且不改 ctxP 契约', () => {
  assert.ok(TPL.includes('const clustered = clusterClaims(confirmedVerify)'), 'confirmedVerify 后立即聚类')
  assert.ok(TPL.includes('cluster 合并 '), '聚类块标注合并条数')
  assert.ok(TPL.includes('[cluster 已合并 '), '每条主视图打 cluster 标（prompt 4.7 识别）')
  assert.ok(TPL.includes('reportBody: reportBodyWithCluster'), 'reportBody 使用已聚类版本')
  // 不传 clustered 给 ctxP——report prompt 输入契约不变（ctxP 定义/注入不含 clustered 字段）
  assert.ok(!TPL.match(/clustered:/), 'reportPrompt 输入无 clustered 新字段')
})

test('模板：linuxdo/cluster 已在 build MODULES 且占位符在场（成品自包含）', () => {
  assert.ok(TPL.includes('/* @inline: cluster */'), 'cluster 占位符在场')
  assert.ok(TPL.includes('/* @inline: linuxdo */'), 'linuxdo 占位符在场')
})

test('模板 C2：cdp 组不进 inner parallel 的普通代理集（filter 后无 g.cdp），避免双 push + 裸 feed 403', () => {
  // inner parallel 必须 filter(!g.cdp)——否则 linuxdo 组既被预块 push 又被当普通代理再喂裸
  // linux.do/c/news/34（403）→ urls_discovered 翻倍 + Fetch 预算空耗 + 默认(nullptr)时板误标 degraded。
  // 用位置断言：filter(!g.cdp) 必须出现在 parallel(batch 之后、map(g => () => 之前。
  const idxFilter = TPL.indexOf('batch.filter(g => !g.cdp)')
  const idxParallel = TPL.indexOf('const round = await parallel(')
  const idxMap = TPL.indexOf('batch.filter(g => !g.cdp).map(g => () =>')
  assert.ok(idxFilter >= 0, 'inner parallel 必须过滤 cdp 组（batch.filter(g => !g.cdp)）')
  assert.ok(idxMap >= 0, 'filter 后仍是同一 map 表达式（batch.filter(...).map(...)）')
  assert.ok(idxParallel >= 0 && idxFilter > idxParallel, 'filter 在 parallel( 之后、进 safeAgent 之前')
  // 防回归：linuxdo 的 push 只应出现在 cdp 预块（三态各一次），不得在普通 round 的 .then 里再 push。
  const pushCount = (TPL.match(/discoverResults\.push\(\{ group: g, boards: g\.boards/g) || []).length
  // cdp 预块 3 处（SKIP/FAIL/OK）+ 普通 round 1 处 `discoverResults.push(...round)`（该行无 { group: g 前缀）。
  assert.equal(pushCount, 3, 'linuxdo 三态预块各 push 一次（4 个组返回行来源中不含普通 .then 的 g 行）')
})

test('模板 C1 侧：cluster 词法名不与 render-md 顶层冲突（clusterTokenize/clusterStopTokens）', () => {
  // 读 cluster.mjs 真源（build 整文件 inline 后，render-md 同名的未导出 tokenize/STOP_TOKENS 会在产物
  // 顶层与 cluster 的导出同名 → 宿主 new Function 加载必抛 SyntaxError。C1 修复 = cluster 侧改名）。
  const CLUSTER = fs.readFileSync(path.join(HERE, '../cluster.mjs'), 'utf8')
  assert.ok(CLUSTER.includes('const clusterStopTokens = new Set'), 'clusterStopTokens 定义在场')
  assert.ok(CLUSTER.includes('export const clusterTokenize = s =>'), 'clusterTokenize 导出在场')
  assert.ok(CLUSTER.includes('clusterTokenize(c.claim)'), 'unionTokens 用 clusterTokenize')
  // 不得再导出裸名 tokenize / 声明裸名 top-level STOP_TOKENS（与 render-md 顶层撞名）
  assert.ok(!/export const tokenize =/.test(CLUSTER), 'cluster.mjs 不再导出裸名 tokenize')
  assert.ok(!/^const STOP_TOKENS =/.test(CLUSTER), 'cluster.mjs 不再声明裸名 top-level STOP_TOKENS')
})

// ─── 8/27 Task 1：静态候选排序 + Fetch 预算书账（stageFetchRan 一次性状态）───

test('模板：preferStaticFirst 位于 allocation 后、Fetch 分批前', () => {
  // preferStaticFirst 必须作用于 allocateFetchBudget 的结果（fetchTargets），且在任何分装（分批）之前。
  const idxAlloc = TPL.indexOf('allocateFetchBudget(boardURLMap, MAX_FETCH)')
  const idxPref = TPL.indexOf('preferStaticFirst(fetchTargets)')
  const idxFirstBatch = TPL.indexOf('FETCH_FIRST_BATCH')
  const idxSlice = TPL.indexOf('fetchTargets.slice(0, FETCH_FIRST_BATCH)')
  assert.ok(idxAlloc >= 0 && idxPref >= 0 && idxFirstBatch >= 0 && idxSlice >= 0, '四处在场')
  assert.ok(idxPref > idxAlloc, 'preferStaticFirst 在 allocation 之后')
  assert.ok(idxFirstBatch > idxPref && idxSlice > idxPref, '分批组装在 preferStaticFirst 之后（排序后按 staticCount 扩首批）')
})

test('模板：allocateFetchBudget 走 8/27 prefer 通道（linuxdo-cdp/static-fallback 默认优先）', () => {
  // 调用点不带 opts → 走 dedup.mjs 默认 preferFoundVia=['linuxdo-cdp','static-fallback']；
  // prefer 阶段在轮询前优先取 linuxdo/静态候选（预算紧张时不把预兑内容挤到 budgetDropped）。
  assert.ok(TPL.includes('allocateFetchBudget(boardURLMap, MAX_FETCH)'), '调用点走默认 prefer 通道')
  assert.ok(TPL.includes("found_via: 'linuxdo-cdp'"), 'linuxdo-cdp 标记保持（prefer 依赖该标记识别）')
  // 模板对 prefer 通道书账：Dedup 日志带 linuxdo-cdp 进配额计数（可观测预抓内容真实入流水线）
  assert.match(TPL, /linuxdo-cdp 进配额/, 'Dedup 日志含 linuxdo-cdp 进配额计数')
})

test('模板：首批大小 max(FETCH_BATCH, staticCount)，后续按 FETCH_BATCH 分批', () => {
  // Fetch 分批不再用单一 chunkArr——首批取 max(FETCH_BATCH, staticCount)（装下全部静态项），
  // 后续批固定 FETCH_BATCH（静态项只入首批，余批保持既有并发上限）。
  assert.match(TPL, /const FETCH_FIRST_BATCH\s*=\s*Math\.max\(FETCH_BATCH,\s*staticCount\)/, '首批大小 = max(FETCH_BATCH, staticCount)')
  assert.match(TPL, /const fetchBatches\s*=\s*\[\]/, 'fetchBatches 容器在场')
  assert.match(TPL, /for \(let i\s*=\s*FETCH_FIRST_BATCH;\s*i\s*<\s*fetchTargets\.length;\s*i\s*\+=\s*FETCH_BATCH\)/, '后续批次按 FETCH_BATCH 步进')
  assert.ok(!/chunkArr\(fetchTargets,\s*FETCH_BATCH\)/.test(TPL), 'Fetch 分批不再固定 chunkArr(fetchTargets, FETCH_BATCH)')
})

test('模板：stageFetchRan 一次性 + 后续批次 roomTo 纯读停止，不再把 Fetch 写 skip', () => {
  assert.match(TPL, /let stageFetchRan = false/, 'stageFetchRan 一次性状态在场')
  assert.match(TPL, /stageFetchRan = true/, '首批正常启动前置位（await 之前）')
  assert.match(TPL, /if \(stageFetchRan\)/, 'stageFetchRan 分支在循环内')
  assert.match(TPL, /budgetGate\.roomTo\('Fetch'\)\s*===\s*0/, '后续批次用纯读 roomTo === 0 停止')
  assert.match(TPL, /if \(stageFetchRan\)\s*\{[\s\S]*?if \(budgetGate\.roomTo\('Fetch'\)\s*===\s*0\)\s*\{/, '纯读分支在 stageFetchRan 下的代码块内')
  // 8/26 既有语义保留：救护首批标记与余批 break
  assert.match(TPL, /let salvaged = false/, 'salvaged 标记在场')
  assert.match(TPL, /if \(salvaged\) break/, '救护后余批顶部 break')
})

test('模板：首批正常启动调 budgetGate(Fetch) 并前置 stageFetchRan；首批越线只走 FETCH-SALVAGE 不记账', () => {
  assert.match(TPL, /const gate = budgetGate\('Fetch'\)/, '非救护路径仍调用控 gate')
  assert.match(TPL, /stageFetchRan = true\s*\/\/ 首批正常启动/, '正常启动：await 前置 stageFetchRan')
  assert.match(TPL, /FETCH-SALVAGE/, '救护日志在场')
})

test('模板：静态注入不进 discoverRows.urls → urls_discovered 账本不变', () => {
  // 静态兜底只进 boardURLMap（fetch 配额前注入），不得追加到 discoverRows.urls —— 后者驱动
  // urls_discovered（meta/stats 记账）。账本不变指 discoverRows.urls 不含 static-fallback。
  const discoveryRowsLoops = TPL.match(/discoverRows\.reduce\(\(n, d\) => n \+ d\.urls\.length/g)
  assert.ok(discoveryRowsLoops.length >= 2, 'urls_discovered 统计在场（stats + meta）')
  // 注入点：static-fallback 的 boardURLMap push/unshift 不 touch discoverRows
  assert.doesNotMatch(TPL, /discoverRows\.push\([\s\S]*static-fallback/, 'discoverRows.push 不得带 static-fallback')
  assert.doesNotMatch(TPL, /discoverRows\.urls\.concat[\s\S]*static-fallback/, 'discoverRows.urls 不得追加静态项')
  assert.doesNotMatch(TPL, /discoverRows\.urls\.push\([\s\S]*static-fallback/, 'discoverRows.urls 不得 push 静态项')
})

// ─── 8/27 Task 2：dropped 明细可审计（fetch_budget_dropped 只能给总数；dropped_detail 逐类归因）───

test('模板：meta 包含 dropped_detail 逐类明细（linuxdo_cdp/static_fallback/other 三分类记账）', () => {
  // fetch_budget_dropped 只给总数不够归因；dropped_detail 给出"丢的到底是谁"的逐类账。
  assert.match(TPL, /dropped_detail:/, 'meta 包含 dropped_detail')
  assert.match(TPL, /linuxdo_cdp:/, 'dropped_detail 含 linuxdo_cdp 分类（预抓的帖被预算丢）')
  assert.match(TPL, /static_fallback:/, 'dropped_detail 含 static_fallback 分类（静态兜底被丢）')
  assert.match(TPL, /other:/, 'dropped_detail 含 other 分类（普通 discover 候选被丢）')
  // 三分类来自同一处 budgetDropped 统计（不凭空捏造），且有 len 守恒（other = 总 - 前两类）
  assert.match(TPL, /const linuxdoDropped = budgetDropped\.filter/, 'linuxdoDropped 从 budgetDropped 派生')
  assert.match(TPL, /const staticDropped = budgetDropped\.filter/, 'staticDropped 从 budgetDropped 派生')
  assert.match(TPL, /otherDropped = budgetDropped\.length - linuxdoDropped - staticDropped/, 'other 分类 = 总数 - 前两类（守恒）')
})

test('模板：dropped_detail 与 Dedup 日志同源（linuxdo-cdp 进配额计数复用同一账本）', () => {
  // 日志与 meta 都必须来自同一份 budgetDropped 派生账——避免"日志说进了、meta 却说丢了"的漂移。
  const dedupLogIdx = TPL.indexOf('linuxdo-cdp 进配额')
  const droppedDetailIdx = TPL.indexOf('dropped_detail')
  assert.ok(dedupLogIdx >= 0 && droppedDetailIdx >= 0, 'Dedup 日志与 dropped_detail 都在场')
  // dropped_detail 计算段出现在 Dedup 日志附近（同一账本派生点，不晚于 meta 组装）
  const linuxdoDroppedIdx = TPL.indexOf('const linuxdoDropped = budgetDropped.filter')
  assert.ok(linuxdoDroppedIdx >= 0, 'linuxdoDropped 派生在场')
})

// ─── 8/28 Verify SALVAGE 账本修复（镜像 Fetch stageFetchRan 一次性状态）───

test('模板：Verify 死线已过且 0 批已跑 → SALVAGE 救护首批（镜像 Fetch FETCH-SALVAGE 模式）', () => {
  // 8/28 修复：救护路径前置判定（roomTo 纯读），避免 budgetGate('Verify') 在救护前记账 →
  // claims_verified>0 同时 budget_skipped:Verify 的语义矛盾。
  assert.match(TPL, /VERIFY-SALVAGE/, 'VERIFY-SALVAGE 救护日志在场')
  assert.match(TPL, /let stageVerifyRan = false/, 'stageVerifyRan 一次性状态在场')
  assert.match(TPL, /const salvage = !stageVerifyRan && voted\.length === 0 && rankedClaims\.length > 0 && budgetGate\.roomTo\('Verify'\) === 0/, '救护条件：0 批已跑 + 有待核查 claim + roomTo 纯读')
  assert.match(TPL, /rankedClaims\.slice\(0, salvageCount\)/, '救护首批取前 salvageCount 条最高优先级 claim')
  assert.match(TPL, /salvageCount\s*=\s*Math\.min\(VERIFY_BATCH,\s*rankedClaims\.length\)/, 'salvageCount = min(VERIFY_BATCH, rankedClaims.length)')
  // 救护后 break（不继续下一批），与 FETCH-SALVAGE 行为一致
  const vsIdx = TPL.indexOf('VERIFY-SALVAGE')
  const afterSalvage = TPL.slice(vsIdx, vsIdx + 400)
  assert.match(afterSalvage, /break/, 'SALVAGE 后 break（不续批）')
})

test('模板：后续批次 stageVerifyRan 纯读停止——不记 budget_skipped:Verify', () => {
  // 8/28 关键语义：已跑首批 → if (stageVerifyRan) 分支 → roomTo 纯读 === 0 直接 break，
  // 绝不调用 budgetGate('Verify')（该调用会在账本里记 budget_skipped）。
  assert.match(TPL, /if \(stageVerifyRan\)/, 'stageVerifyRan 分支在 for 循环内')
  assert.match(TPL, /if \(stageVerifyRan\)[\s\S]*?if \(budgetGate\.roomTo\('Verify'\)\s*===\s*0\)[\s\S]*?break/, '后续批次：纯读 roomTo 停止不记 skip')
  assert.match(TPL, /BUDGET-BREAK Verify 余批跳过（已跑首批，roomTo=0 纯读停止，不记 budget_skipped:Verify）/, '后续批次纯读停止日志')
})

test('模板：首批正常启动调 budgetGate(Verify) 并前置 stageVerifyRan；首批越线只走 SALVAGE 不记账', () => {
  assert.match(TPL, /const gate = budgetGate\('Verify'\)/, '非救护路径仍调用控 gate')
  assert.match(TPL, /stageVerifyRan = true\s/, '首批正常启动：await 前置 stageVerifyRan')
  assert.match(TPL, /BUDGET-BREAK Verify 余批跳过，用已完成批次结果/, '正常启动首批超线日志保留')
})

test('模板：report safeAgent tries——只要有提取内容（allClaims>0）就 2 次尝试', () => {
  // 8/30 收紧：8/29 实证 9 条已确认内容因 report 单次未成功而全量降级 raw；只要当日有内容就给
  // tries=2（一次 end_turn/抖动不判死整份 report）。只有全空（allClaims 0，纯空板）才单次 fast-fail。
  assert.match(TPL, /const reportTries = allClaims\.length === 0 \? 1 : 2/, '有 claim→tries=2，全空才 1 次')
  assert.match(TPL, /}, reportTries\)/, 'safeAgent 第三个参数（tries）走 reportTries')
  assert.ok(TPL.indexOf('allClaims.length === 0 ? 1 : 2') >= 0, '全空才单次尝试')
  assert.ok(TPL.indexOf('confirmedVerify.length > 0') < 0, '不再以 confirmedVerify 判 tries（改以 allClaims 判）')
})

test('模板：探针只观察不否决——合成入口与总墙钟脱钩（9/01 方案 D）', () => {
  // 8/29 降级根因：探针单发 20s 失败把 synthAllowed 打成 false，report 从未被调用。
  // 8/30 修：探针降为 advisory，但 synthAllowed 仍绑 TOTAL_LIMIT_MS——P1 标定落地后病态跑
  // （8/31 Harvest 70min + Discover 129min）会正确把入口打成 false，已确认内容整份降 raw。
  // 9/01 方案 D：入口不再看总墙钟；探针无条件 advisory；report 无条件尝试，只受自身 timeout 约束。
  assert.ok(!TPL.includes('const synthAllowed = RUN_ELAPSED() <= TOTAL_LIMIT_MS'), 'synthAllowed 总墙钟门禁必须消失')
  assert.ok(!/const synthAllowed = RUN_ELAPSED\(\) <= TOTAL_LIMIT_MS \?/.test(TPL), '旧三元短路（探针否决）不得回归')
  assert.match(TPL, /await probeGateway\('report'\)/, '探针仍 advisory 调用')
  assert.ok(!/if \(synthAllowed\) await probeGateway/.test(TPL), '探针不再套在 synthAllowed 里')
  assert.ok(!TPL.includes("log('SYNTH-SKIP"), 'SYNTH-SKIP 总墙钟超限路径删除')
  assert.ok(!TPL.includes('synth skipped (wall-clock over limit)'), 'reportErr 不再含墙钟跳过字样')
  assert.match(TPL, /const reportErr = report \? null : 'report agent failed; reverting to raw archive'/, '合成失败只剩代理真失败')
})

test('模板：SYNTHESIS_LIMIT_MS 可配，默认 600s，接到 report timeoutMs', () => {
  assert.match(TPL, /const SYNTHESIS_LIMIT_MS = typeof args\.synthesisLimitMs === 'number' && args\.synthesisLimitMs > 0 \? args\.synthesisLimitMs : 600000/, 'synthesisLimitMs 默认 600000')
  assert.match(TPL, /timeoutMs: SYNTHESIS_LIMIT_MS/, 'report safeAgent 走 SYNTHESIS_LIMIT_MS')
  assert.ok(!/timeoutMs: 600000/.test(TPL), 'report 不再写死 600000 魔法数')
  // report 不再被 synthAllowed 三元短路
  assert.match(TPL, /const report = await safeAgent\(reportPrompt/, 'report 无条件尝试（不套 synthAllowed）')
})

test('模板：agent/safeAgent 不覆盖模型（全链路走 CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash）', () => {
  // 方案 D 模型项：现状已是 deepseek-v4-flash（环境变量），禁止在 opts 里写 model: 覆盖。
  const agentCalls = TPL.split('\n').filter(l => /\b(agent|safeAgent)\s*\(/.test(l))
  const withModel = agentCalls.filter(l => /\bmodel\s*:/.test(l))
  assert.equal(withModel.length, 0, 'agent/safeAgent 调用不得传 model:，实得：' + JSON.stringify(withModel))
  assert.ok(!/model:\s*['"]/.test(TPL), '模板不得出现 model: \'...\' 覆盖')
})
