---
name: ai-daily
description: 生成 AI 每日日报（自动每天 08:40 由 launchd 触发，也可手动 /ai-daily [--date YYYY-MM-DD]）。确定性覆盖 9 大板块 × 必查厂商花名册，grok-search/X/RSS 发现，对抗式核查，产出 docs/daily/YYYY-MM-DD-ai日报.md + 原始数据存档。
---

# AI 每日日报（ai-daily）

## 何时使用
- 用户要求"今天的 AI 日报 / 今日 AI 新闻 / 每日 AI 简报"。
- 手动补跑历史某天：`/ai-daily --date 2026-08-12`。
- 每日 08:40 由 launchd 以 headless 方式自动触发（无需用户在场）。

## 流程总览
编排器（本 skill，主会话）→ 调用 Workflow 工具跑 `.claude/workflows/ai-daily.js` → 子代理完成发现/抓取/核查/合成并**直接落盘** → 本 skill 汇报摘要 + 降级标记。

## 步骤

### 1. 解析参数
- 读取 `args` 或指令中的 `--date YYYY-MM-DD`；缺省 = 今天（`date +%F`）。
- `--force`：允许覆盖当日已存在的产物（默认若 `docs/daily/<date>-ai日报.md` 已存在则询问是否重跑）。

### 2. 计算日期窗口
- 报告日 T（即 `--date`）；新闻窗口 = **[T-2, T]**（覆盖前两天到当天）。
- 用 Bash 计算：`from=$(date -v-2d +%F)`、`to=$(date +%F)`（若指定 --date 则先对 T 用 `date -j -f %F <T> -v-2d +%F` 计算）。
- 工作目录固定为 `/Users/mango/project/claude-project/obsidian`。

### 3. 准备输出目录
- 确保 `docs/daily/` 存在：`mkdir -p docs/daily`（Obsidian 库内，可被库引用）。
- `outDir` = `/Users/mango/project/claude-project/obsidian/docs/daily`（绝对路径）。

### 4. 调用 Workflow
用 Workflow 工具，`scriptPath: /Users/mango/project/claude-project/obsidian/.claude/workflows/ai-daily.js`，
`args` 传 JSON 对象：

```json
{
  "date": "YYYY-MM-DD",
  "window": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
  "outDir": "/Users/mango/project/claude-project/obsidian/docs/daily",
  "maxFetch": 20,
  "maxVerify": 24,
  "agentTimeoutMs": 480000
}
```

可省略 `maxFetch`/`maxVerify`（默认 20/24）。`agentTimeoutMs` 可选（默认 480000，即 8 分钟；健康 discover 代理约需 6 分钟，余量给足防误杀；单代理超时后自动换新代理重试一次，防止深蹲网关卡死堵住整个阶段）。可选 `"boards": ["labs","strategy",...]` 限定板块子集（冒烟/单板调试用）。

模型策略：本期全链路统一 deepseek-v4-flash（环境已配 `CLAUDE_CODE_SUBAGENT_MODEL`，无需在 args 指定）。勿覆盖模型。

### 5. 收尾与汇报
- 若 Workflow 返回 `artifacts` 且含 `payloads`：**3 个 JSON 由本 orchestrator 主会话逐字节落盘**（`payloads.claims` → `docs/daily/<date>.verified-claims.json`，`payloads.sources` → `docs/daily/<date>.sources.json`，`payloads.meta` → `docs/daily/<date>.meta.json`，用 Write 工具），md 由 workflow 内 mdWriter 代理已直接落盘。
- 确认 `docs/daily/<date>-ai日报.md` 等文件存在，向用户给出：
  - 统计：`stats`（抓取 URL 数 / 提取 claim 数 / 核查数 / 确认数 / 否决数 / **重大超窗事实数 `major_out`**——`[窗口外·重大]` 行业里程碑，非窗口内、未经投票，但应出现在正文/头条并如实标注）
  - 头条一句话：`headline`
  - 执行摘要：`summary`
  - 覆盖矩阵要点 + 确认无动态的厂商
  - **降级标记 `degraded`**（如 discovery_degraded / verify_agent_errors / fetch_budget_dropped）——必须如实转达。
- 若 Workflow 返回 `error` 或产物缺失：降级处理，产出一份"未核查日报"到 `docs/daily/<date>-ai日报.md`（标注降级原因），并保留已归档 JSON；如实向用户说明失败点。
- 不要向用户重复贴全文大 JSON；贴 md 文件路径 + 摘要即可。

## 产出物命名
- `docs/daily/YYYY-MM-DD-ai日报.md`
- `docs/daily/YYYY-MM-DD.verified-claims.json`
- `docs/daily/YYYY-MM-DD.sources.json`
- `docs/daily/YYYY-MM-DD.meta.json`

## 手动补跑示例
```
/ai-daily --date 2026-08-12
/ai-daily --date 2026-08-13 --force
```
