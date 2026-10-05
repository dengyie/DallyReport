import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Windows 生产 runner 契约测试（10-03 P2-④ 根因新增）。
// 背景：旧 run-daily-shim.test.mjs 只测 git 仓外 `~/.ai-daily/run-daily.sh`（Mac 宿主 shim），
// Windows 镜像 CI / 本机都没有该文件 → 7 条 runner 契约断言（含 HOST-FINALIZE 顺序）全部 SKIP，
// 生产 runner 的回归（10-02 移植时丢掉 host-finalize 调用）在测试层完全不可见。
// 本文件改为锁定**仓内** run-daily-win.sh（Windows 生产实际执行的那份），断言走源文件文本契约，
// 不依赖外部 shim、不依赖平台（Windows 与 CI 都跑）。
// GATEWAY-TOOL-PROBE-SENTINEL

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIN_RUNNER = path.resolve(HERE, '../../../run-daily-win.sh')
const win = () => fs.readFileSync(WIN_RUNNER, 'utf8')
// 探针 sentinel 锁定（与 run-daily-win.sh probe_gateway 读取同一文件同一 token）：
const SENTINEL_FILE = path.join(HERE, 'run-daily-shim.test.mjs')

test('Windows runner 在场且可读', () => {
  assert.ok(fs.existsSync(WIN_RUNNER), 'run-daily-win.sh 须存在（Windows 生产 runner 真源）')
  const sh = win()
  assert.match(sh, /^#!\/usr\/bin\/env bash/, 'shebang 为 bash')
  assert.ok(sh.includes('run-daily-win'), '文件自标为 Windows runner')
})

test('Windows runner：预抓 JSON 不得插进双引号 claude -p，json 只落盘供 Read', () => {
  const sh = win()
  assert.doesNotMatch(sh, /linuxdoPrefetched.: \$\(cat/, 'JSON 本体不得 $(cat) 进 claude -p 字符串')
  assert.match(sh, /linuxdo-prefetch\.json/, '预抓落盘路径在场，供编排器 Read 文件注入 args')
  const promptLine = sh.split('\n').find(l => /运行 ai-daily skill/.test(l) && /dangerously-skip-permissions/.test(l))
  assert.ok(promptLine, '真实 launch 行在场')
  assert.ok(!/\$\(cat/.test(promptLine), 'claude -p 行不得 $(cat) 任何文件')
  assert.match(promptLine, /linuxdoPrefetched/, 'prompt 指示注入 args.linuxdoPrefetched')
  assert.match(promptLine, /args\.reportedLedger/, 'prompt 指示注入 args.reportedLedger（跨天账本）')
})

test('Windows runner：AI_DAILY_RUN_START_EPOCH 导出（10-05 P1 墙钟 real_s 数据链路）', () => {
  const sh = win()
  assert.match(sh, /export AI_DAILY_RUN_START_EPOCH="\$WALL_START"/, '起始 epoch 经 env 传给 finalize（claude 子进程继承）')
  assert.match(sh, /WALL_START="\$\(date '\+%s'\)"/, 'WALL_START 为宿主 epoch 秒')
  assert.match(sh, /meta\.wallclock\.real_s/, 'WALLCLOCK 行指向 real_s 语义（内段 vs 全程）')
})

test('Windows runner：编排器韧性阶梯在场（探针/重拉/通知/快死）', () => {
  const sh = win()
  assert.match(sh, /probe_gateway\(\)/, '网关探针函数在场')
  assert.match(sh, /probe_wait\(\)/, '探针循环函数在场')
  assert.match(sh, /DEEPSEEK_TRIES=3/, 'DeepSeek 同档重试次数在场')
  assert.match(sh, /FALLBACK_TRIES=2/, '降级模型每档重试在场')
  assert.match(sh, /LAUNCH_FAST_DEATH_S=600/, '快死阈值在场')
  assert.match(sh, /REPORT-EXISTS/, '产物落盘即成功判定在场')
  assert.match(sh, /RELAUNCH-SKIP/, '非快死失败不重拉的护栏在场')
  assert.match(sh, /probe-exhausted/, '探针全失败的退出记账在场')
  assert.match(sh, /notify\(\)/, '通知函数在场（Windows toast，失败回落纯日志）')
  assert.match(sh, /toast-fallback-log/, 'toast 失败回落日志兜底在场')
})

test('Windows runner：HOST-FINALIZE 必须在 artifact-check 之前（09-20 422 空盘兜底）', () => {
  const sh = win()
  assert.match(sh, /host-finalize\.mjs/, '须调用宿主 host-finalize.mjs（从 completed workflow json 确定性落盘）')
  assert.match(sh, /HOST-FINALIZE/, '须打 HOST-FINALIZE 日志')
  const finalizeIdx = sh.indexOf('host-finalize.mjs')
  const checkIdx = sh.indexOf('artifact-check.mjs')
  assert.ok(finalizeIdx >= 0 && checkIdx >= 0, 'finalize 与 artifact-check 都在场')
  assert.ok(finalizeIdx < checkIdx, 'HOST-FINALIZE 必须在 artifact-check 之前（先落盘再自检）')
  assert.match(sh, /--since-epoch/, '只收本次 WALL_START 之后的 workflow json')
  assert.match(sh, /\[ ! -f "\$REPORT" \]/, '报告已在盘上则跳过 finalize（不覆盖编排器已写产物）')
  // SHA：被组织成变量级调用而非裸命令，防止 host-finalize 用相对路径/裸名（依赖 cwd）静默 no-op
  assert.match(sh, /host-finalize\.mjs" --date/, 'host-finalize 用绝对仓库路径调用（cwd 即 vault，slug 为 vault）')
})

test('Windows runner：PATH 导出在一切外部命令之前 + STAMP 非空兜底（11-02 空转根因治理）', () => {
  const sh = win()
  const exportIdx = sh.indexOf('export PATH=')
  const firstCmdIdx = Math.min(
    ...['mkdir -p "$LOGDIR"', 'STAMP=', 'cd "$VAULT"'].map(s => sh.indexOf(s)).filter(i => i >= 0),
  )
  assert.ok(exportIdx >= 0 && exportIdx < firstCmdIdx, 'PATH 导出点必须在任何外部命令之前（非登录 shell 无 /usr/bin）')
  assert.match(sh, /STAMP="\$\{STAMP:-unknown-time\}"/, 'STAMP 空值兜底为 unknown-time（date 不可达时日志仍可辨识）')
  assert.match(sh, /\[ -n "\$TODAY" \]/, '今日日期不可达则早退且不空跑')
})

test('Windows runner：探针 sentinel 文件与 probe_gateway 读取一致', () => {
  assert.ok(fs.existsSync(SENTINEL_FILE), 'probe_gateway 读取的 sentinel 源文件在场')
  assert.ok(win().includes('GATEWAY-TOOL-PROBE-SENTINEL') ||
    fs.readFileSync(SENTINEL_FILE, 'utf8').includes('GATEWAY-TOOL-PROBE-SENTINEL'),
  'sentinel token 契约两端在场（runner 探针读同一 token）')
})

test('Windows runner：prefetch 失败日志携带 node 真实退出码（10/04 smoke 实证：printf 之后 $? 恒 0）', () => {
  const sh = win()
  const failIdx = sh.indexOf('LINUXDO-PREFETCH-FAIL')
  assert.ok(failIdx >= 0, '预抓失败日志行在场')
  // 根因：`exit=$?` 若写在 printf 之后，取到的是 printf 的退出码（恒 0），node 真实 rc 被吞 →
  // 审计时永远看到 exit=0。必须在 else 口（$? 仍是 node 退出码）先捕获。
  assert.match(sh, /PREFETCH_RC=\$\?/, '在失败分支入口先捕获退出码')
  assert.doesNotMatch(sh, /LINUXDO-PREFETCH-FAIL exit=\$\?/, '日志不得取 printf 之后的 $?（恒 0）')
  assert.match(sh, /LINUXDO-PREFETCH-FAIL exit=\$PREFETCH_RC/, '日志引用捕获的真实退出码')
})

// F1（10-04 review 根因回归）：终态 done 行三态统一收口。
// 旧版只有 ATTEMPT=0 分支写 `done rc=2`，成功/有尝试失败直接落 WALLCLOCK → 进度台 DONE_RE
// 永不命中，恒显示「运行中」。固定：done 行必须(1)覆盖成功路径，(2)在 artifact-check 之后
// （先抢救+自检再判终态），(3)在 WALLCLOCK 之前（progress.mjs 视 done 行为终态边界）。
// 定位用发射专属 needle（`$STAMP done rc=` / `printf 'WALLCLOCK`），杜绝被正文注释抢先匹配。
test('Windows runner：F1 终态三态 done 行收口——成功后必发射，且在 WALLCLOCK 之前', () => {
  const sh = win()
  const artIdx = sh.indexOf('artifact-check.mjs')
  const done0 = sh.indexOf('$STAMP done rc=0 =====')
  const done2 = sh.indexOf('$STAMP done rc=2 (probe-exhausted)')
  const done1 = sh.indexOf('$STAMP done rc=1')
  const wallIdx = sh.indexOf("printf 'WALLCLOCK")
  assert.ok(done0 >= 0 && done2 >= 0 && done1 >= 0, '三态 done 发射点都在场（rc=0 成功 / rc=2 探针耗尽 / rc=1 尝试失败）')
  assert.ok(artIdx >= 0 && done0 > artIdx, 'done 行在 artifact-check 之后（先 host-finalize 抢救+自检再判终态）')
  assert.ok(wallIdx > done0, 'done 行在 WALLCLOCK 之前（progress.mjs 以 done 行为终态，须先于墙钟行）')
  assert.match(sh, /if \[ -f "\$REPORT" \]; then/, '终态块以 REPORT 在场为 rc=0 主判据（抢救成功也计成功）')
  assert.ok(sh.includes(String.raw`done rc=0 (skip-existing)`), "幂等 skip 路径也发射终态行（进度台不显示陈旧终态）")
  // 旧 bug 回归源："成功路径 RC 被强制 0 后 `if [ "$RC" != "0" ]` 跳过 done"——现在必须在 `[ -f "$REPORT" ]` 独立判，不得依赖 RC 分支
  assert.match(sh, /notify "日报未生成/, '失败态通知在场（不再只在成功路径静默）')
  assert.match(sh, /timeout 120 claude -p/, '探针带 120s 墙钟上限（10-04 实证：源站抖动时 CLI 被 hold 12min+，挂起须快速失败）')
})

test('Mac runners（run-daily.sh）：F1 终态三 done 行同样收口（与 win 对齐）', () => {
  const MAC = path.resolve(HERE, '../../../run-daily.sh')
  assert.ok(fs.existsSync(MAC), 'Mac parity runner 在场')
  const sh = fs.readFileSync(MAC, 'utf8')
  const artIdx = sh.indexOf('artifact-check.mjs')
  const done0 = sh.indexOf('$STAMP done rc=0 =====')
  const done2 = sh.indexOf('$STAMP done rc=2 (probe-exhausted)')
  const done1 = sh.indexOf('$STAMP done rc=1')
  const wallIdx = sh.indexOf("printf 'WALLCLOCK")
  assert.ok(done0 >= 0 && done2 >= 0 && done1 >= 0, '三态 done 发射点都在场')
  assert.ok(artIdx >= 0 && done0 > artIdx, 'done 行在 artifact-check 之后')
  assert.ok(wallIdx > done0, 'done 行在 WALLCLOCK 之前')
  assert.ok(sh.includes(String.raw`done rc=0 (skip-existing)`), "幂等 skip 路径也发射终态行")
})
