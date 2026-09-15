#!/usr/bin/env node
// ai-daily poster generator — creates AI.png for today's ai-daily report
// Reads <outDir>/<date>.verified-claims.json (or <date>.sources.json) and invokes DallyReport's image-gen.
//
// 跨仓依赖解析：本文件在两仓各有一份镜像（obsidian/scripts/ai-daily 与 DallyReport/ai-daily/scripts/ai-daily），
// 向上到 DallyReport 仓根的层数不同（obsidian 3 级到 claude-project 再进 DallyReport；镜像 3 级即 DallyReport 根）。
// 静态相对路径只能在一种布局下成立 → 候选路径探测 + 动态 import：
//   1. <本目录>/../../../DallyReport/src（obsidian 布局）
//   2. <本目录>/../../../src（镜像布局：本文件已在 DallyReport 仓内）
// 探测不到 image-gen.mjs → runPoster 返回 {ok:false,reason:'deps_unavailable'}（海报跳过，绝不炸 finalize 的账本记账）。
//
// 凭证解析：生图凭证在 DallyReport/.env（GROK_API_KEY 等），从探测到的仓根加载。
// 只补 process.env 缺键、不覆盖已有值（幂等）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { isCliMain } from './cli-main.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 候选 DallyReport 仓根（obsidian 布局在前，镜像布局在后），首个含 src/image-gen.mjs 的胜出。 */
export function resolveDallyReportRoot(fsImpl = fs) {
  for (const rel of ['../../../DallyReport', '../../..']) {
    const root = path.resolve(HERE, rel)
    if (fsImpl.existsSync(path.join(root, 'src', 'image-gen.mjs'))) return root
  }
  return null
}

/** 解析 env 文件进 env 对象：`KEY=VALUE`，跳过注释/空行，剥引号。已存在的键不覆盖（幂等）。 */
export function loadEnvFile(envPath, env = process.env, readImpl = fs) {
  if (!readImpl.existsSync(envPath)) return 0
  const content = readImpl.readFileSync(envPath, 'utf8')
  let set = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx > 0) {
      const k = trimmed.slice(0, idx).trim()
      let v = trimmed.slice(idx + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (k && env[k] === undefined) { env[k] = v; set++ }
    }
  }
  return set
}

/** 按需加载 DallyReport 生图依赖（动态 import，两布局探测）。失败 → null（调用方诚实跳过）。 */
async function loadDeps(root, fsImpl) {
  if (!root) return null
  try {
    const [imageGen, configMod] = await Promise.all([
      import(`file://${path.join(root, 'src', 'image-gen.mjs')}`),
      import(`file://${path.join(root, 'src', 'config.mjs')}`),
    ])
    return { generateAiPoster: imageGen.generateAiPoster, loadConfig: configMod.loadConfig, loadEnv: loadEnvFile, fs: fsImpl }
  } catch (e) {
    console.error(`POSTER-WARN 加载 DallyReport 生图依赖失败: ${e && e.message}`)
    return null
  }
}

/**
 * 生成当日海报并把 `![[AI.png]]` 嵌入日报 md。失败一律返回 {ok:false}（不 throw 给 finalize）。
 * deps 可注入（generateAiPoster / loadConfig / loadEnv / fs）——成功路径测试不烧生图 API。
 * @returns {Promise<{ok:true,file:string}|{ok:false,reason?:string,error?:object,summary?:string}>}
 */
