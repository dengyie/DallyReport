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
const MODULES = ['url-polyfill', 'date-utils', 'schemas', 'boards', 'dedup', 'budget', 'wallclock', 'ladder', 'fallback', 'prompts', 'render-md', 'cluster', 'linuxdo']

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
  // 产物是混合语法：含 export（ESM 词法）+ 顶层 return（仅 CJS 合法）。严格 --check 两端都判 syntax error，
  // 唯一能过的是"无 package.json 的 .js"——Node 走宽松 CJS、export 降级为 warning、return 合法 → exit 0。
  // 但镜像仓库根 package.json 是 "type":"module"，产物旁写 .js 会继承 ESM → 顶层 return 判 illegal → build 崩。
  // 解法：tmp 写 os.tmpdir()（系统临时目录，无 package.json 干扰）+ .js 后缀，两端都 CJS 宽松判定；check 过再写回 outPath。
  // 2026-08-22 第二十项同步时镜像 build 崩即此因（旧版 tmp=outPath+'.buildtmp.js' 继承了镜像 type:module）。
  const tmp = path.join(os.tmpdir(), 'ai-daily-buildtmp-' + process.pid + '.js')
  fs.writeFileSync(tmp, code)
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
  } catch (e) {
    fs.unlinkSync(tmp)
    throw new Error('产物 node --check 失败：\n' + (e.stderr || e.message))
  }
  if (checkOnly) {
    fs.unlinkSync(tmp)
    console.log('build check-only OK：模板+模块可生成语法合法产物（' + code.split('\n').length + ' 行），未写盘')
    return
  }
  fs.writeFileSync(outPath, code)
  fs.unlinkSync(tmp)
  console.log('built → ' + outPath + '（' + code.split('\n').length + ' 行）')
}
main()
