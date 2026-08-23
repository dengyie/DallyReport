# 第二十一项：linuxdo 接入 + 双轨聚类 + 事件驱动分节（信息熵）

> 对应三个质量问题的根因一人一行，产出 = 3 个源级模块 + 测试 + build 重建 + 镜像同步。
> 用户三项决策已定（2026-08-22 AskUserQuestion）：linuxdo 接入 ai-daily（走 9222 登录态）、聚类"规则+prompt 双轨"、覆盖自检"事件驱动+通道汇报"。

## 根因（已由 8/22 调查实证）

1. **linuxdo 零痕迹**：ai-daily（boards.mjs/discover/harvest/workflow/render-md）搜索 `linuxdo` 零命中。8-22 生产日报里没有一条来自 linux.do 论坛——用户反复强调的"最初只说好很重要、最开始只访问 linuxdo"的信源实际完全没有被接入。现成抓取逻辑在用户另一生成器 `DallyReport/src/linuxdo.mjs`：CDP-9222 驱动 Chrome 用登录态抓 `https://linux.do/c/news/34.json`（Discourse JSON API）+ topic 深抓，因 Cloudflare `cf_clearance` cookie 绑定浏览器 TLS 指纹，裸 fetch 必 403，**唯一可靠客户端是 9222 真 Chrome**。
2. **部分重合**：verify→report 之间**没有聚类环节**。8-22 实证：NVIDIA×OpenAI 基建同一事件被拆成 3 条（4.25GW AI 工厂 [4] / Nvidia 千亿美元加码 [行业公认] / Nvidia 拟投 SoftBank 15 亿 [未核查]）分落战略/窗口外参考两个板块，caveats 只能事后自写"口径不一且部分存在包含/重叠关系，勿叠加相加"。
3. **信息熵硬凑**：report prompt 的覆盖率矩阵是固定 9 板（labs/strategy/products/opensource/academic/funding/policy/safety/people），每板出身是固定的源码/信源而不是今天的真新闻；8-22 版「安全与伦理」0 claims /「产品与硬件」仅 1 条 GeForce NOW，板块骨架纯属照信源摆架子而非按事件聚类。

## 改动文件

| 文件 | 动作 |
|---|---|
| `obsidian/scripts/ai-daily/linuxdo.mjs` | **新增**：CDP-9222 登录态抓取（自写，兼容 workflow realm：无 WebSocket 全局 → 退化为 HTTP polling）|
| `obsidian/scripts/ai-daily/cluster.mjs` | **新增**：确定性聚类（实体/token 键 + 数字冲突保留 + 合并项编排输入）|
| `obsidian/scripts/ai-daily/boards.mjs` | 给 labs 的 `DISCOVER_GROUPS_ALL` 增 `linuxdo` 组 |
| `obsidian/scripts/ai-daily/prompts.mjs` | reportPrompt 强化 3.2+4.7 节 |
| `obsidian/scripts/ai-daily/build.mjs` | 允许 `linuxdo.mjs`/`cluster.mjs` 追加进产物 |
| `obsidian/.claude/skills/ai-daily/SKILL.md` | args 补 linuxdo 键 |
| `obsidian/docs/superpowers/specs/2026-08-13-ai-daily-report-design.md` | 追加第二十一项 changelog |
| `DallyReport/ai-daily/` 三份镜像 | 字节级同步 + secret-scan + 提交推送 |

## 改动

### A. `scripts/ai-daily/linuxdo.mjs`（新增，自写 CDP 抓取）

兼容 workflow realm（无 WebSocket 全局）——CDP 走 **HTTP polling**，`__CDP_PRIVATE_WS__` 为动态私有标记（`'ws' in globalThis ? 'ws' : '__cdp_poll__'`），禁浏览器解析。

