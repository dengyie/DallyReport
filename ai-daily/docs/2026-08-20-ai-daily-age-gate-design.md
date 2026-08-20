# ai-daily KNOWN_MAJOR_OUT Age Gate 设计

## 目标

`KNOWN_MAJOR_OUT` 是 `boards.mjs` 里的硬编码行业里程碑种子数组，作为保底注入每份日报的 `[窗口外·重大]` 节（`ai-daily.template.js` 第 402-403 行）。当前注入逻辑**无任何时效判定**——种子日期停在 2026-07，随时间推移会让每份日报永久掺入陈旧里程碑，内容质量单调下降。

本设计为种子注入加**年龄过滤机制（age gate）**：注入前按种子 `date` 距报告日的天数判龄，超阈值则退役不注入。顺带把种子日期字段对齐成 `normalizeDate` 能消费的精确格式。

## 核心决策（用户已批准）

| 决策 | 取值 | 理由 |
|---|---|---|
| 阈值 `MAX_SEED_AGE_DAYS` | **21 天** | 里程碑"值得浮现"的时效约 2-3 周；让 gate 立刻生效（退役最老的）又不今天清空全部 |
| 无日期种子（`normalizeDate→null`）处理 | **按超期退役** | 无法判龄的里程碑不该永久漂浮；日志可见，非静默 |
| 报告日异常（`REPORT_DAY=null`）处理 | **fail-open 全注入** | 报告日未知时判龄无意义，保留现有行为，不因 gate 清空内容 |
| 阈值是否进 args | **否，硬编码常量** | YAGNI——没有外部调它的需求，与 `TOTAL_LIMIT_MS` 等同级 |

## 现状证据

三个种子的当前日期字段与今天的判龄结果（报告日 2026-08-20）：

| 种子 | 当前 date 字段 | 对齐后 | `normalizeDate` 现状 | 距今天数 | gate 结果（阈值 21） |
|---|---|---|---|---|---|
| DeepSeek V4 开源 | `2026-07-31` | `2026-07-31` | 20260731 ✓ | 20d | 注入（活 1 天） |
| Grok 4.6 发布 | `2026-07下旬` | `2026-07-21` | **null ✗** | 30d（对齐后） | 退役 |
| DeepSeek Harness 组建 | `2026-07` | `2026-07-01` | **null ✗** | 50d（对齐后） | 退役 |

**字段一致性 bug**：当前两个种子日期 `normalizeDate` 返回 null——age gate、`makeClaimWindow`、report 的 Date 字段全靠 `normalizeDate`，这两条永远落入"未知日期"分支。字段对齐是 age gate 的前置。

## 组件分解（三个独立单元）

### 单元 A — 两个纯函数：`daysBetween` + `filterSeedsByAge`

**位置**：新增到 `scripts/ai-daily/date-utils.mjs`。

**`daysBetween(seedDayNum, reportDayNum)`**：输入两个 `normalizeDate` 产出的 `YYYYMMDD` 数值，输出日历天数差（reportDay − seedDay，正数表示 seed 在 report 之前）。

**算法**：纯日历手算（已验证全部边界正确），**无 `new Date()` 依赖**——确定性、workflow realm 安全（realm 禁用 `Date.now()`/`new Date()`，纯函数必须遵守）：

```js
export const daysBetween = (seedDayNum, reportDayNum) => {
  const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const dom = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  const dayNum = (y, m, d) => { let n = 0; for (let Y = 1970; Y < y; Y++) n += isLeap(Y) ? 366 : 365; for (let M = 1; M < m; M++) n += dom(y, M); return n + d }
  const p = n => ({ y: Math.floor(n / 10000), m: Math.floor(n / 100) % 100, d: n % 100 })
  const a = p(seedDayNum), b = p(reportDayNum)
  return dayNum(b.y, b.m, b.d) - dayNum(a.y, a.m, a.d)
}
```

**已验证边界**：
- `daysBetween(20260731, 20260820)` = 20 ✓
- `daysBetween(20260701, 20260820)` = 50 ✓
- `daysBetween(20260820, 20260820)` = 0（同日）✓
- 跨闰年 `daysBetween(20200229, 20200301)` = 1 ✓
- 跨非闰年 `daysBetween(20210228, 20210301)` = 1 ✓

