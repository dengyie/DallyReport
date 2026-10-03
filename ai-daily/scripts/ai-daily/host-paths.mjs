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
