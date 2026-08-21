import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..')
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8')
const BOARDS = read('boards.mjs')
const TPL = read('ai-daily.template.js')
const PROMPTS = read('prompts.mjs')

// 8/21 学术板降级根因：arXiv HTML list 页经 auto provider(Tavily) 被压成 501 字符残缺（只剩 "showing 50 of N"
// 表头，论文列表空）→ harvest digest 空 → discover 学术代理标 degraded → academic 板 0 claims。
// 修复：改用官方 Atom API（export.arxiv.org/api/query + submittedDate:[WFROM TO WTO] 窗口查询），
// 单 URL 用 OR 合并 cs.AI|cs.CL，--provider direct 取完整 XML，maxChars 放宽到 40000。
// 本测试固化该修复，防任何回退到 HTML list 或丢掉 direct/provider 放宽。

test('academic feeds: 不再用 arxiv.org/list/ HTML 页（回归即红）', () => {
  const academicLine = BOARDS.split('\n').find(l => /key:\s*'academic'/.test(l) && /title:\s*'学术研究'/.test(l))
  assert.ok(academicLine, 'academic board 定义在场')
  assert.doesNotMatch(academicLine, /arxiv\.org\/list\//, '学术板不得再用 HTML list 页（auto provider 会截成 501 字符）')
})

test('academic feeds: 官方 Atom API + submittedDate 窗口查询在场', () => {
  const academicLine = BOARDS.split('\n').find(l => /key:\s*'academic'/.test(l) && /title:\s*'学术研究'/.test(l))
  assert.match(academicLine, /export\.arxiv\.org\/api\/query/, '学术板用官方 API')
  assert.match(academicLine, /submittedDate/, 'API 带 submittedDate 窗口查询')
  assert.match(academicLine, /cat%3Acs\.AI\+OR\+cat%3Acs\.CL|cat%3Acs\.AI.*OR.*cat%3Acs\.CL/, 'cs.AI|cs.CL 合并在单 URL')
  assert.match(academicLine, /\{\{WFROM\}\}/, 'URL 含 {{WFROM}} 占位（YYYYMMDD0000）')
  assert.match(academicLine, /\{\{WTO\}\}/, 'URL 含 {{WTO}} 占位（YYYYMMDD2359）')
})

test('template: 窗口展开把 {{WFROM}}/{{WTO}} 替换成实参日期', () => {
  // 占位替换逻辑必须在场；无窗口时占位不得残留（回退 'recent'）。
  assert.match(TPL, /\{\{WFROM\}\}/, /占位标记定义在 boards.mjs（上面已断言）；template 必须消费它/)
  assert.match(TPL, /\.replace\('\{\{WFROM\}\}', arxivWindow\.wf\)/, 'WFROM 按 wf(YYYYMMDD) 展开')
  assert.match(TPL, /\.replace\('\{\{WTO\}\}', arxivWindow\.wt\)/, 'WTO 按 wt(YYYYMMDD) 展开')
})

test('prompts: arXiv API 源强制 --provider direct（非 auto→tavily 截断）', () => {
  const line = PROMPTS.split('\n').find(l => l.includes('--provider'))
  assert.ok(line, 'harvest 命令含 --provider')
  assert.ok(line.includes('export.arxiv.org/api/query') || line.includes('export\\.arxiv\\.org\\/api\\/query'), '按 arXiv API URL 分流: ' + line.trim())
  assert.ok(line.includes("'direct'"), 'arXiv 源 → direct: ' + line.trim())
  assert.ok(line.includes("'auto'"), '其余源 → auto: ' + line.trim())
})

test('feedMaxChars: arXiv API 源放宽到 40000（普通源仍 12000）', () => {
  const line = TPL.split('\n').find(l => l.includes('feedMaxChars') && l.includes('40000'))
  assert.ok(line, 'feedMaxChars 按源分流且含 40000: ' + line)
  assert.ok(line.includes('12000'), '普通源仍 12000: ' + line.trim())
  assert.ok(line.includes('export.arxiv.org/api/query') || line.includes('export\\.arxiv\\.org\\/api\\/query'), '识别 arXiv API URL: ' + line.trim())
})

// 冒烟：确认窗口展开产物真的是可达的 arXiv API（不抓真实网络，只校验 URL 形态 + 本地构建产物同步）。
test('窗口展开产物形态：YYYYMMDD + 0000/2359 时刻', () => {
  // 模拟 template 的展开逻辑（纯字符串替换，无 realm 依赖）。
  const wf = '2026-08-17'.replace(/-/g, '')
  const wt = '2026-08-19'.replace(/-/g, '')
  const academicLine = BOARDS.split('\n').find(l => /key:\s*'academic'/.test(l) && /title:\s*'学术研究'/.test(l))
  const m = academicLine.match(/'(https:\/\/export\.arxiv\.org\/api\/query[^']+)'/)
  assert.ok(m, '提取 academic API URL 字面量')
  const expanded = m[1].replace('{{WFROM}}', wf).replace('{{WTO}}', wt)
  assert.match(expanded, /202608170000/, 'WFROM 展开为 202608170000')
  assert.match(expanded, /202608192359/, 'WTO 展开为 202608192359')
  assert.ok(!expanded.includes('{{'), '展开后无残留占位')
})