**复用**：是 age gate 和未来任何"日期距今天数"用途的基础。

### 单元 B — 种子日期字段对齐

**位置**：改 `scripts/ai-daily/boards.mjs` 第 53-55 行。

**改动**：仅改日期字符串到精确 `YYYY-MM-DD`，**不动 name/note、不加事件、不删事件**（内容刷新是用户后续独立动作）：

```js
export const KNOWN_MAJOR_OUT = [
  { name: 'DeepSeek V4 Pro / V4 Flash 开源', date: '2026-07-31', note: 'MIT 协议开源，参数规模全球最大开源模型之一，社区广泛采用。' },
  { name: 'DeepSeek Harness 团队组建', date: '2026-07-01', note: '...' },  // 原 '2026-07'
  { name: 'Grok 4.6 发布', date: '2026-07-21', note: '...' },              // 原 '2026-07下旬'
]
```

### 单元 C — 注入点年龄过滤

**位置**：改 `scripts/ai-daily/ai-daily.template.js` 第 402-403 行（KNOWN_MAJOR_OUT 注入循环）。

**改动**（过滤逻辑提取成纯函数 `filterSeedsByAge`，详见测试章节的设计决策——template 编排代码跑不进 node:test，故 gate 逻辑必须可独立单测）：

```js
const REPORT_DAY = normalizeDate(DATE)
const MAX_SEED_AGE_DAYS = 21
// filterSeedsByAge 在 date-utils.mjs（单元 A），含 fail-open：REPORT_DAY==null 时全保留
const freshSeeds = filterSeedsByAge(KNOWN_MAJOR_OUT, REPORT_DAY, MAX_SEED_AGE_DAYS)
const agedOut = KNOWN_MAJOR_OUT.length - freshSeeds.length
for (const m of freshSeeds) _addMajor(m, 'labs')
log('SEED-AGE: 注入 ' + freshSeeds.length + ' / ' + KNOWN_MAJOR_OUT.length + ' 种子（' + agedOut + ' 超期退役，阈值 ' + MAX_SEED_AGE_DAYS + 'd）' + (REPORT_DAY == null ? ' · REPORT_DAY unknown → fail-open 全注入' : ''))
```

`filterSeedsByAge` 的 fail-open 语义：`reportDayNum == null` → 返回原数组（全保留）；否则过滤掉 `seedDay == null || daysBetween(seedDay, reportDayNum) > maxAgeDays` 的种子。

## 数据流

```
报告日 DATE
   ↓ normalizeDate
REPORT_DAY (YYYYMMDD 数值)
   ↓
对每个 KNOWN_MAJOR_OUT 种子 m:
   seedDay = normalizeDate(m.date)
   ├─ seedDay == null        → 退役（agedOut++）
   ├─ daysBetween > 21       → 退役（agedOut++）
   └─ daysBetween <= 21      → _addMajor(m, 'labs')  ← 注入
   ↓
SEED-AGE 日志（注入数 / 总数 / 退役数 / 阈值）
```

`makeAddMajor` 的指纹去重、日期覆盖、`vote:'—'`/`verifiedByVote:false` 反幻觉语义全部不变。

## 错误处理 / 边界

| 场景 | 处理 | 理由 |
|---|---|---|
| 种子无日期（`normalizeDate→null`） | 退役（agedOut++） | 无法判龄的里程碑不该永久漂浮；日志可见 |
| 报告日 `REPORT_DAY=null`（DATE 异常） | **fail-open 全注入**（跳过 gate） | 报告日未知时判龄无意义，保留现有行为，不因 gate 清空 major-out 节 |
| 同日种子（age=0） | 注入 | 0 ≤ 21 |
| 未来日期种子（负 age） | 注入 | 负数 ≤ 21，合理（刚发生的里程碑） |
| `REPORT_DAY=null` 走 fail-open 时 | 日志标明 `REPORT_DAY unknown → fail-open` | 可观测 |

fail-open 实现要点：`REPORT_DAY == null` 时直接走原有的 `for (const m of KNOWN_MAJOR_OUT) _addMajor(m, 'labs')` 路径（即现有行为零改动），gate 仅在 `REPORT_DAY` 有效时启用。