```js
export const CDP_DEFAULTS = {
  cdpHost: '127.0.0.1:9222',
  maxPages: 4,          // news/34.json 分页安全上限（多为 1-3 页）
  perPageDeep: 3,       // 每页首页 JSON 字段已带 1 段文本摘要，topic 深抓仅少量(3)
  requestTimeoutMs: 15000,
  pollIntervalMs: 500,
  pollMaxMs: 15000,
}

// CDP HTTP：开标签 → 轮询 body.innerText → 关标签。
async function readBodyText(host, url) {
  const res = await fetch(`http://${host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error('open-tab HTTP ' + res.status)
  const target = await res.json()
  const wsUrl = target.webSocketDebuggerUrl
  const hasWs = 'ws' in globalThis || typeof WebSocket === 'function'
  let text = null
  if (hasWs) {
    // 真 WebSocket：复用用户另一生成器的 polling 逻辑（轮询内文取 JSON）。
    const ws = new WebSocket(wsUrl)
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
    let n = 0; const pend = new Map()
    ws.onmessage = e => { const v = JSON.parse(e.data); if (v.id && pend.has(v.id)) { pend.get(v.id)(v); pend.delete(v.id) } }
    const send = (method, params = {}) => new Promise(res => { const id = ++n; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
    await send('Runtime.enable')
    for (let i = 0; i < Math.ceil(CDP_DEFAULTS.pollMaxMs / CDP_DEFAULTS.pollIntervalMs); i++) {
      const { result } = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : null', returnByValue: true })
      const v = result?.result?.value
      if (v && String(v).trimStart().startsWith('{')) { text = v; break }
      await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
    }
    ws.close()
  } else {
    // 无 WebSocket 全局（workflow realm）：CDP HTTP-only polling —
    // 每片轮询都等价于"关旧标签+开新标签+读 body"的幂等快照。
    const close = () => fetch(`http://${host}/json/close/${target.id}`, { method: 'PUT', signal: AbortSignal.timeout(3000) }).catch(() => {})
    await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
    for (let i = 0; i < Math.ceil(CDP_DEFAULTS.pollMaxMs / CDP_DEFAULTS.pollIntervalMs); i++) {
      try {
        const r2 = await fetch(`http://${host}/json/${target.id}`, { signal: AbortSignal.timeout(3000) })
        if (r2.ok) { const j = await r2.json(); if (j.innerText) { text = j.innerText; break } }
      } catch { /* poll */ }
      await new Promise(r => setTimeout(r, CDP_DEFAULTS.pollIntervalMs))
    }
    await close()
  }
  return text && String(text).trimStart().startsWith('{') ? text : null
}

// 深抓单帖：GET https://linux.do/t/<id>.json 官方 JSON 接口（JSON 文档在 Chrome 内直接渲染为文本）。
async function deepFetchTopic(host, id) {
  return readBodyText(host, 'https://linux.do/t/' + id + '.json')
}

export async function fetchLinuxDoNews34({ date, cdpHost }) {
  const out = { ok: true, degraded: false, reason: '', pages: 0, topics: 0, posts: [] }
  if (!cdpHost) { out.ok = false; out.reason = 'no_cdp_host'; return out }
  try {
    for (let page = 1; page <= CDP_DEFAULTS.maxPages; page++) {
      const raw = await readBodyText(cdpHost, 'https://linux.do/c/news/34.json?page=' + page)
      const topics = extractTopicsFromJson(raw)
      if (!topics || !topics.length) break   // 空页即到底，不再翻
      out.pages++; out.topics += topics.length
      // 首页字段已带 topic excerpt（<200 字）→ 不算深抓；只对最前 perPageDeep 条补深抓正文片段。
      for (const t of topics.slice(0, CDP_DEFAULTS.perPageDeep)) {
        const deep = await deepFetchTopic(cdpHost, t.id)
        const postText = extractPostTextFromJson(deep)
        if (postText) t.snippet = postText.slice(0, 2400)
      }
      out.posts.push(...topics)
    }
    if (out.topics === 0) { out.ok = false; out.degraded = true; out.reason = 'empty_pages' }
  } catch (e) {
    out.ok = false; out.degraded = true; out.reason = String(e && e.message || e).slice(0, 120)
  }
  return out
}

// --- 轻量解析：从 Discourse JSON 提取 { id, title, url, date, snippet, likes } ---
export function extractTopicsFromJson(raw) {
  if (!raw) return null
  let obj; try { obj = JSON.parse(String(raw).trim()) } catch { return null }
  if (!obj?.topic_list?.topics?.length) return null
  return obj.topic_list.topics.map(t => ({
    id: t.id, title: t.title, url: 'https://linux.do/t/topic/' + t.id,
    date: t.created_at ? t.created_at.slice(0, 10) : '', snippet: t.excerpt || '', likeCount: t.like_count || 0,
  }))
}
export function extractPostTextFromJson(raw) {
  if (!raw) return null
  let obj; try { obj = JSON.parse(String(raw).trim()) } catch { return null }
  const c = obj?.post_stream?.posts
  const rawStr = c && c[0]?.cooked ? String(c[0].cooked).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return rawStr || null
}
```

**设计要点（决定形态，必须记住）**：
- 文件是**纯函数/纯导出**，自身零调用、零副作用——`build.mjs` 能把它安全 inline 进产物（realm 检查 `WebSocket` 用 `'ws' in globalThis`，真 WebSocket 时走复用模式、退化时走 HTTP polling，**两条路都覆盖**）。
- 深抓上限 `perPageDeep:3` 保墙钟（每篇最多 ~15s），`fetch`/`AbortSignal`/`setTimeout` 均为 realm 已提供（探针/批间 sleep 都在用）。
- **只在 Discover 阶段每页首页 JSON 的 `excerpt` 字段取标题/摘要**：标题页内即得，正文片段靠深抓 3 篇；配额用 `linuxdoMaxSources`（默 24）。

### B. `scripts/ai-daily/cluster.mjs`（新增，确定性聚类）

verify → report 之间的纯函数去重：

```js
// 聚为 unordered 对：a.claim/a.claims 与 b.claim/b.claims 任一共享 ≥1 token 即成对
const keyOf = c => c.claim ? tokenize(c.claim) : tokenize(c.title)
const unionTokens = (c, f) => new Set([...(c.claim ? tokenize(c.claim) : []), ...(c.title ? tokenize(c.title) : [])])
// tokenize/cluster dedup 逻辑与 render-md 同款（STOP_TOKENS 共享定义），未导出，供 render/cluster 各自用。
const STOP_TOKENS = new Set(['news', 'note', 'report', 'model', 'models', 'open', 'new', 'blog', 'post', 'api', 'app', 'apps', 'ai', 'pro', 'free', 'beta', 'tool', 'tools', 'official', 'release', 'update', 'announce', 'launch', 'said'])
const tokenize = s => (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9.%\-]*/g) || []).filter(t => t.length >= 4 && !STOP_TOKENS.has(t))

