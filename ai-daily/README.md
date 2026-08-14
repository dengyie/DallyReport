# ai-daily — 确定性 AI 日报系统（新一代）

> 取代 DallyReport 旧版日报生成器的下一代系统：**9 大板块 × 必查厂商花名册**的确定性覆盖，grok-search / X / RSS 发现，3 票对抗核查，产出 Markdown 日报 + 原始数据 JSON 存档。

## 运行方式

以 Claude Code Workflow 运行，两个入口：

- **每日自动**：macOS launchd（`com.mango.ai-daily.plist`）→ `run-daily.sh`（headless `claude -p`）→ 本 skill，每天 08:40 产出当日日报到 Obsidian 库 `docs/daily/`。
- **手动**：`/ai-daily`（skill），支持 `--date YYYY-MM-DD` 补历史 / `--force` 重跑。

运行时文件加载自 Obsidian 库 `.claude/`：`.claude/workflows/ai-daily.js` + `.claude/skills/ai-daily/SKILL.md`。**本目录是版本管理副本**，修改以库内源文件为准，改完同步回本目录再提交。

## 目录结构

```
ai-daily/
├── .claude/
│   ├── workflows/ai-daily.js        # 核心 workflow（发现 / 抓取 / 核查 / 合成 / 落盘）
│   └── skills/ai-daily/SKILL.md     # skill 编排器（窗口计算、payloads 落盘、降级汇报）
├── docs/
│   └── 2026-08-13-ai-daily-report-design.md  # 设计规格（含历次优化 changelog）
├── run-daily.sh                     # launchd 无头运行器（幂等：当日报告已存在则跳过）
├── README.md
└── .gitignore
```

## 关键机制

- **确定性覆盖**：固定 9 板块（头部实验室·新模型 / 重磅头条 / 产品硬件 / 开源 / 学术 / 融资并购 / 政策监管 / 安全伦理 / 人才流动）× 23 家必查厂商花名册；覆盖自检输出每家"有动态 / 无动态 / 未达"三态。
- **发现层解耦**：grok-search（X 官方 handle / 官方 RSS / Tavily / Exa 多 provider）做 seed 扫描；workflow 内 harvest-once 预抓共享 feed + 板间轮询公平分配 fetch 预算；内建 WebSearch 仅兜底（配额敏感，≤10 次/轮）。
- **对抗式核查**：每 claim 3 票 refute 优先（≥2 票否决），不足补轮至满、最多 2 轮；核查为纯内部一致性判断（禁用 WebSearch/WebFetch）；per-agent 死线 + 全新代理重试一次，防深蹲网关卡死整条流水线。
- **窗口两档**：窗口内 `[T-2, T]` 入正文；**重大超窗事实**（行业里程碑级、多源公认客观事件，如 Grok 4.6 / DeepSeek V4 / Harness）标注 `[窗口外·重大]`直入正文与头条，但**不得冒充窗口内投票**（`vote:'—'` + `verifiedByVote:false`）；次要超窗项仅入文末 `## 📎 窗口外参考`。
- **落盘可靠**：md 由 mdWriter 代理（Write 工具）落盘；3 个 JSON（claims / sources / meta）由 workflow 把 payload 字符串原样返回、主会话逐字节 Write 落盘（不再走 base64 转录——LLM 无法保证字节级复写）。
- **模型**：全链路 `deepseek-v4-flash`（环境经 `CLAUDE_CODE_SUBAGENT_MODEL` 配置，勿在 args 覆盖）。

## 降级与失败处理

- `discovery_degraded` / `verify_agent_errors` / `fetch_budget_dropped` / `write_failed` 等标记如实进入 meta.json `degraded` 与给用户的汇报。
- 核查全挂 → 出"未核查日报"（标注并保留原始 claims）；终稿失败 → 保留已验证数据归档，不丢弃。

## 相关

- 密钥：grok-search API key 运行时从本机 grok-search 配置加载，**不入库、不进任何 prompt/log/命令行**。
- 旧版系统：仓库根 README / `src/`（Node 实现的旧日报生成器，本目录为其后续替代）。