import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { projectSlug, claudeProjectsDir, aiDailyHome } from '../host-paths.mjs'

// 10-03 P2-② 根因：宿主 CLI 此前各自用 `process.env.HOME || ''` + 硬编码 Mac 会话名推导路径——
// 非登录 shell 下 HOME 为空 → 路径退化；Mac 会话名在 Windows 不命中。本组锁定 host-paths 契约。

test('projectSlug：逐字符替换 : \\ / 为 -（不合并连续分隔符）', () => {
  // 真实 Claude Code 目录实证：E:\profile\note\note → E--profile-note-note（: 与 \ 各折一个 -）
  assert.equal(projectSlug('E:\\profile\\note\\note'), 'E--profile-note-note')
  assert.equal(projectSlug('C:\\Users\\mango\\Desktop\\ccx'), 'C--Users-mango-Desktop-ccx')
})

test('projectSlug：对正斜杠路径同样逐字符替换（posix 平台）', { skip: process.platform === 'win32' ? 'win32 下 path.resolve 会把 posix 路径挂到当前盘符，posix 语义不适用' : false }, () => {
  const slug = projectSlug('/Users/mango/project/claude-project/obsidian')
  assert.equal(slug, '-Users-mango-project-claude-project-obsidian', '每个 / 折一个 -')
})

test('projectSlug：win32 下 posix 路径挂当前盘符后仍逐字符折叠（平台自洽）', { skip: process.platform !== 'win32' ? '仅 win32' : false }, () => {
  // win32 path.resolve('/Users/mango/x') → '<drive>:\\Users\\mango\\x' → 盘符后的 : 与 \ 各折一个 -
  const resolved = path.resolve('/Users/mango/x')
  const expected = resolved.replace(/[:\\/]/g, '-')
  assert.equal(projectSlug('/Users/mango/x'), expected, 'slug 恒等于 resolve 后逐字符折叠（盘符无关）')
  assert.ok(!/[:\\/]/.test(projectSlug('/Users/mango/x')), 'slug 内不得残留任何路径分隔符')
})

test('claudeProjectsDir：落在 os.homedir()/.claude/projects/<slug> 下，不依赖 process.env.HOME', () => {
  const cwd = process.cwd()
  const dir = claudeProjectsDir(cwd)
  assert.ok(dir.startsWith(path.join(os.homedir(), '.claude', 'projects')), '前缀为 homedir/.claude/projects')
  assert.ok(dir.endsWith(projectSlug(cwd)), '尾段为 cwd 的 slug')
  // HOME 为空时（非登录 shell）仍必须给出可用绝对路径
  const savedHome = process.env.HOME
  const savedOverride = process.env.AI_DAILY_PROJECTS_DIR
  delete process.env.AI_DAILY_PROJECTS_DIR
  process.env.HOME = ''
  try {
    const dir2 = claudeProjectsDir(cwd)
    assert.equal(dir2, dir, 'HOME 为空不改变结果（真源是 os.homedir()）')
    assert.ok(path.isAbsolute(dir2), '恒为绝对路径')
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
    if (savedOverride !== undefined) process.env.AI_DAILY_PROJECTS_DIR = savedOverride
  }
})

test('claudeProjectsDir：AI_DAILY_PROJECTS_DIR 显式覆盖优先', () => {
  const saved = process.env.AI_DAILY_PROJECTS_DIR
  process.env.AI_DAILY_PROJECTS_DIR = '/custom/projects'
  try {
    assert.equal(claudeProjectsDir('/whatever'), '/custom/projects', 'env 覆盖优先于 cwd 推导')
  } finally {
    if (saved === undefined) delete process.env.AI_DAILY_PROJECTS_DIR; else process.env.AI_DAILY_PROJECTS_DIR = saved
  }
})

test('aiDailyHome：落在 os.homedir()/.ai-daily，AI_DAILY_HOME 可覆盖', () => {
  assert.equal(aiDailyHome(), path.join(os.homedir(), '.ai-daily'))
  const saved = process.env.AI_DAILY_HOME
  process.env.AI_DAILY_HOME = '/custom/ai-daily'
  try {
    assert.equal(aiDailyHome(), '/custom/ai-daily')
  } finally {
    if (saved === undefined) delete process.env.AI_DAILY_HOME; else process.env.AI_DAILY_HOME = saved
  }
})

test('host-paths 不得进入 workflow 产物（宿主专用，realm 无 os/process/path）', async () => {
  const fs = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(HERE, '../build.mjs'), 'utf8')
  const m = src.match(/const MODULES = \[([^\]]+)\]/)
  assert.ok(!m[1].includes("'host-paths'"), 'host-paths 不得列入 build MODULES')
})
