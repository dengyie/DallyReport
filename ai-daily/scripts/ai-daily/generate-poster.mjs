#!/usr/bin/env node
// ai-daily poster generator — creates ai-daily.png (10-06 前 AI.png) for today's ai-daily report
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
import { fileURLToPath } from 'node:url'
import { isCliMain } from './cli-main.mjs'
import { prodDallyReportRoot, localDateStr } from './host-paths.mjs'

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
 * 生成当日海报并把 `![[ai-daily.png]]` 嵌入日报 md。失败一律返回 {ok:false}（不 throw 给 finalize）。
 * deps 可注入（generateAiPoster / loadConfig / loadEnv / fs）——成功路径测试不烧生图 API。
 * @returns {Promise<{ok:true,file:string}|{ok:false,reason?:string,error?:object,summary?:string}>}
 */
// 10-06 产物迁入 Note/AI/DallyReport/（与 DallyReport 主系统同目录）：主系统海报恒名 AI.png，
// ai-daily 海报必须异名防互覆——经主仓 aiPosterFileName 的 config.posterFile 覆盖口生效（生成期即
// 异名，非事后改名：事后改名会先覆盖主系统当天已有海报再搬走）。md 内嵌同步用本常量。
export const POSTER_FILE = 'ai-daily.png'
export const POSTER_EMBED = `![[${POSTER_FILE}]]`

/**
 * 从当天已经生成的 Markdown 日报中提取高质量中文精炼标题与对应摘要。
 * 优先级高于原始 claims / sources：
 *   1. 优先提取 ## 🔥 今日亮点（2~4 条，天然带有精炼短标题与高信息量摘要）
 *   2. 补充提取正文各 ### 板块下的条目（**标题** + 首句/精简摘要），避开待核实/未验证小节
 *   3. 自动去重、去状态标签、去英文从句展开、去 markdown 格式残余，限制标题在 28 字以内
 */
