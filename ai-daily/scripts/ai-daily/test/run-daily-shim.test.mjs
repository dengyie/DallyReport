import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// 宿主 shim 在 git 仓外（~/.ai-daily/run-daily.sh）。本机生产 launchd 跑的就是这份。
// 镜像 CI 没有该文件 → skip；本机必须锁死「预抓 JSON 不得插进双引号 claude -p」。
// GATEWAY-TOOL-PROBE-SENTINEL
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
  assert.match(sh, /DEEPSEEK_TRIES=3/, 'DeepSeek 同档重试次数在场（CPA 别名抽签）')
  assert.match(sh, /FALLBACK_TRIES=2/, '降级模型每档重试次数在场')
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
  const promptLine = sh.split('\n').find(l => /运行 ai-daily skill/.test(l) && /dangerously-skip-permissions/.test(l))
  assert.ok(promptLine, '真实 launch 行（含 dangerously-skip-permissions）在场')
  assert.match(promptLine, /\\"webFetchViaCdp\\":true/, 'headless 显式开启 fetch 走 9222 CDP（手动 /ai-daily 默认关）')
  assert.match(sh, /LEDGER="\$\{LOGDIR\}\/published-ledger\.json"/, '账本路径定义在场（HOME 下，launchd TCC 可读；iCloud 路径不可读）')
  assert.match(promptLine, /\$LEDGER/, 'launch prompt 引用账本路径变量')
  assert.match(promptLine, /args\.reportedLedger/, '编排器被告知注入 args.reportedLedger')
  assert.match(promptLine, /必须 Read/, '文件存在时必须注入，不得写成可选项（09-20 resume 漏传）')
  assert.match(promptLine, /不存在.*省略|不存在才省略|仅当文件不存在/, '账本缺失才允许省略（首跑 fail-open）')
})

test('host shim：探针必须与主 launch 同属工具调用类，不得用短问答 OK 放行', (t) => {
  if (!fs.existsSync(SHIM)) {
    t.skip('本机无 ~/.ai-daily/run-daily.sh（镜像 CI）')
    return
  }
  const sh = fs.readFileSync(SHIM, 'utf8')
  const probeFn = sh.match(/probe_gateway\(\) \{[\s\S]*?\n\}/)
  assert.ok(probeFn, 'probe_gateway 函数体可抽取')
  const probe = probeFn[0]
  assert.doesNotMatch(probe, /Reply with exactly: OK/, '短问答 OK 探针会在 DeepSeek chat 200 / tools 400 时假阳性放行（09-13 实证）')
  assert.match(probe, /dangerously-skip-permissions/, '探针须带与 launch 相同的 skip-permissions（工具路径）')
  assert.match(probe, /unapproved channel/, '探针须把渠道拦截当失败，不得只看 *OK*')
  assert.match(probe, /API Error/, '探针须把 API Error 当失败')
  assert.match(probe, /11128/, '探针须把 CPA 官方渠道码 11128 当失败')
  assert.match(probe, /--model "\$\{?model\}?"/i, '探针模型须走本次 attempt 的 $model，不得钉死单一模型')
  const launchLine = sh.split('\n').find(l => /运行 ai-daily skill/.test(l))
  assert.ok(launchLine, '主 launch 行在场')
  assert.match(launchLine, /--model "\$\{?MODEL\}?"/, '主 launch 模型须走本次 attempt 的 $MODEL')
  assert.doesNotMatch(launchLine, /--model grok-4\.6/, '主 launch 不得钉死 grok：用户要求 DeepSeek 优先、失败再降级')
  assert.doesNotMatch(launchLine, /--model deepseek-v4-flash/, '主 launch 不得钉死 DeepSeek：抽签 11128 后必须能换级')
})

test('host shim：编排器 DeepSeek 优先、同档重试、再按阶梯降级', (t) => {
  if (!fs.existsSync(SHIM)) {
    t.skip('本机无 ~/.ai-daily/run-daily.sh（镜像 CI）')
    return
  }
  const sh = fs.readFileSync(SHIM, 'utf8')
  const ladder = sh.match(/ORCH_LADDER=\(([^)]+)\)/)
  assert.ok(ladder, 'ORCH_LADDER 数组在场')
  const models = ladder[1].trim().split(/\s+/)
  assert.deepEqual(
    models,
    ['deepseek-v4-flash', 'grok-4.6', 'claude-opus-4-8', 'gemini-3.7-flash-high'],
    '编排器阶梯须与 report/verify 默认阶梯同序：DeepSeek 先打，再 grok/opus/gemini',
  )
  assert.match(sh, /DEEPSEEK_TRIES=3/, 'DeepSeek 抽签要连打几次再换级')
  assert.match(sh, /FALLBACK_TRIES=2/, '降级模型也要给第二次机会')
  assert.match(sh, /MODEL-FALLBACK/, '换级须打日志，便于次日审计')
  assert.match(sh, /for MODEL in "\$\{ORCH_LADDER\[@\]\}"/, 'launch 循环须遍历阶梯而不是固定三次同模型')
})

test('host shim：子代理跟当前档模型，连续 11128 快切换档', (t) => {
  if (!fs.existsSync(SHIM)) {
    t.skip('本机无 ~/.ai-daily/run-daily.sh（镜像 CI）')
    return
  }
  const sh = fs.readFileSync(SHIM, 'utf8')
  assert.match(sh, /export CLAUDE_CODE_SUBAGENT_MODEL="\$MODEL"/, 'harvest/discover/fetch 须跟本次 launch 档，不得钉死环境 DeepSeek')
  assert.match(sh, /CHANNEL_FAIL_MAX=2/, '同档连续渠道拦截上限在场')
  assert.match(sh, /CHANNEL-FAIL/, '11128 快死须记账')
  assert.match(sh, /CHANNEL-FAIL-SKIP/, '连抽两次坏渠道须跳档，不得把 DEEPSEEK_TRIES 打满')
  const launchLine = sh.split('\n').find(l => /运行 ai-daily skill/.test(l))
  assert.ok(launchLine, '主 launch 行在场')
  assert.match(sh, /LAUNCH_OUT=/, '须捕获 launch 输出才能认 11128，不能只看 rc')
})
