#!/bin/zsh
# ai-daily headless runner — invoked daily by launchd (com.mango.ai-daily).
# Runs the /ai-daily skill inside the Obsidian vault root without a user session.
#
# 8/17 根因：claude -p 的 print 模式对后台任务有 600s 上限（Background tasks still running after 600s; terminating），
# 而健康全量跑 21-31min 远超此限 → 后台 workflow 被中途绞杀、rc 仍报 0 假成功 → 8/16 产物缺失根因。
# 8/18 修复：export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 关闭该上限，等 workflow 真正完成；完成时按产物摘要落 log 供事后检查。

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
REPORT="docs/daily/${TODAY}-ai日报.md"
if [ -f "$REPORT" ]; then
  {
    echo ""
    echo "===== $STAMP skip — $REPORT already exists（当日报告已产出，自动跳过，避免无头模式下重复运行）====="
  } >> "$LOG" 2>&1
  exit 0
fi

{
  echo ""
  echo "===== $STAMP start run-daily（CEILING_MS=0）====="
  claude -p "运行 ai-daily skill，生成今天的 AI 日报。按 skill 流程执行，最后简述头条与覆盖结果。" --model deepseek-v4-flash --dangerously-skip-permissions 2>&1
  RC=$?
  echo "===== $STAMP done rc=$RC ====="

  # 8/18 新增：完成时 artifact 摘要（md 字节数 + meta 统计）落 log，供事后检查"是否真产出、是否降级"。
  if [ -f "$REPORT" ]; then
    META="docs/daily/${TODAY}.meta.json"
    MD_BYTES=$(wc -c < "$REPORT" | tr -d ' ')
    if [ -f "$META" ]; then
      # 提取 meta.degraded / confirmed 统计（loose parse：不引 jq，用 sed/grep 粗取）
      CONFIRMED=$(grep -o '"confirmed": [0-9]*' "$META" | head -1 | grep -o '[0-9]*')
      DEGRADED=$(grep -o '"degraded": \[[^]]*\]' "$META" | head -1)
      echo "ARTIFACT-OK md_bytes=$MD_BYTES confirmed=$CONFIRMED degraded=$DEGRADED"
    else
      echo "ARTIFACT-OK md_bytes=$MD_BYTES meta_missing"
    fi
  else
    echo "ARTIFACT-FAIL report_missing rc=$RC"
  fi
} >> "$LOG" 2>&1

# Keep a bounded history.
ls -t "$LOGDIR"/run-daily*.log* 2>/dev/null | tail -n +20 | xargs -I{} rm -f -- {} 2>/dev/null

exit 0