export function isSimilarHeadline(a, b) {
  const normA = String(a || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '')
  const normB = String(b || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '')
  if (!normA || !normB) return false
  if (normA.includes(normB) || normB.includes(normA)) return true

  const wordsA = a.toLowerCase().match(/[a-z0-9]{3,}/g) || []
  const wordsB = new Set(b.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
  for (const w of wordsA) {
    if (['the', 'and', 'for', 'with', 'app', 'pro', 'api', 'model', '2026'].includes(w)) continue
    if (w.length >= 4 && wordsB.has(w) && !['news', 'post', 'tech'].includes(w)) return true
  }

  const cjkA = normA.replace(/[a-z0-9]/g, '')
  const cjkB = normB.replace(/[a-z0-9]/g, '')
  if (cjkA.length >= 4 && cjkB.length >= 4) {
    let bigramHits = 0
    for (let i = 0; i < cjkA.length - 1; i++) {
      const bi = cjkA.slice(i, i + 2)
      if (['据报', '官方', '发布', '推出', '首次', '表示', '称较', '显示'].includes(bi)) continue
      if (cjkB.includes(bi)) bigramHits++
    }
    if (bigramHits >= 2) return true
  }
  return false
}

export function extractHeadlinesFromMarkdown(md, maxHeadlines = 8) {
  if (!md || typeof md !== 'string') return []
  const headlines = []

  function cleanSummary(raw) {
    if (!raw) return ''
    let s = String(raw).trim()
    s = s.replace(/\[\d+\]/g, '')
         .replace(/\*可信度[^*]+\*/g, '')
         .replace(/\*\[[^\]]+\]\*/g, '')
         .replace(/\[行业公认[^\]]*\]/g, '')
         .replace(/\[未核查[^\]]*\]/g, '')
         .replace(/\*\*([^*]+)\*\*/g, '$1')
         .replace(/\*([^*]+)\*/g, '$1')
         .trim()
    if (s.length > 85) {
      const m = s.match(/^[^.!?。！？]*[.!?。！？]/)
      if (m && m[0].length >= 15 && m[0].length <= 85) {
        s = m[0].trim()
      } else {
        s = s.slice(0, 80) + '…'
      }
    }
    return s
  }

  function cleanTitle(raw) {
    let t = String(raw || '').trim()
    t = t.replace(/`[^`]+`/g, '')
         .replace(/\[(?:窗口外·重大|未核查|已核查)[^\]]*\]/g, '')
         .replace(/\*\*([^*]+)\*\*/g, '$1')
         .trim()
    if (t.length > 28) {
      const parts = t.split(/[-—–:：]/)
      if (parts[0].trim().length >= 6 && parts[0].trim().length <= 28) {
        t = parts[0].trim()
      } else {
        t = t.slice(0, 27) + '…'
      }
    }
    return t
  }

  function addHeadline(rawTitle, rawSummary) {
    const title = cleanTitle(rawTitle)
    if (!title) return
    for (const existing of headlines) {
      if (isSimilarHeadline(title, existing.title)) return
    }
    const summary = cleanSummary(rawSummary)
    headlines.push({ title, summary, provider: 'ai-daily' })
  }

  // 1. 优先提取 ## 🔥 今日亮点
  const hlMatch = md.match(/##\s*[🔥]*\s*今日亮点\s*\n([\s\S]*?)(?=\n##|\n###|$)/)
  if (hlMatch) {
    const lines = hlMatch[1].split('\n')
    for (const line of lines) {
      const m = line.match(/^[-*]\s+\*\*([^*]+)\*\*(?:\s*[-—–:：]\s*(.*))?$/)
      if (m) {
        addHeadline(m[1], m[2] || '')
      }
    }
  }

  // 2. 补充提取正文各板块条目：### 板块名 下的 **标题**
  const sectionsMatch = md.match(/(###\s+[^\n]+[\s\S]*?)(?=\n##\s+(?:⚠️|📊|📎|参考来源|$)|$)/)
  if (sectionsMatch) {
    const secText = sectionsMatch[1]
    const secBlocks = secText.split(/(?=###\s+)/)
    for (const block of secBlocks) {
      if (/###\s*(?:待核实|未验证)/.test(block)) continue
      const itemRegex = /(?:^|\n)\*\*([^*]+)\*\*(?:\s*`([^`]+)`)?[^\n]*\n\n([^\n]+)/g
      let match
      while ((match = itemRegex.exec(block)) !== null) {
        if (headlines.length >= maxHeadlines) break
        const t = match[1]
        const status = match[2] || ''
        if (status.includes('未核查') && headlines.length >= 4) continue
        const s = match[3]
        addHeadline(t, s)
      }
    }
  }

  return headlines.slice(0, maxHeadlines)
}

