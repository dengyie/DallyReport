#!/bin/zsh
# ai-daily headless runner — invoked daily by launchd (com.mango.ai-daily).
# Runs the /ai-daily skill inside the Obsidian vault root without a user session.
#
# 8/17 根因：claude -p 的 print 模式对后台任务有 600s 上限（Background tasks still running after 600s; terminating），
# 而健康全量跑 21-31min 远超此限 → 后台 workflow 被中途绞杀、rc 仍报 0 假成功 → 8/16 产物缺失根因。
# 8/18 修复：export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 关闭该上限，等 workflow 真正完成；完成时按产物摘要落 log 供事后检查。
# 8/25 修复：产物路径从 docs/daily/ 迁移到 iCloud AI/DallyReport/<date>/（2026-08-24 起）。旧产物判断恒 false，
#   导致「当日已产出自动跳过」保护失效（可能重复触发无头跑）+ ARTIFACT-OK/FAIL 误报 report_missing。
# 8/26 增强：显式启用 linuxdoCdpHost=127.0.0.1:9222 → linux.do 板每日复用用户常开的 9222 登录态 Chrome 抓取，
#   而非默认 LINUXDO-SKIP 空板。纪律：只复用登录态、只关日报自己开的临时标签，绝不关闭 9222 浏览器本身（用户一直开着）。
# 8/27 Task 2：CDP 抓取隔离到 linuxdo-prefetch.mjs——在调 Workflow 前用宿主 Node 预抓 linux.do，
#   stdout 成功 JSON 写 $LOGDIR/linuxdo-prefetch.json。9/01 P2：JSON 本体不进 claude -p，
#   编排器 Read 该文件后注入 args.linuxdoPrefetched。失败时同一文件写 {ok:false,reason}。
# 9/13 P0-1 编排器韧性：09-06 rc=137、09-07~09-12 连续 6 天 rc=1，全部死于编排器级网关故障
#   （API Error: 400 upstream / ECONNRESET，30s~4min 即死），单发调用无重试无通知 → 连续 7 天无日报无人知。
#   修复三层：① launch 前网关探针循环；② launch 失败且当日产物缺失 → 重新探针后重拉（最多 3 次；
#     仅当该次 launch <10min 即死才重拉——快死是编排器级故障的实测特征，跑满 10min+ 仍无产物属
#     workflow 深处失败，盲目重拉只会白烧 token）；③ 终局失败 → macOS 通知（osascript，best-effort）。
# 9/13 晚间：短问答 `Reply with exactly: OK` 探针假阳性——DeepSeek chat 无工具 200，同一模型
#   带 Read/skill 工具即 `400 Illegal API invocation from an unapproved channel`（08:40 三次
#   PROBE-OK 后 15s/13s/8s 空拉）。探针必须与本次 launch 同模型、同 skip-permissions 的 Read
#   工具路径，并把 API Error / unapproved channel / 11128 当失败。
# 9/13 编排器阶梯：DeepSeek 本身可聊，400=CPA 别名抽到坏渠道。先 deepseek-v4-flash 连打
#   DEEPSEEK_TRIES 次，再按 grok-4.6 → claude-opus-4-8 → gemini-3.7-flash-high 降级，
#   尽量保证有日报；不得把编排器钉死单一模型。
# 9/13 覆盖：launch 时 CLAUDE_CODE_SUBAGENT_MODEL=$MODEL，harvest/discover/fetch 跟档，
#   避免编排器已降 grok 而子代理仍抽 DeepSeek 11128（09-13 午间 8 板 missing 实证）。
#   同档连续 CHANNEL_FAIL_MAX 次「<60s 且 11128/unapproved」立即换档，不打满 DEEPSEEK_TRIES。
# 9/13 跨天账本注入：编排器 Read $LOGDIR/published-ledger.json（finalize.mjs 记账的生产账本；
#   放 HOME 而非 iCloud 是因为 launchd TCC 读不了 Mobile Documents（8/31 P4 实证），HOME 路径有
#   linuxdo-prefetch.json 的成功先例）→ args.reportedLedger，realm 内过滤近 3 天已报道 URL。

LOGDIR="$HOME/.ai-daily"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/run-daily.log"
STAMP="$(date '+%Y-%m-%d %H:%M:%S %Z')"

# Ensure common tool paths (homebrew node) are found in the launchd context.
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# P0 headless 修复（8/18）：关闭 print 模式 600s 后台任务上限。仅 print 模式读取该变量，交互式不受影响。
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0

