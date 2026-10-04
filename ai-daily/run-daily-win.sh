#!/usr/bin/env bash
# ai-daily headless runner — Windows 版（2026-10-02 迁移自 macOS run-daily.sh）。
# 由 Windows 任务计划程序 `ai-daily` 每日 08:40 经 run-daily-task.cmd 调起（Git Bash）。
# 语义与 Mac 版保持一致：幂等（当日报告已存在则跳过）、网关探针阶梯、快死重拉、
# 产物自检、墙钟审计、日志轮转。差异仅运行环境：
#   - 项目 cwd = Obsidian vault 根 E:/profile/note/note（.claude/workflows + .claude/skills 已拷入）
#   - 宿主 CLI（linuxdo-prefetch / artifact-check / 探针文件）用仓库绝对路径 E:/code/DallyReport/ai-daily
#   - 产物目录 E:/profile/note/note/AI/DallyReport/<date>/，artifact-check 显式传 --dir（默认值已按平台解析：win32 生产根 / Darwin iCloud，AI_DAILY_REPORT_DIR 可覆盖）
#   - 运行时文件 C:/Users/mango/.ai-daily（账本 / 预抓 JSON / 日志）——统一用盘符路径书写，
#     因为这些路径会嵌进 claude -p 的 prompt 由 Read 工具解析，Git Bash 的 /c/ 形式在 Windows 端不可解析
#   - notify() 由 macOS osascript 改为 PowerShell WinRT toast（10-03 §12-④，失败回落纯日志）
#   - linux.do 预抓仍只复用 127.0.0.1:9222 已运行的登录态 Chrome：Windows 上 Chrome 未带 9222 常开时
#     prefetch 如实 ok:false → linux.do 板降级（LINUXDO-SKIP），不阻塞其它板块。

LOGDIR="C:/Users/mango/.ai-daily"
REPO_AI="E:/code/DallyReport/ai-daily"
VAULT="E:/profile/note/note"
LOG="$LOGDIR/run-daily.log"

# 任务计划程序上下文下保证 node / claude 可达（npm 全局 shim 在 AppData\Roaming\npm）。
# P0（10-03 08:40 生产实证）：任务计划程序调起的 bash.exe 非登录 shell，PATH 里没有 Git 的
# /usr/bin → date/seq/tr/wc 全部 command not found：STAMP/TODAY 空串、四档探针被 seq 失败
# 全部打死（零 launch，rc=2 probe-exhausted），整轮空转。补 /usr/bin 后这些 coreutils 可达。
# 纪律（review P3 根因收口）：PATH 导出点之前不得出现任何外部命令——mkdir 也在 /usr/bin，
# 留在前面则 LOGDIR 缺失场景下 mkdir 失败 → 全 run 静默失日志。STAMP 同理必须在导出后取。
export PATH="/e/code/Git/usr/bin:/c/Program Files/nodejs:/c/Users/mango/AppData/Roaming/npm:$PATH"
mkdir -p "$LOGDIR"
# P3（10-03 review）：STAMP 兜底——若 date 仍不可达（PATH 修复失效/异常），不得让所有早退日志
# 变成「 FAIL ...」空时间戳（事后无法定位）。非空兜底至少标明「时间未知」，日志行始终可辨识。
STAMP="$(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null)"
STAMP="${STAMP:-unknown-time}"
# P0 headless 修复（8/18 Mac 实证）：关闭 print 模式 600s 后台任务上限，等 workflow 真正完成。
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0

cd "$VAULT" || { echo "$STAMP FAIL cd-vault exit=$?" >> "$LOG"; exit 1; }