export async function runPoster(outDir, date, deps = {}) {
  const fsImpl = deps.fs || fs
  const root = deps.dallyReportRoot !== undefined ? deps.dallyReportRoot : resolveDallyReportRoot(fsImpl)
  const loaded = deps.generateAiPoster
    ? { generateAiPoster: deps.generateAiPoster, loadConfig: deps.loadConfig || loadEnvOnlyConfig, loadEnv: deps.loadEnv || loadEnvFile, fs: fsImpl }
    : await loadDeps(root, fsImpl)
  if (!loaded) return { ok: false, reason: 'deps_unavailable' }

  loaded.loadEnv(path.join(root || DALLYREPORT_FALLBACK_ROOT, '.env'), process.env, fsImpl)

  const claimsPath = path.join(outDir, `${date}.verified-claims.json`)
  const sourcesPath = path.join(outDir, `${date}.sources.json`)
  const mdPath = path.join(outDir, `${date}-ai日报.md`)

  let headlines = []
  if (fsImpl.existsSync(claimsPath)) {
    try {
      const claimsObj = JSON.parse(fsImpl.readFileSync(claimsPath, 'utf8'))
      const confirmed = claimsObj.confirmed || []
      for (const c of confirmed) {
        if (c.claim && !c.claim.includes('http')) {
          headlines.push({ title: c.claim, provider: 'ai-daily' })
        }
      }
    } catch (e) {
      console.error(`POSTER-WARN read claims: ${e.message}`)
    }
  }

  if (!headlines.length && fsImpl.existsSync(sourcesPath)) {
    try {
      const srcObj = JSON.parse(fsImpl.readFileSync(sourcesPath, 'utf8'))
      const srcs = srcObj.sources || []
      for (const s of srcs) {
        if (s.title) headlines.push({ title: s.title, provider: s.board || 'ai-daily' })
      }
    } catch (e) {
      console.error(`POSTER-WARN read sources: ${e.message}`)
    }
  }

  if (!headlines.length) {
    console.log(`POSTER-SKIP no headlines found for ${date}`)
    return { ok: false, reason: 'no_headlines' }
  }

  const cfg = loaded.loadConfig({ date })
  // 生产布局 outDir = <obsidianDir>/<date>（image-gen 写 path.join(obsidianDir, date)/AI.png）。
  // outDir 基名即 date 时 obsidianDir = 其父目录；否则（tmp 测试/任意命名 outDir）直接用 outDir 本身，
  // 让 AI.png 与日报落在同一目录——拼回 path.join(obsidianDir, date) 恒等于或包含 outDir 的语义保住。
  const resolvedOut = path.resolve(outDir)
  cfg.obsidianDir = path.basename(resolvedOut) === date ? path.dirname(resolvedOut) : resolvedOut

  console.log(`POSTER-GEN starting AI poster with ${headlines.length} headlines for ${date}...`)
  try {
    const res = await loaded.generateAiPoster(cfg, headlines)
    console.log(`POSTER-RESULT ok=${res.ok} summary=${res.summary}`)
    if (res.ok && res.file) {
      // Embed ![[AI.png]] into markdown if not already embedded
      if (fsImpl.existsSync(mdPath)) {
        let md = fsImpl.readFileSync(mdPath, 'utf8')
        if (!md.includes('![[AI.png]]')) {
          // Place embed right after main header（文件首行或后续行都命中）
          const replaced = md.replace(/(^|\n)(# 🤖 AI 日报[^\n]*\n)/, '$1$2\n![[AI.png]]\n')
          if (replaced !== md) {
            md = replaced
          } else {
            md = `![[AI.png]]\n\n${md}`
          }
          fsImpl.writeFileSync(mdPath, md, 'utf8')
          console.log(`POSTER-EMBED updated ${mdPath} with ![[AI.png]]`)
        }
      }
    }
    return res
  } catch (e) {
    console.error(`POSTER-ERROR ${e.message}`)
    return { ok: false, error: e }
  }
}

// 注入 generateAiPoster 但未注入 loadConfig 时的轻量 fallback：只要 date——
// obsidianDir 由 runPoster 主体覆盖，prompt/ref 路径走默认值（与 loadConfig 等价的行为子集）。
const loadEnvOnlyConfig = ({ date }) => ({ date })

// CLI 入口：成功 exit 0；未生成（no_headlines / 生图失败）stderr 诊断 + exit 1。
// finalize 走 import 调 runPoster，不经此入口，不受退出码语义影响。
if (isCliMain(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2)
  const today = new Date().toISOString().slice(0, 10)
  const outDir = args[0] || path.join(os.homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport', today)
  const date = args[1] || path.basename(outDir)
  runPoster(outDir, date).then(res => {
    if (!res || res.ok !== true) {
      const why = res && (res.error && res.error.message || res.reason || res.summary) || 'unknown'
      process.stderr.write(`generate-poster: 未生成海报: ${why}\n`)
      process.exit(1)
    }
  }).catch(e => { console.error(e); process.exit(1) })
}
