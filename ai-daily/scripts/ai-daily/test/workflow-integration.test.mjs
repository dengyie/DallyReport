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
  assert.ok(TPL.includes("log('LINUXDO-OK ' + ld.topics + ' topics"), '成功日志 LINUXDO-OK n topics')
  assert.ok(TPL.includes('fetchLinuxDoNews34({ cdpHost: LINUXDO_CDP_HOST })'), '调用签名带 cdpHost')
  assert.ok(TPL.includes("log('LINUXDO-FAIL ' + (ld.reason || 'unknown')"), '失败日志 LINUXDO-FAIL reason')
  assert.ok(TPL.includes('degraded: true, linuxdoFailed: true, linuxdoReason'), '失败行为 degraded:true + linuxdoFailed')
  assert.ok(TPL.includes('linuxdoMaxSources'), '配额参数在模板可见')
  assert.ok(TPL.includes('.slice(0, LINUXDO_MAX_SOURCES)'), '按 linuxdoMaxSources 配额轮换')
  assert.ok(TPL.includes("found_via: 'linuxdo-cdp'"), 'posts 转 URL 候选标 linuxdo-cdp')
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
