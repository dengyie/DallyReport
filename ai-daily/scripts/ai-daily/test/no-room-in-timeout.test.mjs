import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TPL = fs.readFileSync(path.join(HERE, '../ai-daily.template.js'), 'utf8')

// 剔除 // 注释行：只留代码行，注释里出现 room（line 199/383 的确说过它）不算犯罪。
const codeLines = TPL.split('\n').filter(l => !l.trim().startsWith('//'))

test('no-room-in-timeout: 无任何 timeoutMs: 赋值行混入 room/roomMs/RUN_ELAPSED', () => {
  const guilty = codeLines.filter(l => /timeoutMs\s*:/.test(l) && /\b(room|roomMs|RUN_ELAPSED)\b/.test(l))
  assert.deepEqual(guilty, [], 'timeoutMs 不得再收 room（8/19 根因）；违规行：' + guilty.join(' | '))
})

test('no-room-in-vtimeout: vtimeout 取固定 AGENT_TIMEOUT_MS，与 room 无关', () => {
  const lines = codeLines.filter(l => /vtimeout\s*=/.test(l))
  assert.ok(lines.length >= 1, '存在 vtimeout 赋值行')
  for (const l of lines) {
    assert.ok(!/\b(room|roomMs|RUN_ELAPSED)\b/.test(l), 'vtimeout 不得含 room/roomMs/RUN_ELAPSED: ' + l)
    assert.match(l, /AGENT_TIMEOUT_MS/, 'vtimeout 直接取自 AGENT_TIMEOUT_MS: ' + l)
  }
})

test('fixed-bounds: 5 个固定上界在场（与 8/16 成功配置一致）', () => {
  assert.match(TPL, /timeoutMs:\s*1800000/, 'harvest 上界 1800000')
  assert.match(TPL, /timeoutMs:\s*g\.key === 'labs' \? 1800000 : 2400000/, 'discover labs?:1800000:2400000')
  assert.match(TPL, /timeoutMs:\s*AGENT_TIMEOUT_MS/, 'fetch 上界 AGENT_TIMEOUT_MS')
  assert.match(TPL, /vtimeout\s*=\s*AGENT_TIMEOUT_MS/, 'verify 上界 AGENT_TIMEOUT_MS')
  assert.match(TPL, /timeoutMs:\s*600000/, 'report 上界 600000')
})