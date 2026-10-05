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
import { isJunkClaim } from './claim-gate.mjs'
import { normURL } from './date-utils.mjs'
import { runPoster } from './generate-poster.mjs'
import { isCliMain } from './cli-main.mjs'
import { WIN_PROD_DALLYREPORT_ROOT, macProdDallyReportRoot } from './host-paths.mjs'

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
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('finalize: missing/invalid result.date (YYYY-MM-DD string required), got: ' + JSON.stringify(date))
  }
  return { payloads: p, outDir, date }
}

const ensure = {
  dir(d) { fs.mkdirSync(d, { recursive: true }) },
}

// ─── 9/13 跨天账本（记录端）───
export const DEFAULT_LEDGER = path.join(os.homedir(), '.ai-daily', 'published-ledger.json')
// 生产 outDir 前缀：只有写进任一前缀下的 run 才自动记账（烟测 /tmp 隔离）。
// P0（10-03 review 实证）：旧版只有 Mac iCloud 单前缀——Windows 迁移后生产 outDir 是
// E:/profile/note/note/AI/DallyReport，isProdOutDir 恒 false → 生产 LEDGER-SKIP + poster 永不跑。
// F-1（10-04 review）：生产根字面量收敛到 host-paths 单一真源——Windows 生产根置首 + Mac iCloud
// 兜底（历史对账），与 artifact-check / generate-poster 同源。
// review S-⑤：AI_DAILY_PROD_PREFIX 惰性读取（isProdOutDir 每次调用组装）——不再在模块加载期
// 突变导出数组，import 时序不再影响判定。
export const PROD_DALLYREPORT_PREFIXES = [WIN_PROD_DALLYREPORT_ROOT, macProdDallyReportRoot()]
const _prodPrefixes = () => (
  process.env.AI_DAILY_PROD_PREFIX
    ? [process.env.AI_DAILY_PROD_PREFIX, ...PROD_DALLYREPORT_PREFIXES]
    : PROD_DALLYREPORT_PREFIXES
)

/** 生产 outDir 判定（prefix 可注入：字符串或前缀数组；缺省 = 环境变量覆盖 + 内置列表；测试不得在真实生产目录 mkdtemp）。 */
export const isProdOutDir = (outDir, prefix) => {
  const prefixes = prefix ? (Array.isArray(prefix) ? prefix : [prefix]) : _prodPrefixes()
  const resolvedOut = path.resolve(expand(outDir))
  return prefixes.some(p => {
    const resolvedPrefix = path.resolve(expand(p))
    return resolvedOut === resolvedPrefix || resolvedOut.startsWith(resolvedPrefix + path.sep)
  })
}

/**
 * 从 claims payload 提取账本条目（confirmed 全记；major = window==='major-out'）。
 * 10-05 P2 记录端兜底：confirmed 已过 workflow 声明质量门，但账本是 60 天跨天状态——任何
 * 绕过路径（历史回归/手工构造 result）写入的垃圾条目，次日都会经昨日话题追踪渗入报告。
 * 与 ledger.mjs parseReportedLedger 的消费端过滤构成进出两端防线。
 * @param {string} claimsJson claims payload 字符串
 * @param {string} date YYYY-MM-DD（条目 day）
 * @returns {object[]} ledger entry 数组（makeLedgerEntry shape）
 */