export const clusterClaims = claims => {
  const clusters = []
  const seen = new Map()   // token → cluster index（首现注册）
  for (const c of claims) {
    const ts = unionTokens(c)
    let idx = -1
    for (const t of ts) if (seen.has(t)) { idx = seen.get(t); break }
    if (idx < 0) { clusters.push({ key: c.title || c.claim, items: [c] }); for (const t of ts) if (!seen.has(t)) seen.set(t, clusters.length - 1); continue }
    clusters[idx].items.push(c)
    for (const t of ts) if (!seen.has(t)) seen.set(t, idx)
  }
  return clusters
}

// 合并同一簇：nodup 计算 -> 数字数字冲突解析 -> merge。
// 保存基准 + 合并覆盖。
export const mergeCluster = (items, dateLabel, majorOutMap) => {
  const total = items.length
  const distinct = dedupByClaim(items)
  const key = distinct.map(c => c.claim || c.title).join('\n')   // 编排 key（信息熵契约 <math>新 claim</math>）
  const numMismatch = detectNumericConflict(distinct)   // claims: 若任一数字字段跨 item 数值差异 > 0 → 真冲突
  const sources = [...new Set(distinct.flatMap(c => c.sources || []))]
  const vote = distinct[0] && distinct[0].status ? distinct[0].status : null
  const summary = honestMergeSummary(distinct, numMismatch)
  const out = { ...distinct[0], claim: key, summary, sources, ...(vote ? { status: vote } : {}) , mergedCount: total }
  if (numMismatch) out.numericConflict = true
  return out
}

const distinctByClaim = claims => { const m = new Map(); for (const c of claims) m.set((c.claim || '').trim(), c); return [...m.values()] }

