import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCliMain } from '../cli-main.mjs'

test('isCliMain：相对 argv[1] 经 path.resolve 对齐，不得因相对路径静默不当 CLI', () => {
  const abs = fileURLToPath(import.meta.url)
  assert.equal(isCliMain(import.meta.url, abs), true, '绝对路径命中')
  const rel = path.relative(process.cwd(), abs) || abs
  assert.equal(isCliMain(import.meta.url, rel), true, '相对路径经 resolve 后命中')
  assert.equal(isCliMain(import.meta.url, undefined), false)
  assert.equal(isCliMain(import.meta.url, '/tmp/not-this-file.mjs'), false)
})
