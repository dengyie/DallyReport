// finalize — 确定性落盘：把 workflow result（含 payloads.{claims,sources,meta,md}）写到 outDir/**。
//
// 背景（8/22 第十九项）：workflow realm 无 fs/模块解析（build.mjs 护栏，单文件自包含），
//   所以 workflow 只 return payloads、不写盘——落盘此前依赖编排器手工用 Write 工具逐字节执行（SKILL.md 第 5 步）。
//   手工环节一旦被跳过，产物就不落盘（8/21 直跑 Workflow 工具即触发）。
// 修复：把"落盘"提升为确定性 Node 命令，可一键重放、可单测、不依赖编排器记得该动什么。
//
// 用法：
//   node scripts/ai-daily/finalize.mjs <result-path> [--out <dir>]
//   - <result-path>：workflow 返回的（task 返回 / 自定义 JSON，含顶层 { result:{ payloads } } 或直接 { payloads }）
//   - --out <dir>：覆盖 outDir（默认取 result.outDir 或 result.result.outDir）
// 行为：逐字节写 4 文件到 outDir/**，缺任一字段即报错非 0 退出；写成功打印每个文件字节数。
// 8/25：outDir 支持 `~` 展开（Skill 示例曾用 `~`，finalize 不展开会写坏路径）。
//
// CLI（本人直接可用），也可作为函数 import 进 node:test / 编排器复现（finalizePayloads）。
//
// 9/13 跨天账本（记录端）：写完 4 产物后把 confirmed 条目追加进已报道账本（ledger.mjs 消费端过滤）。
//   - 账本路径默认 $HOME/.ai-daily/published-ledger.json——放 HOME 不放 iCloud：launchd TCC 读不了
//     Mobile Documents（8/31 P4 实证），编排器要 Read 它注入 args.reportedLedger。
//   - 烟测隔离守卫：仅当 outDir 在生产 DallyReport 前缀下（或显式传 --ledger）才记账；
//     /tmp 烟测 outDir 不污染生产账本（LEDGER-SKIP 如实打点）。
//   - 只记 confirmed[]（真正进正文的条目，含 [窗口外·重大] window='major-out'）；outOfWindow[] 只进
//     「窗口外参考」节不算成稿——记了会把次日窗口内的正当报道误杀。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { makeLedgerEntry, pruneLedger } from './ledger.mjs'
import { normURL } from './date-utils.mjs'
import { runPoster } from './generate-poster.mjs'

