// finalize — 确定性落盘：把 workflow result（含 payloads.{claims,sources,meta,md}）写到 outDir/**。
//
// 背景（8/22 第十九项）：workflow realm 无 fs/模块解析（build.mjs 护栏，单文件自包含），
//   所以 workflow 只 return payloads、不写盘——落盘此前依赖编排器手工用 Write 工具逐字节执行（SKILL.md 第 5 步）。
//   手工环节一旦被跳过，产物就不落盘（8/21 直跑 Workflow 工具即触发）。
// 修复：把"落盘"提升为确定性 Node 命令，可一键重放、可单测、不依赖编排器记得该动什么。
//
// 用法：
//   node scripts/ai-daily/finalize.mjs <result-path> [--out <dir>]
//   - <result-path>：workflow 返回体（task result / 自定义 JSON，含顶层 { result:{ payloads } } 或直接 { payloads }）
//   - --out <dir>：覆盖 outDir（默认取 result.outDir 或 result.result.outDir）
// 行为：逐字节写 4 文件到 outDir/**，缺任一字段即报错非 0 退出；写成功打印每个文件字节数。
//
// CLI（本人直接可用），也可作为函数 import 进 node:test / 编排器复用（finalizePayloads）。
import fs from 'node:fs'
import path from 'node:path'

/**
 * 从 workflow result 规范化出 payloads 与 outDir。
 * @param {object} obj 已 parse 的 result 对象（可能带顶层 {result:{...}} 包装）
 * @returns {{ payloads:{claims:string,sources:string,meta:string,md:string}, outDir:string, date:string }}
 * @throws {Error} 缺 outDir / payloads / 任一 payload 字段
 */
export const extractPayloads = obj => {
  const r = (obj && typeof obj === 'object' && obj.result && typeof obj.result === 'object') ? obj.result : obj
  const outDir = (r && r.outDir) || (obj && obj.outDir)
  if (!outDir || typeof outDir !== 'string') throw new Error('finalize: missing result.outDir (absolute path required)')
  const p = r && r.payloads
  if (!p || typeof p !== 'object') throw new Error('finalize: missing payloads object')
  const need = ['claims', 'sources', 'meta', 'md']
  for (const k of need) {
    if (typeof p[k] !== 'string') throw new Error(`finalize: payloads.${k} must be a string`)
  }
  const date = (r && r.date) || null
  if (!date || typeof date !== 'string') throw new Error('finalize: missing result.date (YYYY-MM-DD string required)')
  return { payloads: p, outDir, date }
}

const ensure = {
  dir(d) { fs.mkdirSync(d, { recursive: true }) },
}

/**
 * 把 payloads 逐字节写盘（保真：不 re-stringify；claims 已是 JSON.stringify 产物）。
 * @param {{payloads:{claims:string,sources:string,meta:string,md:string}, outDir:string, date?:string}} spec
 * @returns {string[]} 已写文件绝对路径列表
 */
export const finalizePayloads = ({ payloads, outDir, date }) => {
  ensure.dir(outDir)
  const written = []
  const write = (name, content) => {
    const fp = path.join(outDir, name)
    fs.writeFileSync(fp, content)
    written.push(fp)
  }
  write(`${date}.verified-claims.json`, payloads.claims)
  write(`${date}.sources.json`, payloads.sources)
  write(`${date}.meta.json`, payloads.meta)
  write(`${date}-ai日报.md`, payloads.md)
  return written
}

// ─── CLI ───
const args = process.argv.slice(2)
const resultPath = args.find(a => !a.startsWith('--'))
if (resultPath) {
  const outOverride = args.includes('--out') ? args[args.indexOf('--out') + 1] : null
  const raw = fs.readFileSync(resultPath, 'utf8')
  const obj = JSON.parse(raw)
  const spec = extractPayloads(obj)
  if (outOverride) spec.outDir = outOverride
  const written = finalizePayloads(spec)
  for (const fp of written) console.log(`WROTE ${fp} (${fs.statSync(fp).size} bytes)`)
} else {
  // import 方（测试/编排器）不自动执行 CLI；仅当直接运行本文件时落盘。
  // no-op：本模块可被 import 后调用 finalizePayloads。
}