TODAY="$(date '+%F')"
# P0 防御：日期取不到（date 不可达/异常）宁可早退，也不用空 TODAY 构造坏产物路径。
[ -n "$TODAY" ] || { echo "$STAMP FAIL date-unavailable → early exit（不空跑）" >> "$LOG"; exit 1; }
OB_DIR="${VAULT}/AI/DallyReport/${TODAY}"
REPORT="${OB_DIR}/${TODAY}-ai日报.md"
LEDGER="${LOGDIR}/published-ledger.json"
# 8/31 P1-② 真实墙钟起点（epoch 秒）。realm 内累加器不可信，唯一可信墙钟在宿主侧。
WALL_START="$(date '+%s')"
WALL_SOFT_LIMIT_S=1800
# 9/13 P0-1 / 编排器阶梯：每档探针几次；DeepSeek 连打几次再换级；快死阈值 600s。
PROBE_RETRY=3
PROBE_WAIT_S=30
DEEPSEEK_TRIES=3
FALLBACK_TRIES=2
CHANNEL_FAIL_MAX=2
LAUNCH_FAST_DEATH_S=600
# 10/02 网关实证：deepseek-v4-flash 经 claude CLI 静默空回；gemini-3.6-flash 探针可过但
# launch 把指令当闲聊不跑 skill；deepseek 长 40min 回合被网关 Cloudflare 120s（524）打死；
# claude-opus-4-8 手动单发即成稿 → 置首。探针失败档会自动跳过，不空拉。
ORCH_LADDER=(claude-opus-4-8 gemini-3.6-flash deepseek-v4-flash grok-4.6)

