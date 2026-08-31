import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// 宿主 shim 在 git 仓外（~/.ai-daily/run-daily.sh）。本机生产 launchd 跑的就是这份。
// 镜像 CI 没有该文件 → skip；本机必须锁死「预抓 JSON 不得插进双引号 claude -p」。
const SHIM = path.join(process.env.HOME || '', '.ai-daily/run-daily.sh')

test('host shim：run-daily.sh 不得把 prefetch JSON 插进双引号 claude -p', (t) => {
  if (!fs.existsSync(SHIM)) {
    t.skip('本机无 ~/.ai-daily/run-daily.sh（镜像 CI）')
    return
  }
  const sh = fs.readFileSync(SHIM, 'utf8')
  assert.doesNotMatch(sh, /linuxdoPrefetched.: \$\(cat/, 'JSON 本体不得 $(cat) 进 claude -p 字符串（标题/摘要引号会破 shell）')
  assert.doesNotMatch(sh, /LINUXDO_ARGS=.*, \\"linuxdoPrefetched\\"/, '不得拼 LINUXDO_ARGS JSON 片段进 prompt')
  assert.match(sh, /linuxdo-prefetch\.json/, '预抓落盘路径须在场，供编排器读文件注入 args')
  const promptLine = sh.split('\n').find(l => /claude -p /.test(l))
  assert.ok(promptLine, 'claude -p 调用在场')
  assert.ok(!/\$\(cat/.test(promptLine), 'claude -p 行不得 $(cat) 任何文件')
})
