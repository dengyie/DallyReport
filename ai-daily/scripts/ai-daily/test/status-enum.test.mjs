// C.3 双轨收口（2026-08-22）：REPORT_SCHEMA.status 必须是枚举字面量（render 精确消费 + prompt 强制写法）。
// 锁死：schema 真源里 status 枚举含 5 个合法字面量、不含变体；prompt 强制 `[窗口外·重大]`（含方括号）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REPORT_SCHEMA } from '../schemas.mjs'
import { reportPrompt } from '../prompts.mjs'

// 嵌套路径：sections[] → items(array) → items(item schema，含 properties) → properties
// 调试实证：REPORT_SCHEMA.properties.sections.items.properties.items.items.properties 含 status 键
const ITEM_PROPS = REPORT_SCHEMA.properties.sections.items.properties.items.items.properties
assert.ok(ITEM_PROPS && ITEM_PROPS.status, 'REPORT_SCHEMA 应含 sections[].items[].items.properties.status')

test('C.3 schema 收口：REPORT_SCHEMA.status 是精确枚举字面量', () => {
  const st = ITEM_PROPS.status
  assert.ok(st && Array.isArray(st.enum), 'status 必须是 enum 约束')
  assert.deepEqual(st.enum, ['已核查 2-0', '已核查 2-1', '[窗口外·重大]', '未核查', '已否决'], '枚举字面量必须精确匹配 render 判定')
  // 收口目标（8/22 生产实证的漏判形态）一个都不该进 schema：无方括号的 窗口外重大 / 窗口外·重大 / 带空白的变体
  const forbidden = ['窗口外重大', '窗口外·重大', ' 窗口外', '[窗口外]', ' 未核查 ']
  for (const f of forbidden) assert.ok(!st.enum.includes(f), `枚举里不应出现变体 \`${f}\``)
})

test('schema.status 枚举必须是合法 JSON Schema（同 schema 其它字段一致）', () => {
  const { enum: e } = ITEM_PROPS.status
  // enum 值全为非空字符串，且每值都是 render 判定可直接用的字面量
  assert.ok(e.every(x => typeof x === 'string' && x.trim().length > 0))
})

test('prompt 强制 status 枚举并强调方括号（源头写法收口）', () => {
  const p = reportPrompt({ WINDOW_LABEL: 'w', confirmedVerifyCount: 4, majorOutCount: 3, reportBody: '', coverBlock: '', killedCount: 0, unverifiedCount: 0 })
  assert.ok(p.includes('`已核查 2-0` / `已核查 2-1` / `[窗口外·重大]` / `未核查` / `已否决`'), 'prompt 必须含精确枚举')
  assert.ok(p.includes('窗口外重大项**必须**写 `[窗口外·重大]`'), 'prompt 必须强制方括号写法')
})