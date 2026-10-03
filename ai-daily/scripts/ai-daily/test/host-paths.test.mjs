import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { projectSlug, claudeProjectsDir, aiDailyHome, prodDallyReportRoot, localDateStr } from '../host-paths.mjs'

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

// F-1（10-04 review）：生产日报根单一真源——artifact-check / generate-poster / finalize 三处
// 字面量收敛到本模块。锁三级解析：env 覆盖最高优先；默认分支按平台（win32 生产根 / Darwin iCloud）。
test('prodDallyReportRoot：AI_DAILY_REPORT_DIR 覆盖优先；默认分支平台正确', () => {
  const orig = process.env.AI_DAILY_REPORT_DIR
  try {
    process.env.AI_DAILY_REPORT_DIR = '/tmp/pinned-root'
    assert.equal(prodDallyReportRoot(), '/tmp/pinned-root', 'env 覆盖最高优先')
    delete process.env.AI_DAILY_REPORT_DIR
    const root = prodDallyReportRoot()
    if (process.platform === 'win32') {
      assert.equal(root, 'E:/profile/note/note/AI/DallyReport', 'win32 默认 = 生产 vault 根')
    } else {
      assert.ok(root.startsWith(os.homedir()), 'Darwin 兜底在 home（iCloud 路径）下')
    }
  } finally {
    if (orig === undefined) delete process.env.AI_DAILY_REPORT_DIR
    else process.env.AI_DAILY_REPORT_DIR = orig
  }
})

// 10-04 smoke 实证：toISOString()（UTC）在本地 00:00–08:00（CST）返回昨天 → progress 日期
// 标签错一天、artifact-check/generate-poster 无参默认查错日。锁定本地时区日期推导。
test('localDateStr：按本地时区推导 YYYY-MM-DD（不得用 UTC 的 toISOString）', () => {
  // 已知 UTC 时刻：2026-10-03T18:00:00Z = CST 2026-10-04 02:00 —— 本地日期必须是 10-04
  const utcEveningCst = new Date('2026-10-03T18:00:00Z')
  if (new Date(utcEveningCst.getTime()).getTimezoneOffset() === -480) {
    assert.equal(localDateStr(utcEveningCst), '2026-10-04', 'CST 02:00 的本地日期是当天（UTC 还是前一天）')
  } else {
    // 非 CST 环境只锁格式与「本地自洽」：与本地日历字段逐位一致
    const d = new Date('2026-03-05T12:00:00Z')
    const p = n => String(n).padStart(2, '0')
    assert.equal(localDateStr(d), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
  }
  assert.match(localDateStr(), /^\d{4}-\d{2}-\d{2}$/, '无参 = 现在的本地日期')
})