# Windows 通知（10-03 §12-④）：PowerShell WinRT toast（任务计划程序上下文可用，无需 BurntToast 模块），
# 失败回落纯日志——通知绝不能影响 run 本体。AppId 用 PowerShell 的已注册 AUMID 免自注册。
# review P3：参数经 ps_escape 把单引号翻倍（PS 单引号字符串转义），文案含撇号不再打断 PS 解析；
# 注意 toast 只在「有交互会话」时可见；纯后台会话 toast 静默失败 → 回落日志行（可见性仍由日志兜底）。
ps_escape() { local s=$1; printf '%s' "${s//\'/\'\'}"; }
notify() {
  echo "NOTIFY $1 :: $2"
  powershell.exe -NoProfile -NonInteractive -Command "
try {
  \$a = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  \$t = \$a.GetElementsByTagName('text')
  \$t.Item(0).AppendChild(\$a.CreateTextNode('$(ps_escape "$1")')) | Out-Null
  \$t.Item(1).AppendChild(\$a.CreateTextNode('$(ps_escape "$2")')) | Out-Null
  \$n = [Windows.UI.Notifications.ToastNotification]::new(\$a)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show(\$n)
} catch { Write-Output (\"toast-fallback-log \" + \$_.Exception.Message) }
" 2>> "$LOG" | grep -q "toast-fallback-log" && echo "NOTIFY-TOAST-FAILED → log-only 兜底" >> "$LOG" || true
}

# 网关探针：必须与本次 launch 同模型、同 skip-permissions、同属工具调用类。
# 短问答 OK 会在 DeepSeek chat 200 / tools 400 时放行（09-13 08:40 实证），故读真实文件取 sentinel。
probe_gateway() {
  local model="${1:?}"
  local out
  # 10-04 上午实证：网关源站抖动时 CLI 请求可能被 hold 12 分钟+（SDK 自身超时 3000s），
  # 探针必须自带墙钟上限——挂起快速失败（rc=124 → out 空 → 判 FAIL），否则 PROBE_RETRY=3 每档烧 30+ 分钟。
  out="$(timeout 120 claude -p "Read the file ${REPO_AI}/scripts/ai-daily/test/run-daily-shim.test.mjs. Reply with exactly the GATEWAY-TOOL-PROBE-SENTINEL token from that file. Do not run any skill or workflow." --model "$model" --dangerously-skip-permissions 2>&1 || true)"
  [[ "$out" != *"API Error"* ]] || return 1
  [[ "$out" != *"unapproved channel"* ]] || return 1
  [[ "$out" != *"11128"* ]] || return 1
  [[ "$out" == *"GATEWAY-TOOL-PROBE-SENTINEL"* ]]
}

# 探针循环：通过即返回 0；PROBE_RETRY 次全失败返回 1（调用方换下一档，不空拉本档）。
probe_wait() {
  local model="${1:?}"
  local i
  for i in $(seq 1 "$PROBE_RETRY"); do
    if probe_gateway "$model"; then
      echo "PROBE-OK model=$model attempt=$i"
      return 0
    fi
    echo "PROBE-FAIL model=$model attempt=$i/$PROBE_RETRY → ${PROBE_WAIT_S}s 后重试"
    [ "$i" -lt "$PROBE_RETRY" ] && sleep "$PROBE_WAIT_S"
  done
  return 1
}

# 同日幂等：当日报告已产出则跳过，避免无头模式下重复运行。
if [ -f "$REPORT" ]; then
  {
    echo ""
    echo "===== $STAMP skip — $REPORT already exists（当日报告已产出，自动跳过，避免无头模式下重复运行）====="
    echo "===== $STAMP done rc=0 (skip-existing) ====="
  } >> "$LOG" 2>&1
  exit 0
fi

{
  echo ""
  echo "===== $STAMP start run-daily-win（CEILING_MS=0）====="
  # 8/27 Task 2：调用 Workflow 前，先用宿主 Node 预抓 linux.do（linuxdo-prefetch.mjs），
  # 成功 JSON → 落盘由编排器 Read 注入 args.linuxdoPrefetched；失败 → 写 ok:false 明确失败态。
  # 纪律：只复用 127.0.0.1:9222 已运行的登录态 Chrome；绝不启动/关闭浏览器本体或其它会话资源。
  PREFETCH_JSON="$LOGDIR/linuxdo-prefetch.json"
  # 9/01 P2：预抓 JSON 只落盘，JSON 本体永不进 claude -p 命令行（标题含引号会破 shell）。
  # 10/03 对齐参考日报：--max-sources 28 = 交付 buffer；--deep-fetch 16 富化更多入选帖正文；
  # Workflow 消费配额 linuxdoMaxSources=12 另设（mint 直铸不占 MAX_FETCH，扩配额成本极低）。
  if node "$REPO_AI/scripts/ai-daily/linuxdo-prefetch.mjs" --host "127.0.0.1:9222" --max-sources 28 --deep-fetch 16 > "$PREFETCH_JSON" 2>> "$LOG"; then
    if [ -s "$PREFETCH_JSON" ]; then
      echo "LINUXDO-PREFETCH-OK json_bytes=$(wc -c < "$PREFETCH_JSON" | tr -d ' ') → 落盘 $PREFETCH_JSON，由编排器 Read 注入 args"
    else
      printf '%s\n' '{"ok":false,"reason":"empty_stdout"}' > "$PREFETCH_JSON"
      echo "LINUXDO-PREFETCH-WARN pid_fail（exit 0 但空 stdout）→ 落盘 ok:false"
    fi
  else
    # 10/04 smoke 实证：`exit=$?` 若写在 printf 之后，取到的是 printf 的退出码（恒 0），
    # node 真实退出码被吞 → 日志永远显示 exit=0，prefetch 失败原因不可审计。先捕获再写 JSON。
    PREFETCH_RC=$?
    printf '%s\n' '{"ok":false,"reason":"prefetch_failed"}' > "$PREFETCH_JSON"
    echo "LINUXDO-PREFETCH-FAIL exit=$PREFETCH_RC → 落盘 ok:false（realm 不裸抓 CDP，linux.do 走降级）"
  fi

  # 9/13 编排器阶梯：DeepSeek 先打（CPA 别名抽签，同档连打几次），不行再 grok/opus/gemini。
  # 每档先工具类探针，探针失败不空拉本档、换下一档。快死（<10min 无产物）才同档重试；
  # 跑满 10min+ 仍无产物属 workflow 深处失败，不盲目重拉也不再爬级。
  RC=1
  ATTEMPT=0
  PREV_MODEL=""
  SLOW_DEATH=0
  for MODEL in "${ORCH_LADDER[@]}"; do
    if [ -n "$PREV_MODEL" ]; then
      echo "MODEL-FALLBACK $PREV_MODEL → $MODEL"
    fi
    PREV_MODEL="$MODEL"
    if [ "$MODEL" = "deepseek-v4-flash" ]; then
      TRIES="$DEEPSEEK_TRIES"
    else
      TRIES="$FALLBACK_TRIES"
    fi
    if ! probe_wait "$MODEL"; then
      echo "PROBE-EXHAUSTED model=$MODEL → 跳过本档，不空拉"
      continue
    fi
    CHANNEL_FAIL=0
    export CLAUDE_CODE_SUBAGENT_MODEL="$MODEL"
    for TRY in $(seq 1 "$TRIES"); do
      ATTEMPT=$((ATTEMPT + 1))
      LAUNCH_T0="$(date '+%s')"
      LAUNCH_OUT="$(claude -p "运行 ai-daily skill，生成今天的 AI 日报。调用 Workflow 时 args 请带上 {\"linuxdoCdpHost\":\"127.0.0.1:9222\",\"linuxdoMaxSources\":12,\"webFetchViaCdp\":true}（复用 9222 登录态 Chrome 抓 linux.do 与 fetch 正文；论坛配额 12 与模板默认一致——mint 直铸不占 fetch 配额，供「社区热度」叙事仍有得选）。linuxdoPrefetched 已预抓到文件 $PREFETCH_JSON：请 Read 该文件，把解析后的 JSON 对象作为 args.linuxdoPrefetched 传入（成功为 ok:true + posts；失败为 ok:false + reason）。跨天去重账本 $LEDGER：若该文件存在，请 Read 并把解析后的 JSON 数组作为 args.reportedLedger 传入（不存在则不传该参数，不要视为错误）。不要把任何文件内容贴进本指令或 shell。最后简述头条与覆盖结果。" --model "$MODEL" --dangerously-skip-permissions 2>&1)"
      RC=$?
      printf '%s\n' "$LAUNCH_OUT"
      LAUNCH_SECS=$(( $(date '+%s') - LAUNCH_T0 ))
      echo "LAUNCH attempt=$ATTEMPT model=$MODEL try=$TRY/$TRIES rc=$RC secs=$LAUNCH_SECS"
      if [ -f "$REPORT" ]; then
        echo "REPORT-EXISTS 当日产物已落盘（model=$MODEL attempt=$ATTEMPT）→ 视为成功"
        RC=0
        break 2
      fi
      if [ "$LAUNCH_SECS" -ge "$LAUNCH_FAST_DEATH_S" ]; then
        echo "RELAUNCH-SKIP 该次 launch 跑满 ${LAUNCH_SECS}s（≥${LAUNCH_FAST_DEATH_S}s）仍无产物 → workflow 深处失败，不盲目重拉"
        SLOW_DEATH=1
        break 2
      fi
      if [[ "$LAUNCH_OUT" == *"API Error"* || "$LAUNCH_OUT" == *"unapproved channel"* || "$LAUNCH_OUT" == *"11128"* ]] && [ "$LAUNCH_SECS" -lt 60 ]; then
        CHANNEL_FAIL=$((CHANNEL_FAIL + 1))
        echo "CHANNEL-FAIL model=$MODEL n=$CHANNEL_FAIL/$CHANNEL_FAIL_MAX secs=$LAUNCH_SECS"
        if [ "$CHANNEL_FAIL" -ge "$CHANNEL_FAIL_MAX" ]; then
          echo "CHANNEL-FAIL-SKIP model=$MODEL 连续 ${CHANNEL_FAIL} 次 11128 快死 → 换档"
          break
        fi
      else
        CHANNEL_FAIL=0
      fi
      if [ "$TRY" -lt "$TRIES" ]; then
        echo "RELAUNCH-WAIT 快死（${LAUNCH_SECS}s < ${LAUNCH_FAST_DEATH_S}s）model=$MODEL → 同档重试"
        probe_wait "$MODEL" || echo "PROBE-FAIL 同档重拉前探针未通过 → 仍执行下一次同档重拉"
      fi
    done
  done
  if [ "$RC" != "0" ] && [ ! -f "$REPORT" ]; then
    # 终端状态发射统一收在 artifact-check 之后的终态块（probe 全灭仍有 rc=2 行、宿主失败有 rc=1 行）。
    # 本块仅保留语义提示，不再发射 done 行——done 行必须覆盖成功路径（F1 10-04 review：旧版只有
    # ATTEMPT=0 分支写 done，成功/有尝试失败直接落 WALLCLOCK → 进度台终态永不可达）。
    if [ "$ATTEMPT" -eq 0 ]; then
      echo "（终态见下方 done 行：rc=2 probe-exhausted，探针全阶梯失败 → 本次 run 放弃不空拉）"
    else
      echo "（终态见下方 done 行：rc=1，编排器阶梯耗尽 slow_death=$SLOW_DEATH）"
    fi
  fi

  # 09-20 夜 P0 根因：编排器可能在 realm status=completed、payloads 齐全后 422 死在 Write 前，
  # 落盘仍 LLM-mediated → out/ 空 → artifact-check 必 FAIL。宿主侧确定性兜底：从
  # ~/.claude/projects/<cwd-slug>/<uuid>/workflows/wf_*.json 找回 payloads 并 spawn finalize 落盘。
  # 必须在 artifact-check 之前跑（SKILL.md §5 契约）；报告已在盘上时本 CLI 自打 SKIP 不覆写。
  # --since-epoch 传本轮墙钟起点，防止误收上一次 run 的旧 workflow json。
  if [ ! -f "$REPORT" ]; then
    node "$REPO_AI/scripts/ai-daily/host-finalize.mjs" --date "$TODAY" --out "$OB_DIR" --since-epoch "$WALL_START" \
      || echo "HOST-FINALIZE 未落盘（无匹配 workflow json 或 finalize 失败，rc=$?）→ 交 artifact-check 判定"
  fi

  # 8/31 P4：产物自检由宿主 Node 执行（shell 在无头上下文读 iCloud 会被拒的历史；Windows 上
  # 直接显式传 --dir，不依赖其 Mac 默认路径）。摘要含 md_bytes / confirmed / degraded / killed。
  if node "$REPO_AI/scripts/ai-daily/artifact-check.mjs" --date "$TODAY" --dir "${VAULT}/AI/DallyReport"; then
    :
  else
    echo "（自检判定产物缺失 · claude rc=$RC）"
    notify "日报产物缺失 $TODAY" "artifact-check 未找到当日日报，claude rc=$RC"
  fi

  # 终态行（F1 根因修复：进度台 DONE_RE 唯一发射点，成功/失败/探针耗尽三态都必须有）：
  #   rc=0  产物在场（含 host-finalize 抢救成功——抢救后 REPORT 已存在，成功语义优先于 launch rc）；
  #   rc=2  零次 launch（网关探针全阶梯失败，无实际尝试）；
  #   rc=1  有尝试但最终无产物（claude rc=$RC / slow-death）。
  # 注意此前旧版：成功路径 RC 被强制 0 后 `if [ "$RC" != "0" ]` 直接跳过 done 发射 —— 进度台
  # 会永远显示「运行中」。三态统一收口在此处，先于 WALLCLOCK 行（progress.mjs 以 done 行为终态）。
  if [ -f "$REPORT" ]; then
    echo "===== $STAMP done rc=0 ====="
  elif [ "$ATTEMPT" -eq 0 ]; then
    echo "===== $STAMP done rc=2 (probe-exhausted) ====="
    notify "日报未生成 $TODAY" "网关探针全阶梯失败，launch 放弃"
  else
    echo "===== $STAMP done rc=1 ====="
    notify "日报未生成 $TODAY" "claude rc=$RC，编排器阶梯耗尽仍失败 slow_death=$SLOW_DEATH"
  fi

  # 8/31 P1-② 宿主侧墙钟看门狗：30min 软目标超时可见、可事后审计（不杀进程）。
  WALL_END="$(date '+%s')"
  WALL_S=$(( WALL_END - WALL_START ))
  printf 'WALLCLOCK real=%dm%02ds soft_target=30m' "$(( WALL_S / 60 ))" "$(( WALL_S % 60 ))"
  if [ "$WALL_S" -gt "$WALL_SOFT_LIMIT_S" ]; then
    printf ' → OVER by %dm（realm 累加器低估，见运维笔记 P1）\n' "$(( (WALL_S - WALL_SOFT_LIMIT_S) / 60 ))"
  else
    printf ' → within\n'
  fi
} >> "$LOG" 2>&1

# Keep a bounded history.
ls -t "$LOGDIR"/run-daily*.log* 2>/dev/null | tail -n +20 | xargs -I{} rm -f -- {} 2>/dev/null
