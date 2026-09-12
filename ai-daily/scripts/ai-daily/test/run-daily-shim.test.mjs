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

test('host shim：9/13 P0-1 编排器韧性契约（探针 + 重拉 + 通知）', (t) => {
  if (!fs.existsSync(SHIM)) {
    t.skip('本机无 ~/.ai-daily/run-daily.sh（镜像 CI）')
    return
  }
  const sh = fs.readFileSync(SHIM, 'utf8')
  assert.match(sh, /probe_gateway\(\)/, '网关探针函数在场')
  assert.match(sh, /probe_wait\(\)/, '探针循环函数在场')
  assert.match(sh, /Reply with exactly: OK/, '探针沿用 9/02 生产验证的 claude -p 指令')
  assert.match(sh, /PROBE_RETRY=5/, '探针重试上限在场')
  assert.match(sh, /LAUNCH_MAX=3/, 'launch 重试上限在场')
  assert.match(sh, /LAUNCH_FAST_DEATH_S=600/, '快死阈值在场（≥10min 的失败不盲目重拉）')
  assert.match(sh, /REPORT-EXISTS/, '产物落盘即成功判定在场')
  assert.match(sh, /RELAUNCH-SKIP/, '非快死失败不重拉的护栏在场')
  assert.match(sh, /osascript -e "display notification/, '终局失败 macOS 通知在场')
  assert.match(sh, /probe-exhausted/, '探针全失败的退出记账在场')
})

test('host shim：9/13 args 契约（webFetchViaCdp + reportedLedger 注入指令）', (t) => {
  if (!fs.existsSync(SHIM)) {
    t.skip('本机无 ~/.ai-daily/run-daily.sh（镜像 CI）')
    return
  }
  const sh = fs.readFileSync(SHIM, 'utf8')
  const promptLine = sh.split('\n').find(l => /claude -p .+dangerously-skip-permissions/.test(l))
  assert.ok(promptLine, '真实 launch 行（含 dangerously-skip-permissions）在场')
  assert.match(promptLine, /\\"webFetchViaCdp\\":true/, 'headless 显式开启 fetch 走 9222 CDP（手动 /ai-daily 默认关）')
  assert.match(sh, /LEDGER="\$\{LOGDIR\}\/published-ledger\.json"/, '账本路径定义在场（HOME 下，launchd TCC 可读；iCloud 路径不可读）')
  assert.match(promptLine, /\$LEDGER/, 'launch prompt 引用账本路径变量')
  assert.match(promptLine, /args\.reportedLedger/, '编排器被告知注入 args.reportedLedger')
  assert.match(promptLine, /不存在则不传/, '账本缺失 fail-open（首跑/被清空不报错）')
})
