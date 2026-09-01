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
  // 9/01 P1：consume 必须保留 prefetch snippet，否则 mint 无正文可铸。
  assert.match(TPL, /snippet:\s*p\.snippet/, 'consume 映射保留 snippet（mint 依赖）')
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

test('模板 P2：BREAKER-OPEN break 不得包住 linuxdo 三态消费（预抓通道与代理断路器解耦）', () => {
  const skip = TPL.indexOf("log('LINUXDO-SKIP no_cdp_host")
  const ok = TPL.indexOf("log('LINUXDO-OK prefetched")
  const loop = TPL.indexOf("for (const batch of chunkArr(DISCOVER_GROUPS, DISCOVER_BATCH))")
  const breakerLog = TPL.indexOf('BREAKER-OPEN Discover 余批跳过')
  assert.ok(skip > 0 && ok > 0 && loop > 0 && breakerLog > 0, '消费点 / 批循环 / 跳闸日志都在场')
  assert.ok(skip < loop && ok < loop, '三态消费在代理批循环之前')
  assert.ok(breakerLog > loop, 'BREAKER-OPEN 仍在批循环内（只跳代理余批）')
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

// ─── 9/01 覆盖韧性 P0：Fetch 首批必须是 prefer 通道混合物，不得二次静态前置 ───
// 9/01 生产实证：allocateFetchBudget 已把 linuxdo-cdp 与 static-fallback 混进 fetchTargets 前缀，
// 紧接着 preferStaticFirst + FETCH_FIRST_BATCH=max(FETCH_BATCH, staticCount) 把首批做成 100% 静态；
// BUDGET-BREAK 后余批整跳 → 已获配额的 6 席 linuxdo 零抓取。函数本体留在 dedup.mjs，编排层不得再调。

test('模板 P0：allocation 后不得调用 preferStaticFirst（编排层不得二次拆混排）', () => {
  const idxAlloc = TPL.indexOf('allocateFetchBudget(boardURLMap, MAX_FETCH)')
  const idxSlice = TPL.indexOf('fetchTargets.slice(0, FETCH_FIRST_BATCH)')
  assert.ok(idxAlloc >= 0 && idxSlice >= 0, 'allocation 与分批切片在场')
  // 允许注释里提函数名；可执行调用 `preferStaticFirst(fetchTargets)` 才是 9/01 吸烟枪。
  const callLines = TPL.split('\n').filter(l =>
    /preferStaticFirst\s*\(/.test(l) && !l.trim().startsWith('//'))
  assert.equal(callLines.length, 0,
    '模板编排层不得调用 preferStaticFirst（allocate 已按通道轮询混排）；实得：' + JSON.stringify(callLines))
  assert.ok(idxSlice > idxAlloc, '分批切片仍在 allocation 之后')
})

test('模板：allocateFetchBudget 走 8/27 prefer 通道（linuxdo-cdp/static-fallback 默认优先）', () => {
  // 调用点不带 opts → 走 dedup.mjs 默认 preferFoundVia=['linuxdo-cdp','static-fallback']；
  // prefer 阶段在轮询前优先取 linuxdo/静态候选（预算紧张时不把预兑内容挤到 budgetDropped）。
  assert.ok(TPL.includes('allocateFetchBudget(boardURLMap, MAX_FETCH)'), '调用点走默认 prefer 通道')
  assert.ok(TPL.includes("found_via: 'linuxdo-cdp'"), 'linuxdo-cdp 标记保持（prefer 依赖该标记识别）')
  // 模板对 prefer 通道书账：Dedup 日志带 linuxdo-cdp 进配额计数（可观测预抓内容真实入流水线）
  assert.match(TPL, /linuxdo-cdp 进配额/, 'Dedup 日志含 linuxdo-cdp 进配额计数')
})

test('模板 P0：FETCH_FIRST_BATCH === FETCH_BATCH（不得用 staticCount 扩首批挤掉 linuxdo）', () => {
  // 9/01：staticCount 扩首批只在静态前置后才「装下全部静态」——那正好把 linuxdo 挤出首批。
  // 首批固定 FETCH_BATCH=6，allocate 前缀已混排，首 6 条同时含两通道。
  assert.match(TPL, /const FETCH_FIRST_BATCH\s*=\s*FETCH_BATCH\b/, 'FETCH_FIRST_BATCH 就是 FETCH_BATCH，不再 max(..., staticCount)')
  assert.doesNotMatch(TPL, /FETCH_FIRST_BATCH\s*=\s*Math\.max\(FETCH_BATCH,\s*staticCount\)/, '不得再按 staticCount 扩首批')
  assert.match(TPL, /const fetchBatches\s*=\s*\[\]/, 'fetchBatches 容器在场')
  assert.match(TPL, /for \(let i\s*=\s*FETCH_FIRST_BATCH;\s*i\s*<\s*fetchTargets\.length;\s*i\s*\+=\s*FETCH_BATCH\)/, '后续批次按 FETCH_BATCH 步进')
  assert.ok(!/chunkArr\(fetchTargets,\s*FETCH_BATCH\)/.test(TPL), 'Fetch 分批不再固定 chunkArr(fetchTargets, FETCH_BATCH)')
  // SALVAGE 救护这一批本身，不再假装「先救完全部静态」
  assert.match(TPL, /FETCH-SALVAGE[\s\S]{0,200}batch\.length/, 'SALVAGE 日志按本批 batch.length 计数')
  assert.doesNotMatch(TPL, /Math\.min\(Math\.max\(FETCH_BATCH,\s*staticCount\),\s*batch\.length\)/, 'SALVAGE 不得再 max(FETCH_BATCH, staticCount)')
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

test('模板 P1：FETCH-SALVAGE 不因 mint 已写入 extracted 而关闭', () => {
  // mint 在 Fetch 循环前 push extracted → 若救护仍看 extracted.length===0，linuxdo 直铸后
  // 静态余批会在 roomTo=0 时走记账 gate 被整跳，9/01 的静态摄入也会一起蒸发。
  assert.doesNotMatch(TPL, /salvageFirst = extracted\.length === 0/, '救护不得再看 extracted.length（mint 会先写入）')
  assert.match(TPL, /const salvageFirst = !stageFetchRan && fetchTargets\.length > 0 && budgetGate\.roomTo\('Fetch'\) === 0/,
    '救护条件：Fetch 批未跑 + 仍有待抓 URL + roomTo 纯读')
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

test('模板 P1：配额内 linuxdo+snippet 在 Fetch 循环前 mint，并从 fetch 批剔除', () => {
  // 9/01：prefetch 已带 snippet，再走 fetch 代理砸 linux.do 是 524/403 弱路径。
  // 已获配额且有 snippet 的项立刻 mint 推进 extracted，URL 不再进 safeAgent(fetchPrompt)。
  const idxAlloc = TPL.indexOf('allocateFetchBudget(boardURLMap, MAX_FETCH)')
  const idxMint = TPL.indexOf('mintLinuxdoSource(')
  const idxPhaseFetch = TPL.indexOf("phase('Fetch')")
  const idxFetchAgent = TPL.indexOf('safeAgent(fetchPrompt(')
  assert.ok(idxAlloc >= 0 && idxMint >= 0 && idxPhaseFetch >= 0 && idxFetchAgent >= 0,
    'allocation / mintLinuxdoSource / Fetch phase / fetchPrompt 都在场')
  assert.ok(idxMint > idxAlloc, 'mint 在 allocateFetchBudget 之后（只铸已获配额项）')
  assert.ok(idxMint < idxPhaseFetch, 'mint 在 phase(Fetch) 之前（BUDGET-BREAK 也保得住）')
  assert.ok(idxFetchAgent > idxPhaseFetch, 'fetch 代理仍在 Fetch 阶段')
  // 铸出的 URL 必须从 fetchTargets 剔除，否则同一帖既 mint 又 WebFetch。
  assert.match(TPL, /mintLinuxdoSource/, 'mintLinuxdoSource 接线在场')
  assert.match(TPL, /extracted\.push/, 'mint 产物推进 extracted')
  // 剔除：按 URL 过滤 fetchTargets，或重建 fetchBatches 时跳过已 mint 的 URL。
  assert.match(TPL, /fetchTargets\s*=\s*fetchTargets\.filter/, '已 mint 的 linuxdo URL 从 fetchTargets 剔除')
})

test('模板 P1：Discover 入口 BREAKER.resetConsecutive() 在代理批循环前', () => {
  // Harvest 连续失败会垫高 Discover 门口 consecutive；阶段隔离只清 consecutive，不清 failures/reason。
  const idxPhase = TPL.indexOf("phase('Discover')")
  const idxReset = TPL.indexOf('BREAKER.resetConsecutive()')
  const idxLoop = TPL.indexOf("for (const batch of chunkArr(DISCOVER_GROUPS, DISCOVER_BATCH))")
  assert.ok(idxPhase >= 0 && idxReset >= 0 && idxLoop >= 0, 'Discover phase / resetConsecutive / 批循环都在场')
  assert.ok(idxReset > idxPhase, 'resetConsecutive 在 phase(Discover) 之后')
  assert.ok(idxReset < idxLoop, 'resetConsecutive 在代理批循环之前（Harvest 垫的 consecutive 不得带进第一批）')
})

test('模板：reportTries 保留作零素材闸门，派生 reportLadder 而非裸 MODEL_LADDER', () => {
  // 9/02 阶梯：reportTries 表达式逐字保留（有 claim→2、全空才 1），语义升级为「要不要进完整阶梯」。
  // 零素材只跑首级；有素材才启用 MODEL_LADDER。不得把裸 MODEL_LADDER 直接传给 report。
  assert.match(TPL, /const reportTries = allClaims\.length === 0 \? 1 : 2/, '有 claim→tries=2，全空才 1 次')
  assert.match(TPL, /const reportLadder = reportTries === 1 \? \[MODEL_LADDER\[0\]\] : MODEL_LADDER/, '零素材只跑首级')
  assert.match(TPL, /reportLadder, LADDER_BUDGET_MS\)/, 'report 传入派生的 reportLadder + 阶梯预算')
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
  assert.match(TPL, /timeoutMs: SYNTHESIS_LIMIT_MS/, 'report 走 SYNTHESIS_LIMIT_MS')
  assert.ok(!/timeoutMs: 600000/.test(TPL), 'report 不再写死 600000 魔法数')
  // report 不再被 synthAllowed 三元短路
  assert.match(TPL, /const report = await safeAgentWithLadder\(reportPrompt/, 'report 无条件尝试（阶梯包装，不套 synthAllowed）')
})

test('模板：从不 budgetGate(Synthesize)（方案 D 入口不走该字段）', () => {
  assert.doesNotMatch(TPL, /budgetGate\('Synthesize'\)/, '模板不得把 Synthesize 当入口闸门')
})

test('模板：safeAgent 末次 null 打 fail 不打 retry', () => {
  const seg = TPL.slice(TPL.indexOf('const safeAgent'), TPL.indexOf('const _TICK_MS'))
  const nullLine = seg.split('\n').find(l => l.includes('(null agent)'))
  assert.ok(nullLine, 'null agent 日志在场')
  assert.ok(nullLine.includes('fail'), '末次/分支须含 fail（throw 路径已是 fail；null 路径不得无条件 retry）')
})

test('模板：model: 只允许阶梯常量引用，禁止字面量', () => {
  // 9/02 阶梯：report/verify 必须传 model: m（变量）；禁止 model: 'deepseek-v4-flash' 这类字面量飘回。
  const agentCalls = TPL.split('\n').filter(l => /\b(agent|safeAgent|safeAgentWithLadder)\s*\(/.test(l))
  const withLiteral = agentCalls.filter(l => /\bmodel\s*:\s*['"`]/.test(l))
  assert.equal(withLiteral.length, 0, 'agent 调用不得传 model: "..." 字面量，只允许 model: m（阶梯变量），实得：' + JSON.stringify(withLiteral))
})

test('模板：ladderBudgetMs 数字原样透传（含 0），缺省才回落 DEFAULT_LADDER_BUDGET_MS', () => {
  // SKILL / 工厂契约：ladderBudgetMs<=0 关闭预算检查。模板不得用 >0 把 0 吞回 900000。
  assert.match(
    TPL,
    /const LADDER_BUDGET_MS = typeof args\.ladderBudgetMs === 'number' \? args\.ladderBudgetMs : DEFAULT_LADDER_BUDGET_MS/,
    '数字（含 0）原样透传；undefined 才用 DEFAULT_LADDER_BUDGET_MS',
  )
  assert.doesNotMatch(
    TPL,
    /LADDER_BUDGET_MS = typeof args\.ladderBudgetMs === 'number' && args\.ladderBudgetMs > 0/,
    '不得用 >0 把 ladderBudgetMs:0 吞回默认 15min',
  )
})

test('模板：report + verify 走阶梯，harvest/discover/fetch 仍 safeAgent', () => {
  assert.match(TPL, /safeAgentWithLadder\(verifyPrompt/, '_voteBatch 走阶梯')
  assert.match(TPL, /MODEL_LADDER, LADDER_BUDGET_MS/, 'verify 传完整 MODEL_LADDER + 预算')
  assert.match(TPL, /safeAgent\(harvestPrompt/, 'harvest 不走阶梯')
  assert.match(TPL, /safeAgent\(discoverPrompt/, 'discover 不走阶梯')
  assert.match(TPL, /safeAgent\(fetchPrompt/, 'fetch 不走阶梯')
  assert.match(TPL, /REPORT-FAIL 模型阶梯全废/, 'report 终局失败有明确日志')
  assert.match(TPL, /ladder_used:/, 'degradedFlags 含 ladder_used')
  assert.match(TPL, /ladder_exhausted:/, 'degradedFlags 含 ladder_exhausted')
  const idxTick = TPL.indexOf('const _TICK_MS')
  const idxLadderFn = TPL.indexOf('const safeAgentWithLadder')
  assert.ok(idxTick >= 0 && idxLadderFn >= 0, '_TICK_MS 与 safeAgentWithLadder 都在场')
  assert.ok(idxLadderFn > idxTick, 'safeAgentWithLadder 必须在时钟块之后（不得污染 safeAgent 切片）')
  assert.match(TPL, /makeSafeAgentWithLadder\(/, '模板接线工厂')
  assert.match(TPL, /generated_by: 'ai-daily \(' \+ MODEL_LADDER\[0\] \+ '\)'/, 'generated_by 跟阶梯首级走')
})