export const ledgerEntriesFromClaims = (claimsJson, date) => {
  const parsed = JSON.parse(claimsJson)
  const confirmed = (parsed && Array.isArray(parsed.confirmed)) ? parsed.confirmed : []
  return confirmed
    .filter(c => !isJunkClaim(c))
    .map(c => makeLedgerEntry(date, c.source || '', c.claim || '', c.window === 'major-out'))
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
    } catch (e) {
      // 9/19 F2：账本损坏不再静默重建——先备份原文件供恢复 + stderr 告警。
      // 旧行为只靠「added 偏大」间接可察，60 天历史无声丢失 = 次日跨天去重整体失效且无从感知。
      try { fs.copyFileSync(ledgerPath, ledgerPath + '.corrupt') } catch { /* 备份失败不阻塞重建 */ }
      console.error(`LEDGER-WARN 账本损坏已备份至 ${ledgerPath}.corrupt 并重建: ${e && e.message}`)
    }
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
 * runner 起始 epoch（AI_DAILY_RUN_START_EPOCH，run-daily.sh/win.sh export）→ 至今秒数。
 * env 缺失 / 非法 / 越界（≤0 或 >24h，手工跑或脏值）→ null（fail-open 不回填）。
 * 10-05 P1 根因修复的宿主半边：workflow realm 无时钟（Date 静态拒绝），meta.wallclock 的
 * raw/calibrated 只是 workflow 内段读数（10-05 实测 realm 2383s vs 真实 3661s，探针换档的
 * 25 分钟完全不可见）；真实总墙钟只有 runner（起始）+ 宿主（此刻）能测。
 */
export const realWallSecondsFromEnv = envVal => {
  const start = Number(envVal)
  if (!Number.isFinite(start) || start <= 0) return null
  const s = Math.round(Date.now() / 1000) - start
  return (s > 0 && s <= 86400) ? s : null
}

/**
 * 记账后对**已落盘**的 meta 文件做 tmp+rename 原子 read-modify-write：回写 ledger 记账状态、
 * 本轮实际新增记账条数（ledger_recorded_count，10-05 P3——模板侧 ledger_injected 是注入候选数，
 * 与新增记账数是两回事，不得混用一名）与真实总墙钟 wallclock.real_s（见 realWallSecondsFromEnv）。
 * @returns {boolean} 是否写成功（失败只告警，不影响产物与账本）
 */
export const patchMetaAfterLedger = (metaPath, { ledgerStatus, ledgerPath, ledgerAdded, realS }) => {
  try {
    const metaObj = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    metaObj.ledger_recorded = ledgerStatus
    metaObj.ledger_path = ledgerPath || null
    if (typeof ledgerAdded === 'number') metaObj.ledger_recorded_count = ledgerAdded
    if (typeof realS === 'number' && realS > 0) {
      metaObj.wallclock = Object.assign({}, metaObj.wallclock, { real_s: realS })
    }
    const tmp = metaPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(metaObj, null, 1))
    fs.renameSync(tmp, metaPath)
    return true
  } catch (e) {
    console.error(`LEDGER-WARN meta 回写 ledger_recorded 失败（不影响产物与账本）: ${e && e.message}`)
    return false
  }
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
  // 9/19 F1：四产物与账本一致走 tmp+rename 原子写——旧版直接 writeFileSync，写一半进程被杀/磁盘满
  // 会留下半截 md/claims 且旧文件已被覆盖，产物损坏不可回滚。同目录 rename 原子。
  const write = (name, content) => {
    const fp = path.join(outDir, name)
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, fp)
    written.push(fp)
  }
  write(`${date}.verified-claims.json`, payloads.claims)
  write(`${date}.sources.json`, payloads.sources)
  write(`${date}.meta.json`, payloads.meta)
  write(`${date}-ai日报.md`, payloads.md)
  return written
}

// ─── CLI ───
// F3（10-04 review 根因）：旧版把 CLI 无条件摊在模块顶层——测试/编排器 import 本文件时
// process.argv 仍是宿主进程的 argv，`args.find(非 --)` 会捡到宿主脚本路径 → import 即写盘
// （实证：import-only wrapper 真的落了产物，冒名 host-finalize 的 ob 复现也误触发）；且
// `--out <dir> <result>` 顺序会把 dir 当 result 读 → ENOENT。根因修复：isCliMain 门控
// （与 cli-main.mjs 约定一致：仅直接执行本文件才进 CLI）+ 旗标带值解析（位置参数与旗标
// 值互不污染，顺序无感）。
if (isCliMain(import.meta.url, process.argv[1])) {
  await cliMain()
}
// import 方（测试/编排器）不自动执行 CLI；仅导出 finalizePayloads 等函数供调用。