export async function runPoster(outDir, date, deps = {}) {
  const fsImpl = deps.fs || fs
  const root = deps.dallyReportRoot !== undefined ? deps.dallyReportRoot : resolveDallyReportRoot(fsImpl)
  const loaded = deps.generateAiPoster
    ? { generateAiPoster: deps.generateAiPoster, loadConfig: deps.loadConfig || loadEnvOnlyConfig, loadEnv: deps.loadEnv || loadEnvFile, fs: fsImpl }
    : await loadDeps(root, fsImpl)
  if (!loaded) return { ok: false, reason: 'deps_unavailable' }

  // 9/19 修复：旧代码引用未定义标识符 DALLYREPORT_FALLBACK_ROOT——deps.generateAiPoster 注入 +
  // root falsy 路径直接 ReferenceError（被 finalize try/catch 吞成海报静默失败）。root 为空时跳过
  // env 加载（deps 注入方自管凭证；loadEnvFile 对缺失文件本就是 no-op）。
  if (root) loaded.loadEnv(path.join(root, '.env'), process.env, fsImpl)

  const claimsPath = path.join(outDir, `${date}.verified-claims.json`)
  const sourcesPath = path.join(outDir, `${date}.sources.json`)
  const mdPath = path.join(outDir, `${date}-ai日报.md`)

  let headlines = []

  // 1. 优先从同目录已生成的 Markdown 日报提取打磨好的中文短标题与精炼摘要
  if (fsImpl.existsSync(mdPath)) {
    try {
      const mdContent = fsImpl.readFileSync(mdPath, 'utf8')
      headlines = extractHeadlinesFromMarkdown(mdContent, 8)
    } catch (e) {
      console.error(`POSTER-WARN read markdown headlines: ${e.message}`)
    }
  }

  // 2. 回落 1：若 md 不存在或无标题，读取 claims 做保底提取
  if (!headlines.length && fsImpl.existsSync(claimsPath)) {
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

  // 3. 回落 2：若 claims 亦为空，读取 sources
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
  // 生产布局 outDir = <obsidianDir>/<date>（image-gen 写 path.join(obsidianDir, date)/<cfg.posterFile=ai-daily.png>）。
  // outDir 基名即 date 时 obsidianDir = 其父目录；否则（tmp 测试/任意命名 outDir）直接用 outDir 本身，
  // 让 ai-daily.png 与日报落在同一目录——拼回 path.join(obsidianDir, date) 恒等于或包含 outDir 的语义保住。
  const resolvedOut = path.resolve(outDir)
  cfg.obsidianDir = path.basename(resolvedOut) === date ? path.dirname(resolvedOut) : resolvedOut
  cfg.posterFile = POSTER_FILE

  console.log(`POSTER-GEN starting AI poster with ${headlines.length} headlines for ${date}...`)
  try {
    const res = await loaded.generateAiPoster(cfg, headlines)
    console.log(`POSTER-RESULT ok=${res.ok} summary=${res.summary}`)
    if (res.ok && res.file) {
      // Embed ![[ai-daily.png]] into markdown if not already embedded
      if (fsImpl.existsSync(mdPath)) {
        let md = fsImpl.readFileSync(mdPath, 'utf8')
        if (!md.includes('![[ai-daily.png]]')) {
          // Place embed right after main header（文件首行或后续行都命中）
          const replaced = md.replace(/(^|\n)(# 🤖 AI 日报[^\n]*\n)/, '$1$2\n![[ai-daily.png]]\n')
          if (replaced !== md) {
            md = replaced
          } else {
            md = `![[ai-daily.png]]\n\n${md}`
          }
          // 9/19：与 finalize 产物同规格——tmp+rename 原子改写（二次改写不再暴露半截 md 窗口）。
          const tmp = mdPath + '.tmp'
          fsImpl.writeFileSync(tmp, md, 'utf8')
          fsImpl.renameSync(tmp, mdPath)
          console.log(`POSTER-EMBED updated ${mdPath} with ![[ai-daily.png]]`)
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
// P3-⑥（10-03 review）：默认 outDir 旧版硬编码 Mac iCloud 路径——Windows 迁移后手动调用会指向不存在
// 的目录。F-1（10-04 review）：三级解析（AI_DAILY_REPORT_DIR 覆盖 → win32 生产根 → Mac iCloud 兜底）
// 收敛到 host-paths.prodDallyReportRoot() 单一真源，与 artifact-check / finalize 同源。生产 run 恒
// 显式传 outDir，本默认只服务手动调用。
if (isCliMain(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2)
  const today = localDateStr()
  const outDir = args[0] || path.join(prodDallyReportRoot(), today)
  const date = args[1] || path.basename(outDir)
  runPoster(outDir, date).then(res => {
    if (!res || res.ok !== true) {
      const why = res && (res.error && res.error.message || res.reason || res.summary) || 'unknown'
      process.stderr.write(`generate-poster: 未生成海报: ${why}\n`)
      process.exit(1)
    }
  }).catch(e => { console.error(e); process.exit(1) })
}
