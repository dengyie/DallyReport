#!/bin/zsh
# ai-daily headless runner — invoked daily by launchd (com.mango.ai-daily).
# Runs the /ai-daily skill inside the Obsidian vault root without a user session.

LOGDIR="$HOME/.ai-daily"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/run-daily.log"
STAMP="$(date '+%Y-%m-%d %H:%M:%S %Z')"

# Ensure common tool paths (homebrew node) are found in the launchd context.
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

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
  echo "===== $STAMP start run-daily ====="
  claude -p "运行 ai-daily skill，生成今天的 AI 日报。按 skill 流程执行，最后简述头条与覆盖结果。" --model deepseek-v4-flash --dangerously-skip-permissions 2>&1
  RC=$?
  echo "===== $STAMP done rc=$RC ====="
} >> "$LOG" 2>&1

# Keep a bounded history.
ls -t "$LOGDIR"/run-daily*.log* 2>/dev/null | tail -n +20 | xargs -I{} rm -f -- {} 2>/dev/null

exit 0
