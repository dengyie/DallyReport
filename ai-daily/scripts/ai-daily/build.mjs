#!/usr/bin/env node
// ai-daily workflow 构建器：模块真源（scripts/ai-daily/*.mjs）inline 进模板 → 自包含 workflow 产物。
// workflow realm 无 fs/模块解析，必须单文件自包含——本脚本是唯一既让逻辑进 node:test、又不破坏该约束的形态。
//
// 用法：node scripts/ai-daily/build.mjs [--out <path>] [--check-only]
// 护栏：①剥 export/import 后 inline；②产物 node --check；③占位符零残留断言。任一失败不出产物。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, 'ai-daily.template.js')
const DEFAULT_OUT = path.resolve(HERE, '../../.claude/workflows/ai-daily.js')

// inline 顺序即依赖序：url-polyfill 最先（注入 globalThis.URL，workflow realm 无 URL 全局，
// 否则 dedup._hostnameOf / render-md.buildCitationMap 的 new URL() 抛 ReferenceError 被 catch 吞 → 完整版 0 角标）；
// date-utils 的 normURL 被 boards 的 GROUPS_RAW 闭包引用，必须在 boards 前。
// cluster/linuxdo（8/23 第二十一项）为纯导出零依赖模块，排在 render-md 后（linuxdo 相对 render 无依赖，
// 放最后即可；与模板占位符顺序保持一致）。
// wallclock（8/31 P1）：墙钟标定 + 计数型断路器，纯函数零依赖，排在 budget 后（budget 不 import 它，
// 但模板里 makeCalibratedElapsed 要包住 RUN_ELAPSED 再喂给 makeBudgetGate，顺序上必须先于使用点）。
// ladder（9/02）：模型阶梯降级工厂 makeSafeAgentWithLadder，纯函数零依赖，排在 wallclock 后
// （模板接线点在 probeGateway 之后，inline 顺序只需早于使用点；DEFAULT_LADDER 被 render-md import）。
// ledger（9/13）：跨天已报道账本纯函数（filterReportedTargets/splitSeeds/storyMatch/prune），import
// clusterTokenize（cluster）与 normURL/normalizeDate/daysBetween（date-utils）→ 必须排在 cluster 之后。
// cdp-core（9/13）：CDP 协议层（closeTab/readBodyText*/CDP_DEFAULTS），linuxdo.mjs import 它 → 排在 linuxdo 前。
const MODULES = ['url-polyfill', 'date-utils', 'schemas', 'boards', 'dedup', 'budget', 'wallclock', 'ladder', 'fallback', 'prompts', 'render-md', 'cluster', 'ledger', 'cdp-core', 'linuxdo']

// 剥模块为可 inline 文本：去 import 行（依赖由顺序保证）、export 前缀、模块头注释。
const stripModule = name => {
  const src = fs.readFileSync(path.join(HERE, name + '.mjs'), 'utf8')
  const body = src.split('\n')
    .filter(l => !/^import\s/.test(l))
    .map(l => l.replace(/^export\s+(const|function|async function)/, '$1'))
    .join('\n')
  return '// ─── inline: ' + name + ' ───\n' + body.trim()
}