/** 展开任意 `~` 前缀为用户 home（`~/...` → `${os.homedir()}/...`）。只处理开头为 `~/` 的。 */
export const expand = p => {
  if (typeof p !== 'string' || !p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * 从 workflow result 规范化出 payloads 与 outDir。
 * @param {object} obj 已 parse 的 result 对象（可能带顶层 {result:{...}} 包装）
 * @returns {{ payloads:{claims:string,sources:string,meta:string,md:string}, outDir:string, date:string }}
 * @throws {Error} 缺 outDir / payloads / 任一 payload 字段
 */
export const extractPayloads = obj => {
  const r = (obj && typeof obj === 'object' && obj.result && typeof obj.result === 'object') ? obj.result : obj
  const outDir = (r && r.outDir) || (obj && obj.outDir)
  if (!outDir || typeof outDir !== 'string') throw new Error('finalize: missing result.outDir (absolute or ~-prefixed path required)')
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

// ─── 9/13 跨天账本（记录端）───
export const DEFAULT_LEDGER = path.join(os.homedir(), '.ai-daily', 'published-ledger.json')
// 生产 outDir 前缀：只有写进该前缀下的 run 才自动记账（烟测 /tmp 隔离）。
export const PROD_DALLYREPORT_PREFIX = path.join(os.homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport')

/** 生产 outDir 判定（可注入 prefix，测试不得在真实 iCloud 目录 mkdtemp）。 */
export const isProdOutDir = (outDir, prefix = PROD_DALLYREPORT_PREFIX) => {
  const resolvedOut = path.resolve(expand(outDir))
  const resolvedPrefix = path.resolve(prefix)
  return resolvedOut === resolvedPrefix || resolvedOut.startsWith(resolvedPrefix + path.sep)
}

/**
 * 从 claims payload 提取账本条目（confirmed 全记；major = window==='major-out'）。
 * @param {string} claimsJson claims payload 字符串
 * @param {string} date YYYY-MM-DD（条目 day）
 * @returns {object[]} ledger entry 数组（makeLedgerEntry shape）
 */
export const ledgerEntriesFromClaims = (claimsJson, date) => {
  const parsed = JSON.parse(claimsJson)
  const confirmed = (parsed && Array.isArray(parsed.confirmed)) ? parsed.confirmed : []
  return confirmed.map(c => makeLedgerEntry(date, c.source || '', c.claim || '', c.window === 'major-out'))
}

/**
 * 合并追加账本并原子写盘。去重 key = normURL(url) | '|' | tokens 排序串（同 URL 多 claim 保留各自指纹）。
 * @returns {{ ledgerPath: string, total: number, added: number }}
 */
export const recordLedger = (ledgerPath, entries, date) => {
  let existing = []
  if (fs.existsSync(ledgerPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
      if (Array.isArray(raw)) existing = raw
    } catch { /* 账本损坏 → 重建（日志端可见 added 偏大） */ }
  }
  existing = pruneLedger(existing, date)
  const seen = new Map(existing.map(e => [`${e.url ? normURL(e.url) : ''}|${[...(e.tokens || [])].sort().join(',')}`, true]))
  let added = 0
  for (const e of entries) {
    const key = `${e.url ? normURL(e.url) : ''}|${[...(e.tokens || [])].sort().join(',')}`
    if (seen.has(key)) continue
    seen.set(key, true)
    existing.push(e)
    added++
  }
  ensure.dir(path.dirname(ledgerPath))
  const tmp = ledgerPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 1))
  fs.renameSync(tmp, ledgerPath)
  return { ledgerPath, total: existing.length, added }
}

/**
 * 把 payloads 逐字节写盘（保真：不 re-stringify；claims 已是 JSON.stringify 产物）。
 * @param {{payloads:{claims:string,sources:string,meta:string,md:string}, outDir:string, date?:string}} spec
 * @returns {string[]} 已写文件绝对路径列表
 */
export const finalizePayloads = ({ payloads, outDir, date }) => {
  // 8/25: 展开放在写入边界——一条入口同时覆盖 workflow outDir、CLI --out、import 直达（避免 `~/` 写坏字面目录）。
  outDir = expand(outDir)
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
  const ledgerOverride = args.includes('--ledger') ? args[args.indexOf('--ledger') + 1] : null
  const raw = fs.readFileSync(resultPath, 'utf8')
  const obj = JSON.parse(raw)
  const spec = extractPayloads(obj)
  if (outOverride) spec.outDir = outOverride
  const written = finalizePayloads(spec)
  for (const fp of written) console.log(`WROTE ${fp} (${fs.statSync(fp).size} bytes)`)

  // 9/13 跨天账本：仅生产 outDir（或显式 --ledger）记账；烟测 /tmp 隔离。失败只告警不回滚产物。
  const resolvedOut = path.resolve(expand(spec.outDir))
  const isProd = isProdOutDir(spec.outDir)
  const ledgerPath = ledgerOverride || DEFAULT_LEDGER
  if (!isProd && !ledgerOverride) {
    console.log(`LEDGER-SKIP non-production outDir（${resolvedOut}）不在 DallyReport 前缀下；烟测不记账，如需强制用 --ledger`)
  } else {
    try {
      const entries = ledgerEntriesFromClaims(spec.payloads.claims, spec.date)
      const { total, added } = recordLedger(ledgerPath, entries, spec.date)
      console.log(`LEDGER-RECORDED ${ledgerPath} total=${total} added=${added}`)
    } catch (e) {
      console.error(`LEDGER-WARN 记账失败（产物已落盘不受影响）: ${e && e.message}`)
    }

    // P4: 统一产物交付与高清长图渲染闭环
    try {
      await runPoster(resolvedOut, spec.date)
    } catch (e) {
      console.error(`POSTER-WARN 海报生成失败（产物已落盘不受影响）: ${e && e.message}`)
    }
  }
} else {
  // import 方（测试/编排器）不自动执行 CLI；仅当直接运行本文件时落盘。
  // no-op：本模块可被 import 后调用 finalizePayloads。
}