cd "/Users/mango/project/claude-project/obsidian" || { echo "$STAMP FAIL cd-obsidian exit=$?" >> "$LOG"; exit 1; }

TODAY="$(date '+%F')"
OB_DIR="${HOME}/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/AI/DallyReport/${TODAY}"
REPORT="${OB_DIR}/${TODAY}-ai日报.md"
LEDGER="${LOGDIR}/published-ledger.json"
# 8/31 P1-② 真实墙钟起点（epoch 秒）。realm 内累加器不可信，唯一可信墙钟在宿主侧。
WALL_START="$(date '+%s')"
# 10-05 P1 根因修复：起始 epoch 经 env 传给 finalize（宿主 CLI，claude 子进程继承 env）——
# finalize 用宿主时钟实测回写 meta.wallclock.real_s。realm 看不到探针/模型换档段，手工跑无此
# env 则 fail-open 不回填。
export AI_DAILY_RUN_START_EPOCH="$WALL_START"
WALL_SOFT_LIMIT_S=1800
# 9/13 P0-1 / 编排器阶梯：每档探针几次；DeepSeek 连打几次再换级；快死阈值 600s。
PROBE_RETRY=3
PROBE_WAIT_S=30
DEEPSEEK_TRIES=3
FALLBACK_TRIES=2
CHANNEL_FAIL_MAX=2
LAUNCH_FAST_DEATH_S=600
ORCH_LADDER=(deepseek-v4-flash grok-4.6 claude-opus-4-8 gemini-3.7-flash-high)

# macOS 通知（best-effort：launchd 上下文理论上可用，失败静默不影响主流程）。
notify() {
  osascript -e "display notification \"$2\" with title \"ai-daily\" subtitle \"$1\" sound name \"Basso\"" >/dev/null 2>&1 || true
}

