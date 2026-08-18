#!/usr/bin/env node
// ai-daily workflow 构建器：模块真源（scripts/ai-daily/*.mjs）inline 进模板 → 自包含 workflow 产物。
// workflow realm 无 fs/模块解析，必须单文件自包含——本脚本是唯一既让逻辑进 node:test、又不破坏该约束的形态。
//
// 用法：node scripts/ai-daily/build.mjs [--out <path>] [--check-only]
// 护栏：①剥 export/import 后 inline；②产物 node --check；③占位符零残留断言。任一失败不出产物。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, 'ai-daily.template.js')
const DEFAULT_OUT = path.resolve(HERE, '../../.claude/workflows/ai-daily.js')

// inline 顺序即依赖序：date-utils 的 normURL 被 boards 的 GROUPS_RAW 闭包引用，必须在 boards 前。
const MODULES = ['date-utils', 'schemas', 'boards', 'dedup', 'budget', 'prompts', 'render-md']

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

const main = () => {
  const argv = process.argv.slice(2)
  const outIdx = argv.indexOf('--out')
  const outPath = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : DEFAULT_OUT
  const checkOnly = argv.includes('--check-only')
  const code = build()
  const tmp = outPath + '.buildtmp.js'  // 以 .js 结尾：本仓库无 type:module，.js 走 CJS 模式，顶层 return/export 合法（与真产物同判定）
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
  fs.renameSync(tmp, outPath)
  console.log('built → ' + outPath + '（' + code.split('\n').length + ' 行）')
}
main()