async function cliMain() {
  const argv = process.argv.slice(2)
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const v = argv[i + 1]
      if (v && !v.startsWith('--')) { flags[a] = v; i++ } else { flags[a] = true }
    } else {
      positional.push(a)
    }
  }
  const flagValue = name => (typeof flags[name] === 'string' ? flags[name] : null)
  const resultPath = positional[0]
  const outOverride = flagValue('--out')
  const ledgerOverride = flagValue('--ledger')
  if (!resultPath) {
    console.error('FINALIZE-FAIL usage: node finalize.mjs <result-path> [--out <dir>] [--ledger <path>]')
    process.exit(1)
  }
  const raw = fs.readFileSync(resultPath, 'utf8')
  const obj = JSON.parse(raw)
  const spec = extractPayloads(obj)
  if (outOverride) spec.outDir = outOverride

  // 9/19 review P2-1 根因回归：**先落盘后记账**。曾短暂改为记账先行——产物写盘失败时账本已含
  // 当日 confirmed 条目，次日硬过滤会把这些新闻压制到 60 天 prune（比旧行为「次日重复」严重）。
  // 顺序恢复后：落盘任一失败 → 记账零污染（exit 非零，编排器如实报 ARTIFACT-FAIL）；
  // 落盘成功 → 记账，失败只告警（旧行为：次日重复、可自愈）。
  // ledger_recorded 旗标的可见性保留：记账后对**已落盘的 meta 文件**做 tmp+rename 原子 read-modify-write。
  const resolvedOut = path.resolve(expand(spec.outDir))
  const isProd = isProdOutDir(spec.outDir)
  const ledgerPath = ledgerOverride || DEFAULT_LEDGER

  const written = finalizePayloads(spec)
  for (const fp of written) console.log(`WROTE ${fp} (${fs.statSync(fp).size} bytes)`)

  let ledgerStatus = 'skipped'
  let ledgerAdded = null
  if (!isProd && !ledgerOverride) {
    console.log(`LEDGER-SKIP non-production outDir（${resolvedOut}）不在 DallyReport 前缀下；烟测不记账，如需强制用 --ledger`)
  } else {
    try {
      const entries = ledgerEntriesFromClaims(spec.payloads.claims, spec.date)
      const { total, added } = recordLedger(ledgerPath, entries, spec.date)
      ledgerStatus = 'recorded'
      ledgerAdded = added
      console.log(`LEDGER-RECORDED ${ledgerPath} total=${total} added=${added}`)
    } catch (e) {
      ledgerStatus = 'failed'
      console.error(`LEDGER-WARN 记账失败（产物已落盘不受影响）: ${e && e.message}`)
    }
  }
  // 真实总墙钟回填（10-05 P1 根因修复）：runner 起始 epoch 经 env 注入（fail-open：手工跑无 env
  // 就不回填），finalize 宿主时钟实测——realm 累加器看不到探针/换档段，见 patchMetaAfterLedger。
  const realS = realWallSecondsFromEnv(process.env.AI_DAILY_RUN_START_EPOCH)
  if (realS != null) console.log(`WALLCLOCK-REAL real=${realS}s（runner 起始 → finalize，宿主实测 → meta.wallclock.real_s）`)
  patchMetaAfterLedger(path.join(expand(spec.outDir), `${spec.date}.meta.json`), {
    ledgerStatus,
    ledgerPath: (!isProd && !ledgerOverride) ? null : ledgerPath,
    ledgerAdded,
    realS,
  })

  // P4: 统一产物交付与高清长图渲染闭环
  if (isProd || ledgerOverride) {
    try {
      await runPoster(resolvedOut, spec.date)
    } catch (e) {
      console.error(`POSTER-WARN 海报生成失败（产物已落盘不受影响）: ${e && e.message}`)
    }
  }
}
