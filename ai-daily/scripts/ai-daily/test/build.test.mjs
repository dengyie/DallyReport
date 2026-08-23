// build.mjs 产物级测试（F1 Critical）——build.mjs 从未被测试覆盖。
// 作用：把 scripts/ai-daily/*.mjs 源模块 inline 进 .claude/workflows/ai-daily.js 自包含产物。
//
// 为什么 spawn CLI 而非 import：
//   build.mjs 是"脚本即入口"形态——文件底部无条件调用 main()，main() 默认把产物写盘到 DEFAULT_OUT。
//   直接 import build.mjs 会触发 main() 写盘（本会话实测已踩中一次，需 git checkout 恢复真实产物），
//   且 build.mjs 不导出 build()/MODULES。故本测试只 spawn 子进程，且产物一律走 os.tmpdir() 临时文件，
//   零副作用、绝不覆写 .claude/workflows/ai-daily.js（C 全局约束，CI 下可靠）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUILD = path.join(HERE, '..', 'build.mjs')
// 与 build.mjs 的 MODULES 常量逐字一致：url-polyfill 最先（注入 globalThis.URL），linuxdo 最后（零依赖纯导出）。
const MODULES = ['url-polyfill', 'date-utils', 'schemas', 'boards', 'dedup', 'budget', 'fallback', 'prompts', 'render-md', 'cluster', 'linuxdo']
// 每模块一个"关键标识"：命即证模块真的被 inline 进产物（若占位符替换丢模块/依赖序错，函数名/常量必缺）。
// 全部取自各 .mjs 导出名（grep 实证），且为该模块唯一出现于产物中的标识。
const MARKERS = {
  'url-polyfill': 'installUrlPolyfill',
  'date-utils': 'normURL',
  schemas: 'HARVEST_SCHEMA',
  boards: 'KNOWN_MAJOR_OUT',
  dedup: 'allocateFetchBudget',
  budget: 'computePhaseDeadlines',
  fallback: 'buildFallback',
  prompts: 'reportPrompt',
  'render-md': 'buildCitationMap',
  cluster: 'clusterTokenize',
  linuxdo: 'fetchLinuxDoNews34',
}
// 模板的唯一顶层 export（bundle 顶层 decl）；剥离后 new Function 才能编译合法的脚本体。
const TEMPLATE_EXPORT = 'export const meta = {'
// 产物是混合语法：含 export（ESM 词法）+ 顶层 return（仅 CJS 合法）。build.mjs 自身用 node --check
// 兜底，这里用 new Function 双保险做"作用域级"语法守卫：剥离唯一 export 后，
// 若模块与模块/模板存在作用域重名（对照 8/23 C1 tokenize 冲突：cluster 闭包函数与模板 builder 助手撞名），
// new Function 会抛 scoped SyntaxError，让 token 级 bug 无法仅仅靠 CJS 宽松判定掩盖。
test('F1 build --check-only 退出码 0 且 stdout 含成功标识（不落盘）', () => {
  const r = runBuild()
  assert.ok(r.ok, `build --check-only 应 exit 0（stderr: ${r.stderr}）`)
  assert.match(r.stdout, /build check-only OK/, 'stdout 须含成功标识')
  assert.match(r.stdout, /未写盘/, '须明确未落盘（C：不覆写真实产物）')
})

test('F1 --check-only 不改动真实产物文件（无副作用守卫）', () => {
  const product = path.resolve(HERE, '../../.claude/workflows/ai-daily.js')
  const before = fs.existsSync(product) ? fs.readFileSync(product, 'utf8') : null
  runBuild()
  const after = fs.existsSync(product) ? fs.readFileSync(product, 'utf8') : null
  assert.equal(after, before, '--check-only 不得改写真实产物文件')
})

// 产物级断言：用 --out 把产物写进 os.tmpdir（仿真 build 内部同样走系统临时目录），读回断言后即删。
test('F1 产物包含全部 11 个 MODULES 的关键标识（无模块丢失）', () => {
  const code = readBuiltProduct()
  for (const m of MODULES) {
    assert.ok(code.includes(MARKERS[m]), `产物应含模块 ${m} 的标识符 ${MARKERS[m]}`)
  }
})

test('F1 产物无占位符残留（@inline 标记零）', () => {
  const code = readBuiltProduct()
  assert.equal((code.match(/@inline/g) || []).length, 0, '产物内不应残留 @inline 占位标记')
  assert.ok(!code.includes('/* @inline:'), '不应有未替换的占位符注释')
})

test('F1 产物非空且规模合理（>=100K 字符，防 build 静默退化）', () => {
  const code = readBuiltProduct()
  assert.ok(code.length >= 100_000, `产物字符数应 >=100K（含多字节中文，字节数 ~130K+），实际 ${code.length}`)
})

test('F1 产物 new Function 无顶层 SyntaxError（作用域冲突防线）', () => {
  const code = readBuiltProduct()
  assert.ok(code.includes(TEMPLATE_EXPORT), '产物须含模板顶层 export const meta')
  const withoutExport = code.replace(TEMPLATE_EXPORT, 'const meta = {') // 全产物唯一顶层 export，字面量替换
  // 产物还含若干顶层"const x = await ..."（CJS 允许的顶层 await），非 async 函数体内非法。
  // 外包一层 async function 使二者（export→裸 decl + await-in-const）皆合法，专门暴露"作用域级"语法冲突：
  //   ①模块/模板重名 const/函数 → 'Identifier ... has already been declared'（对照 8/23 C1 tokenize 冲突真源）
  //   ②tokenize 拼接残留/half-statement → Unexpected token/number
  // 任一命中即红，token 级 bug 无法靠 CJS 宽松判定掩盖。
  const wrapped = 'async function __probe() {' + '\n' + withoutExport + '\n' + '}'
  assert.doesNotThrow(() => new Function(wrapped), '剥离顶层 export 并外包 async 函数后 new Function 不得抛 SyntaxError')
})

const runBuild = () => {
  try {
    const out = execFileSync(process.execPath, [BUILD, '--check-only'], { cwd: HERE, stdio: 'pipe' })
    return { ok: true, stdout: out.toString() }
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
  }
}

// 产物读回辅助：写 os.tmpdir()（系统临时目录，无 package.json 干扰——同 build 内部 node --check 的判断口径），
// 编译/断言完毕即删除，全程不触碰仓库内真实产物。
function readBuiltProduct() {
  const tmp = path.join(os.tmpdir(), 'ai-daily-build-test-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.js')
  try {
    execFileSync(process.execPath, [BUILD, '--out', tmp], { cwd: HERE, stdio: 'pipe' })
    return fs.readFileSync(tmp, 'utf8')
  } finally {
    try { fs.unlinkSync(tmp) } catch (_) { /* noop */ }
  }
}