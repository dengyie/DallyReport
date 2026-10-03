# ai-daily — 确定性 AI 日报系统

> **10 大板块 × 必查厂商花名册**的确定性覆盖，分组发现 + 2+1 对抗核查 + 跨天账本硬去重，产出 Markdown 日报（含今日亮点 / 昨日话题追踪 / 社区热度 / 数据概览 / 趋势综述五要素）+ 原始数据 JSON 存档 + 海报。

## 运行方式

- **每日自动（生产，Windows 唯一）**：任务计划程序 `ai-daily`（每日 08:40）→ `run-daily-task.cmd` → `run-daily-win.sh`（幂等 / linuxdo 预抓 / 编排器阶梯 / 产物自检 / 墙钟审计），产出到 Obsidian vault `AI/DallyReport/<date>/`。
- **手动**：`/ai-daily`（skill），支持 `--date YYYY-MM-DD` 补历史（⚠️ Iron Rule：已有产物的日期禁止 `--date` 全量重跑修复，单节修复 only）/ `--force` 重跑当日。

运行时文件加载自 vault `.claude/`：`.claude/workflows/ai-daily.js` + `.claude/skills/ai-daily/SKILL.md`。**本目录是版本管理真源**——改 `.mjs` 模块 / `ai-daily.template.js` → `node scripts/ai-daily/build.mjs` → cp 产物与 SKILL.md 同步到 vault。

## 目录结构

```
ai-daily/
├── scripts/ai-daily/*.mjs          # 15 个逻辑模块真源 + 6 个宿主 CLI + test/（32 个测试文件）
├── scripts/ai-daily/ai-daily.template.js  # 编排骨架（realm 适配 + 五阶段编排）
├── .claude/workflows/ai-daily.js   # build 产物（3354 行自包含，勿手改）
├── .claude/skills/ai-daily/SKILL.md
├── run-daily-win.sh                # Windows 生产运行器
├── run-daily-task.cmd / register-task.ps1
├── docs/development.md             # 开发文档（唯一总纲：架构/模块契约/预算/降级旗标/测试）
└── docs/2026-08-*.md               # dated 历史设计快照（已归档）
```

## 关键机制（详见 [docs/development.md](docs/development.md)）

- **五阶段流水线**：Harvest（分组批量串行抓 feed → 紧凑 digest）→ Discover（分组发现 + linuxdo 三态消费 + 三级兜底）→ Fetch（板间轮询公平配额 + linuxdo mint 直铸不占配额）→ Verify（2+1 自适应对抗投票 + forum/blog 外部抽查票）→ Synthesize（模型阶梯合成 + render-md 确定性渲染，md 必然成功）。
- **确定性覆盖**：10 板块（含 linux.do 前沿快讯）× 23 家必查厂商花名册；覆盖自检输出每家「有动态 / 无动态 / 未达」三态。
- **质量**：每 claim 带来源链接 / publishDate / 可信度；重大超窗事实 `[窗口外·重大]` 直入正文但不冒充投票；report 幻觉引用确定性过滤；日报正文写「社区」不点名站名。
- **跨天账本**：`~/.ai-daily/published-ledger.json`（HOME），近 3 天已报道 URL/同事件硬去重 + 种子报过即退役 + 昨日话题追踪（连续 N 天 + 本次新增）。
- **落盘可靠**：workflow 只 return payloads 不写盘（realm 无 fs）；宿主 `finalize.mjs` 逐字节落盘 + 账本记账（先落盘后记账）+ 海报；编排器死亡时 `host-finalize.mjs` 从 workflow journal 找回。
- **模型**：realm 内 report/verify 走四级换模阶梯（TRANSIENT-only）；宿主编排器阶梯 `claude-opus-4-8` 置首（10/02 网关实证）。

## 降级与失败处理

- 全量降级旗标见 [docs/development.md](docs/development.md) §7（`discovery_degraded` / `fetch_budget_dropped` / `budget_skipped` / `breaker_open` / `wallclock_starved` / `ledger_unavailable` 等）——如实进 meta.json `degraded` 与用户汇报，不得静默。
- report 阶梯全废 → 降级版 md（raw archive）仍落盘；核查全挂 → 「未核查日报」。

## 相关

- **运维/排障**：vault `Note/infra/ai-daily Workflow 运维.md`（权威入口，含变更记录）。
- 密钥：grok-search API key / LINUXDO_COOKIE 运行时加载，**不入库、不进任何 prompt/log/命令行**。
- 旧版系统：仓库根 README / `src/`（Node 实现的旧日报生成器，本目录为其替代）。