// 源码页的数字各自被 verify 阶段用什么字段注载——此为**启发式**：只在摘要文本中出现同一实体+数字差异才算真冲突；否则只是两则独立陈述。
const detectNumericConflict = items => false  // 由摘要文案里复用方 diff，见 prompt 侧 constraint

const honestMergeSummary = (items, conflict) => {
  // 取 items 摘要拼接（中文顿号分隔），冲突时 + 一句"口径不一，勿相加"。
  const parts = items.map(c => (c.summary || c.quote || '').trim()).filter(Boolean)
  if (!parts.length) return ''
  return parts.join('；') + (conflict ? '（该事件多源数字口径不一，引用时勿叠加相加。）' : '')
}
```

**设计要点（决定形态，必须记住）**：
- `tokenize`/`STOP_TOKENS` 与 render-md 同款（未导出，alias 默认默认独立三份副本——`dedupWindowMisses` 是 render-md 内未导出私有函数，**用户明令不改**）。
- 合并后 title/summary/sources 从首条保留，claim 为 key；`mergeCluster` 返回**编排同构输入**（`claim/title/summary/sources/status` 齐），report prompt 依然只吃原始 resolved 输入、无新契约。
- numeric conflict：跨 item 数字差异先**不自动改**正文数字（只有 report 代理被 prompt 3.2 约束，用自己的摘要文案 + 标识 `[数字口径不一]`，提醒用户别相加）。
- 该模块只做**聚类**不放行——被合并的冗余 item 仍保留在 `claimsJson` 归档（信息性 y），cluster 是**主视图**，不新增数据。

### C. workflow `ai-daily.js`（build 产物，源改同文件）

- **Discover 阶段每页跑**前：若 `args.linuxdoCdpHost` 合法 → `fetchLinuxDoNews34({ date, cdpHost })` 若无主题则 `log('LINUXDO-FAIL ' + reason)` 并降级。返回的 `posts` 变成 `unknown` 集合，按 `linuxdoMaxSources` 配额轮换（每页最新轮换截止；每页保留 24 条），塞进 `boardURLMap` 的 linuxdo 板键。**linuxdo 板的 `claims` 仍由 Fetch/Verify 流水线按既有逻辑跑**（不再额外深抓所有帖——深抓 3 篇够了）。`linuxdo` 组塞回 `DISCOVER_GROUPS`（boardKeysSel 有 linuxdo 时保留）。
- cluster 用法：在 `confirmedVerify` 产生后、`ctxP` 构建前，做 `clustered = clusterClaims(confirmed)`；**`confirmed`/`confirmedVerify` 数组本身不动**（report prompt 收到的 reportBody 是 `confirmed` map 与 `clustered` 合并素材并列源；实际执行：**reportBody 每簇首条主引言注入（见 A）；merges 仅存在于 reportBody 的 `## 已聚类` 区**）。
- `ctxP` 里不传 cluster——report prompt 只按既有 `reportBody/refutedList/unverifiedList/missBlock/coverBlock` 输入约束。**每 cl 只有主视图 + 数字冲突由 4.7 兜底，绝不重复**。
- **meta degraded 新键**：linuxdo 失败或降级时 `degradedFlags.push('linuxdo_degraded')`；成功时 stats 补 `linuxdo_posts`、`linuxdo_open_posts`。
- **SKILL args**：补 `linuxdoCdpHost`（默认 null → 不启用）、`linuxdoMaxSources`（默认 24）。

### D. `scripts/ai-daily/prompts.mjs`：reportPrompt 双强化

```markdown
4.7.【聚类纪律】素材里「## 原始素材」的已聚类条目（源自 fetch 阶段、被编排器打标 `[cluster 已合并 N 条]`）：
  - 同一事件出现于多条已聚类素材 → 只写 ONE 条标题正文，其他绝不重复（不并排、不"此外"再造一条）。若不同条沿用不同口径数字，直接写"M 为 X、N 为 Y，口径不一"，不再分别作文。
  - 判定两条是同一事件的双重标准（全部满足）：①共享 ≥1 个实体 token（组织/人名）；②日期同域（≥2 天内）;③数字字段重叠（含数量级）。
  - 判定后你的摘要正文即为主合并 + 数字/口径自然呈现（如 4.25GW/$150-200B/$600B/$105B 并陈）。
```