# 网关探针：必须与本次 launch 同模型、同 skip-permissions、同属工具调用类。
# 短问答 OK 会在 DeepSeek chat 200 / tools 400 时放行（09-13 08:40 实证）。
probe_gateway() {
  local model="${1:?}"
  local out
  # 10-04 上午实证：网关源站抖动时 CLI 请求可能被 hold 12 分钟+（SDK 自身超时 3000s），
  # 探针必须自带墙钟上限——挂起快速失败（rc=124 → out 空 → 判 FAIL），否则 PROBE_RETRY=3 每档烧 30+ 分钟。
  out="$(timeout 120 claude -p 'Read the file scripts/ai-daily/test/run-daily-shim.test.mjs. Reply with exactly the GATEWAY-TOOL-PROBE-SENTINEL token from that file. Do not run any skill or workflow.' --model "$model" --dangerously-skip-permissions 2>&1 || true)"
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

# 8/31 P4 复核：同日去重判定无需改 node——launchd 上下文下 `test -f` 属 stat 类操作，实测可用。
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
  echo "===== $STAMP start run-daily（CEILING_MS=0）====="
  # 8/27 Task 2：调用 Workflow 前，先用宿主 Node 预抓 linux.do（linuxdo-prefetch.mjs），
  # 成功 JSON → 注入 linuxdoPrefetched；失败 → 写 ok:false 明确失败态（realm 内不裸抓、不以 stderr 当成功 JSON）。
  # 纪律：只复用 127.0.0.1:9222 已运行的登录态 Chrome；绝不启动/关闭浏览器本体或其它会话资源。
  PREFETCH_JSON="$LOGDIR/linuxdo-prefetch.json"
  # 9/01 P2：预抓 JSON 只落盘。标题/摘要含引号时 $(cat) 插进双引号 claude -p 会破 shell。
  # 编排器 Read 该文件后把对象作为 args.linuxdoPrefetched 传入——JSON 本体永不进 prompt。
  # 9/19 L4：--max-sources 24 = 交付 buffer（质量排序后的候选上限，供 Workflow 窗口过滤后仍有得选）；
  # Workflow 消费配额 linuxdoMaxSources=8 另设，两数语义不同、非矛盾。深抓上限默认 12（质量排序后置）。
  if node "/Users/mango/project/claude-project/obsidian/scripts/ai-daily/linuxdo-prefetch.mjs" --host "127.0.0.1:9222" --max-sources 24 > "$PREFETCH_JSON" 2>> "$LOG"; then
    if [ -s "$PREFETCH_JSON" ]; then
      echo "LINUXDO-PREFETCH-OK json_bytes=$(wc -c < "$PREFETCH_JSON" | tr -d ' ') → 落盘 $PREFETCH_JSON，由编排器 Read 注入 args"
    else
      printf '%s\n' '{"ok":false,"reason":"empty_stdout"}' > "$PREFETCH_JSON"
      echo "LINUXDO-PREFETCH-WARN pid_fail（exit 0 但空 stdout）→ 落盘 ok:false"
    fi
  else
    # 10/04 smoke 实证：`exit=$?` 写在 printf 之后取到的是 printf 的退出码（恒 0），node 真实
    # 退出码被吞 → 日志永远 exit=0，失败原因不可审计。先在 else 入口捕获 node 的 rc 再写 JSON。
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
      LAUNCH_OUT="$(claude -p "运行 ai-daily skill，生成今天的 AI 日报。调用 Workflow 时 args 请带上 {\"linuxdoCdpHost\":\"127.0.0.1:9222\",\"linuxdoMaxSources\":8,\"webFetchViaCdp\":true}（复用 9222 登录态 Chrome 抓 linux.do 与 fetch 正文；论坛配额 8 与模板默认一致，避免挤占官方/一手源）。linuxdoPrefetched 已预抓到文件 $PREFETCH_JSON：请 Read 该文件，把解析后的 JSON 对象作为 args.linuxdoPrefetched 传入（成功为 ok:true + posts；失败为 ok:false + reason）。跨天去重账本 $LEDGER：若该文件存在，请 Read 并把解析后的 JSON 数组作为 args.reportedLedger 传入（不存在则不传该参数，不要视为错误）。不要把任何文件内容贴进本指令或 shell。最后简述头条与覆盖结果。" --model "$MODEL" --dangerously-skip-permissions 2>&1)"
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
  if [ ! -f "$REPORT" ]; then
    node "/Users/mango/project/claude-project/obsidian/scripts/ai-daily/host-finalize.mjs" --date "$TODAY" --out "$OB_DIR" --since-epoch "$WALL_START" \
      || echo "HOST-FINALIZE 未落盘（无匹配 workflow json 或 finalize 失败，rc=$?）→ 交 artifact-check 判定"
  fi

  # 8/18 新增：完成时 artifact 摘要（md 字节数 + meta 统计）落 log，供事后检查"是否真产出、是否降级"。
  # 8/31 P4 修复：自检改由 node 执行（artifact-check.mjs）。根因是 launchd 上下文 /bin/zsh 无 Full
  #   Disk Access——`test -f`/`stat` 允许但**读取**被拒（`wc -c`/`grep` 全 operation not permitted，
  #   实测 18 次）→ 最近 6 次 run 只打空壳 `ARTIFACT-OK md_bytes= confirmed= degraded=`。
  #   node 在同一上下文实测可读（NODE_BYTES=5348、目录可列），故整段自检迁到宿主 Node CLI。
  #   摘要同时补 killed/urls/report_error，且空 degraded 显式写 none（区分「无降级」与「读不到」）。
  if node "/Users/mango/project/claude-project/obsidian/scripts/ai-daily/artifact-check.mjs" --date "$TODAY"; then
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

  # 8/31 P1-② 宿主侧墙钟看门狗：realm 内 _wallMs 累加器在事件循环饱和时只会低估（8/31 实测
  #   低估 4.7–7.6×，4h13m 的 run 零 BUDGET-SKIP），30min 软目标从内部不可强制执行。宿主用真实
  #   epoch 记账，至少让超时**可见**、可被事后审计（不杀进程，避免半成品覆盖已有产物）。
  WALL_END="$(date '+%s')"
  WALL_S=$(( WALL_END - WALL_START ))
  printf 'WALLCLOCK real=%dm%02ds soft_target=30m' "$(( WALL_S / 60 ))" "$(( WALL_S % 60 ))"
  if [ "$WALL_S" -gt "$WALL_SOFT_LIMIT_S" ]; then
    printf ' → OVER by %dm（meta.wallclock.real_s=宿主实测总墙钟；raw/calibrated 仅 workflow 内段）\n' "$(( (WALL_S - WALL_SOFT_LIMIT_S) / 60 ))"
  else
    printf ' → within\n'
  fi
} >> "$LOG" 2>&1

# Keep a bounded history.
ls -t "$LOGDIR"/run-daily*.log* 2>/dev/null | tail -n +20 | xargs -I{} rm -f -- {} 2>/dev/null

exit 0