const build = () => {
  let out = fs.readFileSync(TEMPLATE, 'utf8')
  const missing = []
  for (const m of MODULES) {
    const tag = '/* @inline: ' + m + ' */'
    if (!out.includes(tag)) { missing.push(m); continue }
    out = out.replace(tag, () => stripModule(m))
  }
  if (missing.length) throw new Error('模板缺占位符: ' + missing.join(', '))
  const residue = out.match(/\/\* @inline: [^\*]+ \*\//g)
  if (residue) throw new Error('占位符未全部替换: ' + residue.join(', '))
  return out
}

// 8/29 Task 3 回归护栏：linuxdo-prefetch.mjs 是宿主 Node CLI（CDP 抓取隔离层），
// 绝不 inline 进 workflow realm（realm 无 fetch/WebSocket/process）。产物必须：
//   ① 含 linuxdoPrefetched 消费入口（run-daily.sh 预抓注入契约）；
//   ② 不含 linuxdo-prefetch 模块文本（未被误加进 MODULES）；
//   ③ 不含裸 `await fetchLinuxDoNews34(`（realm 内不得再裸抓 CDP——旧 8/26 版回归源）。
// 任一违规即构建失败，防止「模板已改、产物仍走旧裸抓」的静默漂移（2921db72 曾提交该漂移状态）。
const REQUIRED_MARKERS = [
  [/linuxdoPrefetched/, '产物须含 linuxdoPrefetched 消费入口（Task 2 预抓注入契约）'],
  [/reportedLedger/, '产物须含 args.reportedLedger 消费入口（9/13 跨天账本契约）'],
  [/webFetchViaCdp/, '产物须含 webFetchViaCdp 门控（9/13 fetch 走 9222 CDP 契约）'],
]
const FORBIDDEN_INLINE = [
  [/prefetchLinuxDo|runPrefetch/, 'linuxdo-prefetch（宿主 Node CLI）不得 inline 进 workflow'],
  [/process\.exit|require\(/, 'workflow realm 不得含宿主 Node CLI 进程/模块 API'],
  [/await fetchLinuxDoNews34\(/, 'realm 内不得再裸调 fetchLinuxDoNews34（无 fetch/WebSocket 全局，旧版回归）'],
]
const assertRealmGuards = code => {
  for (const [re, label] of REQUIRED_MARKERS) {
    if (!re.test(code)) throw new Error('构建护栏失败（缺 Task 2 消费入口）: ' + label)
  }
  for (const [re, label] of FORBIDDEN_INLINE) {
    if (re.test(code)) throw new Error('构建护栏失败（宿主模块入了 realm）: ' + label)
  }
}

const main = () => {
  const argv = process.argv.slice(2)
  const outIdx = argv.indexOf('--out')
  const outPath = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : DEFAULT_OUT
  const checkOnly = argv.includes('--check-only')
  const code = build()
  assertRealmGuards(code)
  syntaxGate(code)
  if (checkOnly) {
    console.log('build check-only OK：模板+模块可生成语法合法产物（' + code.split('\n').length + ' 行），未写盘')
    return
  }
  fs.writeFileSync(outPath, code)
  console.log('built → ' + outPath + '（' + code.split('\n').length + ' 行）')
}

// ─── 语法门（9/19 根因修复，与 Node 版本解耦）───
// 产物语法 = 模板唯一顶层 export（meta）+ 顶层 await + 顶层 return 的混合体。这种混合在 ESM/CJS
// 任一解析模式下都非法（export 仅 ESM、return 仅函数体、await 仅 ESM 或 async 函数体），node --check
// 能过纯靠旧版 Node 的宽松解析——26.0.0 → 26.9.0 升级（9/19 brew）后即全线崩（Illegal return statement）。
// 根因修复：check 前做确定性变换，把产物显式归一到「async 函数体」语法再校验——
//   ① 断言顶层 export 有且仅有一个、且就是模板 meta 标记（新形态 export 一律构建失败，防止变换静默漏剥）；
//   ② 剥该 export + 整体包进 async function（return/await 皆合法）；
//   ③ node --check 变换后文本：纯函数体、无 export → 与模块检测/镜像 package.json type 完全无关。
// 护栏强度不降：作用域重名、token 级语法错在函数体内照样抛；变换前提本身是断言。
// 运行时（Workflow harness 以函数体语义加载产物）与 build.test.mjs 的 new Function 探针同构，故此变换
// 校验的就是真实执行语法。
const TEMPLATE_EXPORT_DECL = 'export const meta = {'
const syntaxGate = code => {
  const exportLines = code.match(/^export[^\n]*/gm) || []
  if (exportLines.length !== 1 || exportLines[0] !== TEMPLATE_EXPORT_DECL) {
    throw new Error('产物顶层 export 契约被破坏（须且仅须一行 "' + TEMPLATE_EXPORT_DECL + '"），实际：\n  ' + exportLines.join('\n  '))
  }
  const transformed = 'async function __syntaxGate__(args) {\n' + code.replace(TEMPLATE_EXPORT_DECL, 'const meta = {') + '\n}\n'
  const tmp = path.join(os.tmpdir(), 'ai-daily-syntaxcheck-' + process.pid + '.js')
  fs.writeFileSync(tmp, transformed)
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
  } catch (e) {
    throw new Error('产物语法校验失败（async 函数体归一后）：\n' + (e.stderr || e.message))
  } finally {
    try { fs.unlinkSync(tmp) } catch (_) { /* noop */ }
  }
}
main()