## 测试固化

**位置**：新增 `scripts/ai-daily/test/age-gate.test.mjs`（node:test，与现有 5 个测试文件同构）。

**覆盖**：

1. **`daysBetween` 单元测试**：
   - 基础差（20、50、30 天）
   - 同日 = 0
   - 跨闰年（2020-02-29 → 2020-03-01 = 1）
   - 跨非闰年（2021-02-28 → 2021-03-01 = 1）
   - 跨年（2025-12-31 → 2026-01-01 = 1）
   - 负差（seed 在 report 之后）

2. **age gate 行为测试**（提取注入逻辑为可测纯函数 `filterSeedsByAge(seeds, reportDayNum, maxAgeDays)`，放 date-utils.mjs，template.js 内联调用它）：
   - 种子距报告日 < 阈值 → 保留
   - 种子距报告日 > 阈值 → 过滤
   - 无日期种子（`normalizeDate→null`）→ 过滤
   - `reportDayNum == null` → 全保留（fail-open）

3. **整合断言**：报告日 `20260820`、阈值 21，对当前三个对齐后种子跑 `filterSeedsByAge`，断言保留 `[DeepSeek V4 开源]`、过滤 `[Grok 4.6, DeepSeek Harness]`。

**设计决策**：把注入点的过滤逻辑提取成纯函数 `filterSeedsByAge(seeds, reportDayNum, maxAgeDays)`，而非只在 template 内联——这样 gate 逻辑可直接单测（template.js 的编排代码跑不进 node:test）。template.js 只负责调用 `filterSeedsByAge` + `_addMajor` + 日志。

## 不改的部分（边界）

- 种子**内容刷新**（加 8 月事件、退役语义）——用户后续独立动作，本轮不碰。
- `makeAddMajor` / 指纹去重 / `vote:'—'` / `verifiedByVote:false` 反幻觉语义——原样保留。
- 阈值不进 args。
- 不动 harvest/discover/verify/fetch/report 的预算与 timeout。
- 不动 launchd 自动化、SKILL.md 流程结构（仅追加 changelog）。

## 改动文件清单

| 文件 | 动作 |
|---|---|
| `scripts/ai-daily/date-utils.mjs` | 新增 `daysBetween` + `filterSeedsByAge` 两个纯函数 |
| `scripts/ai-daily/boards.mjs` | 3 个种子日期对齐精确格式（仅日期字符串） |
| `scripts/ai-daily/ai-daily.template.js` | 注入点改用 `filterSeedsByAge` + fail-open + SEED-AGE 日志 |
| `scripts/ai-daily/build.mjs` | 不改（自动 inline） |
| `scripts/ai-daily/test/age-gate.test.mjs` | 新增测试文件 |
| `.claude/workflows/ai-daily.js` | build 重建产物 |
| `.claude/skills/ai-daily/SKILL.md` | 追加 changelog（age gate 语义） |
| `docs/superpowers/specs/2026-08-20-ai-daily-age-gate-design.md` | 本设计文档 |
| `DallyReport/ai-daily/` 三份镜像 | 字节同步 + secret-scan + 提交 |

## 验证门禁

1. `node --test scripts/ai-daily/test/*.test.mjs` 全绿（现有 33 + 新增）。
2. `node --check .claude/workflows/ai-daily.js`（build 后）。
3. 镜像同步校验（md5）。
4. secret-scan（仅 add `ai-daily/`，不碰用户 6 个未提交文件）。
5. SKILL.md + design spec changelog 追加。

## 语义守住（回归清单）

- `[窗口外·重大]` 注入的反幻觉语义不变：`vote:'—'`、`verifiedByVote:false`、`window:'major-out'`，不得冒充窗口内投票确认。
- 种子字段对齐只改日期字符串，不改 name/note（内容刷新独立）。
- gate 是**减少**注入（退役超期），不会引入新的未核查事实。
- fail-open 保证报告日异常时不抛错、不清空 major-out 节。

## Changelog
- 2026-08-20：设计定稿，已由实施计划 task 1-6 落地。