reportPrompt 原有 3-6 明确。

### E. `scripts/ai-daily/render-md.mjs`：事件驱动分节（无内容空板块整体不出现）

把 `renderMarkdown` 的 `### + items` 段改为**跳过空 section**：

```js
for (const sec of report.sections || []) {
  const items = (sec.items || []).filter(Boolean)
  if (!items.length) continue   // 无内容板块整体不出现（信息熵契约）
  L.push('### ' + sec.title); L.push('')
  for (const it of items) { L.push(itemBlock(it, citeMap)); L.push('') }
  L.push('')
}
```

并把 `renderDegradedMarkdown` 的覆盖矩阵加入**跳过空矩阵行**（无 claims 且无来源 → 那板不渲染 `| x | 0 claims ... |`）：
```js
for (const b of coverage || []) {
  if ((b.claims || 0) === 0 && !(b.urls || 0) && !(b.companiesChecked || []).some(c => ['has_dynamic', 'no_news', 'unreached'].includes(c.state))) continue
  // ... 原样
}
```

## 行为语义（守住）

- **linuxdo 不是验证主通道**：它是 Discover 阶段的独立发现组，产出 URL 进 Fetch/Verify 既有流水线（对抗投票/核查/合成全不变）。只在发现层面"深度参考"，不挣扎正文/状态机；深抓 3 篇节流。
- **聚类是主视图不是删数据**：cluster 只影响 `reportBody` 的"已聚类"呈现与正文去重，`claimsJson` 归档保留全部原始声明。
- **空板块不出现**：完整版 `continue` + 降级版空行 continue，都保证"无内容的板块区域整体不写"（信息熵契约）。
- **不碰 `dedupWindowMisses`**、不改 `DallyReport/src/linuxdo.mjs`（用户另一生成器）、不拆分析字段方言。

## 实施顺序

1. `cluster.mjs` 纯函数 + 单测（`test/cluster.test.mjs`）：两声明同实体合并 / 异实体不误合 / 数字冲突标记 / 空输入。
2. `linuxdo.mjs` 抓取（纯导出 + 真实 CDP 微测选做——用 9222 只读抓 1 页验证 CDP 通路）。
3. `boards.mjs` + workflow Discover/验证链改造 + `build.mjs` 追加 inline。
4. `render-md.mjs` 两渲染函数空板块跳过 + 测试（`test/render-md.test.mjs` 增 2 case：空 section 不渲染 + 降级版空矩阵行跳过）。
5. `prompts.mjs` 4.7 聚类纪律 + 3.2 数字化口径；`SKILL.md` args 补 linuxdo。
6. `node --check` → 单板冒烟（`boards:['linuxdo']`）+ 全量重跑 → 99/99 → 镜像同步 + secret-scan + 提交推送（源 main + mirror）。

## 验证

1. `node --check .claude/workflows/ai-daily.js`。
2. `node --test "scripts/ai-daily/test/*.test.mjs"` 99/99？新增 cluster/render 全绿。
3. 单板冒烟 `boards:['linuxdo'], maxFetch:3, maxVerify:3`：linuxdo 组激活、Discover 日志出现 `LINUXDO-OK <n> topics`、无 CDP 时 `LINUXDO-FAIL` + `linuxdo_degraded` 如实、产物 4 件落盘。
4. 全量重跑 8-23（验证+产出）：linuxdo 板块被东方（至少 1 板有内容）；8-22 实证重合 3 条（NVIDIA×OpenAI）应出现 ≤1 条合并主视图；板块按信源自适应（不可能每板都有内容）；生成当日主文章无空板块区。
5. 设计文档 append 第二十一项 changelog → 三份镜像字节同步 → secret-scan（只 add `ai-daily/`）→ 提交推送。

## 守住（do not break）

- 日报产物 `docs/daily/2026-08-22…` 等本次用户指定范围外不动；`DallyReport/src/linuxdo.mjs` 不碰。
- 泛化：`dedupWindowMisses` / `buildCitationMap` / `citationBadges` / `knownMajorOut` / `verifiedByVote` 语义全不动。
- arg 默认值不破坏既有冒烟/全量浅调用（linuxdo 默认不启用，新增 args 全可选）。
