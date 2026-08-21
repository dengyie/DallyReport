import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROMPTS = fs.readFileSync(path.join(HERE, '../prompts.mjs'), 'utf8')

// 2026-08-22 风格优化（spec C）：reportPrompt 增不确定度措辞要求——继续保留既有约束，仅增量加一条编辑要求。
// 源级测试固化：断言新要求在场，且既有约束（禁工具调用/头条优先序/新闻式标题≤25字）未被削弱。

test('reportPrompt：不确定度措辞要求在场（spec C 增量）', () => {
  assert.match(PROMPTS, /不确定度如实标注[\s\S]*有用户称/, '要求用「有用户称」等措辞')
  assert.match(PROMPTS, /暂不能确认/, '含「暂不能确认」示例措辞')
  assert.match(PROMPTS, /社区传闻与官方动态须用不同措辞区分/, '社区传闻与官方动态措辞区分')
})

test('reportPrompt：既有约束全保留（回归不削弱）', () => {
  assert.match(PROMPTS, /禁止调用任何工具/, '禁工具调用保留')
  assert.match(PROMPTS, /先筛选，再写稿/, '头条优先序保留')
  assert.match(PROMPTS, /≤25字/, '新闻式标题字数约束保留')
  assert.match(PROMPTS, /Structured output only/, '结构化输出保留')
})

// ─── 2026-08-22 三契约缺口修复（spec 2026-08-22-ai-daily-sources-and-uncertainty-design.md）───

test('discoverPrompt：majorOutOfWindow 鼓励带 url（B.3）', () => {
  assert.match(PROMPTS, /majorOutOfWindow[\s\S]{0,1200}url/, '§5 majorOutOfWindow 描述涉及 url 字段')
  assert.match(PROMPTS, /可溯源的官方\/一手 URL[\s\S]*`url` 字段带上（可选，无则不带）/, '「若该事实有可溯源的官方/一手 URL… url 字段」鼓励文本')
})

test('reportPrompt §4.5：未核查项措辞硬约束在场（C.1 增量）', () => {
  assert.match(PROMPTS, /status 为 `\[窗口外·重大\]` 或 `未核查`[\s\S]*禁止用/, '未核查项必须用不确定度措辞的硬约束文本')
  assert.match(PROMPTS, /（「据报」「有媒体称」「宣称」「待官方确认」「暂不能确认」之一）/, '必须候选措辞列全')
  assert.match(PROMPTS, /禁止用「已解决」「完成」「正式发布」「确认」等肯定完成态措辞/, '禁令完整列全')
  assert.match(PROMPTS, /有 vote 支撑，可正常陈述/, '已核查项不被迫弱化')
})
