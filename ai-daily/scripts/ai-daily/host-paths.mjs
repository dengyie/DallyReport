// 宿主路径推导单一真源（2026-10-03 根因收口）。
//
// 为什么需要本模块：host-finalize / progress / artifact-check 三个宿主 CLI 各自推导「Claude 会话目录」
// 与「~/.ai-daily 运行时目录」，此前一律写成 `process.env.HOME || ''` + 硬编码 Mac 会话名
// `-Users-mango-project-claude-project-obsidian`：
//   ① 任务计划程序 / launchd 的非登录 shell 下 HOME 常为空 → 路径退化成 `/Library/...`（不存在），
//      host-finalize 找不到 wf_*.json（恢复静默失败）、progress 读不到日志、artifact-check 自检空转；
//   ② Mac 会话名硬编码在 Windows 迁移后必不命中。
// 修复：HOME 一律取 `os.homedir()`（Windows 读 USERPROFILE，两平台恒正确）；会话目录由 **cwd 推导**
// （生产 runner `cd $VAULT` 后 spawn，cwd 即 vault，slug 恒对得上），并提供 env 覆盖口子。
//
// 本文件是宿主 Node 专用，**绝不 inline 进 workflow 产物**（realm 无 process/os/fs），
// 故不在 build.mjs MODULES 内。
import os from 'node:os'
import path from 'node:path'

/**
 * Claude Code 会话目录名 = cwd 的路径 slug。
 * 规则经真实目录实证：`E:\profile\note\note` → `E--profile-note-note`（`:` 与首个 `\` 各折一个 `-`），
 * `/Users/mango/x/y` → `-Users-mango-x-y`。**逐字符**替换，不合并连续分隔符。
 */
export const projectSlug = p => path.resolve(p).replace(/[:\\/]/g, '-')

/**
 * `~/.claude/projects/<cwd-slug>`——Claude Code 存放会话 journal / workflow json 的根。
 * AI_DAILY_PROJECTS_DIR 可显式覆盖（手动补跑 / 异 cwd）。
 */
export const claudeProjectsDir = (cwd = process.cwd()) =>
  process.env.AI_DAILY_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects', projectSlug(cwd))

/** `~/.ai-daily`——运行时文件（run-daily.log / published-ledger.json / linuxdo-prefetch.json）。 */
export const aiDailyHome = () => process.env.AI_DAILY_HOME || path.join(os.homedir(), '.ai-daily')

// ─── 生产日报根（Note/AI/DallyReport）单一真源（10-04 F-1 收口；10-06 迁移 Note/）───
// artifact-check / generate-poster / finalize 三处宿主 CLI 曾各写一份「win32 生产根 + Darwin
// iCloud 兜底」字面量（artifact-check DEFAULT_DIR、generate-poster defaultReportRoot、
// finalize PROD_DALLYREPORT_PREFIXES）→ vault 迁移要改三处，漏一处即假 FAIL / 错根。
// 收敛到本模块；env 覆盖口子沿用 AI_DAILY_REPORT_DIR（手动/CI 钉死生产根）。
// 10-06：生产根从 vault 根 AI/DallyReport 迁入 Note/AI/DallyReport（与 DallyReport 主系统同目录、
// 海报改名 ai-daily.png 防撞名）——用户裁决「通过 obsidian 同步下日报」。
export const WIN_PROD_DALLYREPORT_ROOT = 'E:/profile/note/note/Note/AI/DallyReport'
export const macProdDallyReportRoot = () =>
  path.join(os.homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/Note/AI/DallyReport')

/** 三级解析：AI_DAILY_REPORT_DIR env 覆盖 → win32 生产 vault 根 → Darwin iCloud 兜底（历史对账）。 */
export const prodDallyReportRoot = () =>
  process.env.AI_DAILY_REPORT_DIR
    || (process.platform === 'win32' ? WIN_PROD_DALLYREPORT_ROOT : macProdDallyReportRoot())

/** 本地时区日期串 YYYY-MM-DD（宿主 CLI 的「今天」）。禁用 toISOString()（UTC）——
 *  本地 00:00–08:00（CST=UTC+8）之间 UTC 日期仍是昨天 → progress 日期标签错一天、
 *  artifact-check/generate-poster 无参默认查错日（10-04 smoke 实证：03:00 显示 10-03）。 */
export const localDateStr = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
