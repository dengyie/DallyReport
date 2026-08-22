// ai-daily 确定性 md 渲染 — mdWriter 代理的替代。
// report 成功 → renderMarkdown（完整版）；report 失败 → renderDegradedMarkdown（降级版，原冒烟 compose 脚本正式化）。
// 两者输出都进 payloads.md 由 orchestrator 逐字节落盘，md 产出不再受网关波动影响。
// 2026-08-22 风格优化（spec 2026-08-22-ai-daily-report-style-design.md）：
//   A. 来源角标化（buildCitationMap + 正文 [n] + 末尾「### 参考来源」节）
//   B. renderMarkdown 可选 meta → Obsidian frontmatter + 素材窗口横幅 + 低素材提示
//   D. 降级版修 reportError 硬编码 + 来源角标化 + windowMisses 与 major-out 去重

// workflow realm 缺失 URL 全局的最小 polyfill（见 url-polyfill.mjs；build inline 后自动注入）。
// node:test 直跑时全局 URL 已存在，installUrlPolyfill 幂等跳过。
import { installUrlPolyfill } from './url-polyfill.mjs'
installUrlPolyfill()
// 供 test/realm-url.test.mjs 模拟 realm（删 globalThis.URL）后重新注入用。
export const setUrlPolyfillForRealm = () => { installUrlPolyfill() }

const CONF_ZH = { high: '高', medium: '中', low: '低' }

// 跨 section 唯一 URL 引用图：按「首次出现序」给每个唯一 URL 分配 1-based 编号（spec A.1）。
// 非 URL 来源（如 (多源公认)）不参与编号——正文不挂角标、不进参考列表。
// 返回 { map: Map<href, n>, list: [{ n, url, title }] }；list 即「### 参考来源」节的数据源，title 取 hostname。
export const buildCitationMap = sections => {
  const map = new Map()
  const list = []
  const hostname = s => { try { return new URL(s).hostname } catch { return s } }
  for (const sec of sections || []) {
    for (const it of (sec.items || [])) {
      for (const s of (it.sources || [])) {
        let url
        try { url = new URL(s).href } catch { continue }
        if (!map.has(url)) {
          map.set(url, list.length + 1)
          list.push({ n: list.length + 1, url, title: hostname(url) })
        }
      }
    }
  }
  return { map, list }
}

// item/claim 的来源 → 该条正文末尾的角标串，如 ' [1][3]'（按编号升序、跨来源去重）。
// 无 URL 来源或图里无对应 → ''（不挂角标）。
const citationBadges = (sources, citeMap) => {
  if (!sources || !sources.length || !citeMap) return ''
  const ns = []
  for (const s of sources) {
    let url
    try { url = new URL(s).href } catch { continue }
    const n = citeMap.map.get(url)
    if (n != null) ns.push(n)
  }
  if (!ns.length) return ''
  return ' ' + [...new Set(ns)].sort((a, b) => a - b).map(n => '[' + n + ']').join('')
}

const itemBlock = (it, citeMap) => {
  const tag = it.status ? ' `' + it.status + '`' : ''
  const conf = (CONF_ZH[it.confidence] || it.confidence) ? '可信度：' + (CONF_ZH[it.confidence] || it.confidence) : ''
  const badges = citationBadges(it.sources, citeMap)
  // B.5: sources 存在但全是非 URL 文字描述（buildCitationMap 没给编号）→ 诚实标注无单一链接
  const hasSrc = it.sources && it.sources.length > 0
  const noUrl = hasSrc && !badges
  // C.2: 未核查项（status 为 [窗口外·重大] 或 未核查）→ 机器徽标双保险，不依赖代理措辞
  const unchecked = it.status === '[窗口外·重大]' || it.status === '未核查'
  const tail = badges + (noUrl ? ' [行业公认·无单一链接]' : '') + (unchecked ? ' *[未核查·待证实]*' : '')
  const lines = []
  lines.push('**' + it.title + '**' + tag)
  lines.push('')
  lines.push(it.summary + tail + (conf ? '\n\n*' + conf + '*' : ''))
  return lines.join('\n')
}

// 完整版 optionally 带 meta 时输出 Obsidian frontmatter（spec B.1）。字段全来自 meta，无新数据。
const frontmatterLines = (meta, date, window) => {
  if (!meta) return []
  const st = meta.stats && typeof meta.stats === 'object' ? meta.stats : {}
  const num = v => (typeof v === 'number' ? v : null)
  const L = ['---']
  L.push('date: ' + (meta.date || date))
  L.push('window: ' + (meta.window || window))
  L.push('generator: ai-daily')
  L.push('model: deepseek-v4-flash')
  L.push('tags: [日报, AI]')
  const statsParts = []
  if (num(st.confirmed) != null) statsParts.push('confirmed:' + st.confirmed)
  if (num(st.major_out) != null) statsParts.push('major_out:' + st.major_out)
  if (num(st.killed) != null) statsParts.push('killed:' + st.killed)
  if (num(st.urls_fetched) != null) statsParts.push('urls_fetched:' + st.urls_fetched)
  if (statsParts.length) L.push('stats: {' + statsParts.join(', ') + '}')
  L.push('---')
  return L
}

// 完整版：report 代理产出 sections 后的确定性排版。
// 输入即现行 mdWriter prompt 里 reportJson 的同构数据。
// meta 为可选参数：{ date, window, stats:{confirmed,major_out,killed,urls_fetched,urls_discovered}, generated_by, degraded }；
// 缺失时退化（无 frontmatter/横幅），向后兼容旧调用。
export const renderMarkdown = ({ date, window, report, coverage, windowMisses, degraded, meta }) => {
  const L = []
  for (const fl of frontmatterLines(meta, date, window)) L.push(fl)
  L.push('# 🤖 AI 日报 · ' + date)
  L.push('')
  // 素材窗口横幅（meta 提供时，标题后、覆盖行前，AI.md 风格）。N=当日素材(窗口内 confirmed)，M=近几日来源(全部 urls_discovered)。
  const st = meta && meta.stats && typeof meta.stats === 'object' ? meta.stats : {}
  if (meta) {
    const N = typeof st.confirmed === 'number' ? st.confirmed : null
    const M = typeof st.urls_discovered === 'number' ? st.urls_discovered : (typeof meta.urls_discovered === 'number' ? meta.urls_discovered : null)
    if (N != null || M != null) {
      L.push('> **素材窗口**：当日素材 ' + (N != null ? N : '?') + ' 条；近几日来源 ' + (M != null ? M : '?') + ' 条。')
    }
    const hard = (typeof st.confirmed === 'number' ? st.confirmed : 0) + (typeof st.major_out === 'number' ? st.major_out : 0)
    if (hard < 8) L.push('> ⚠️ **低素材提示**：当日硬源不足 8 条，正文以近期趋势为主，请注意时效。')
  }
  L.push('> 覆盖 ' + window + ' 窗口 · 生成器 ai-daily（deepseek-v4-flash）' + (degraded && degraded.length ? ' · 降级标记：`' + degraded.join('`、`') + '`' : ''))
  L.push('')
  L.push('## 📌 今日一句话')
  L.push('')
  L.push(report.oneLiner)
  L.push('')
  L.push('## 📄 执行摘要')
  L.push('')
  L.push(report.execSummary)
  L.push('')
  const citeMap = buildCitationMap(report && report.sections)
  for (const sec of report.sections || []) {
    L.push('### ' + sec.title)
    L.push('')
    for (const it of sec.items || []) { L.push(itemBlock(it, citeMap)); L.push('') }
    L.push('')
  }
  if (report.caveats && report.caveats.length) {
    L.push('## ⚠️ 未验证与局限')
    L.push('')
    for (const c of report.caveats) L.push('- ' + c)
    L.push('')
  }
  if (windowMisses && windowMisses.length) {
    L.push('## 📎 窗口外参考')
    L.push('')
    for (const w of windowMisses) L.push('- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note)
    L.push('')
  }
  if (report.openQuestions && report.openQuestions.length) {
    L.push('## ❓ 开放问题')
    L.push('')
    for (const q of report.openQuestions) L.push('- ' + q)
    L.push('')
  }
  L.push('## ✅ 覆盖自检')
  L.push('')
  for (const c of coverage || []) {
    L.push('- **' + c.title + '**：' + c.claims + ' claims / ' + c.urls + ' sources' + (c.degraded ? ' `[degraded]`' : ''))
  }
  L.push('')
  // 参考来源节（md 末尾，AI.md 风格 [n] → 编号参考列表，跨 section 全文唯一）
  if (citeMap.list.length) {
    L.push('### 参考来源')
    L.push('')
    for (const c of citeMap.list) L.push('- [' + c.n + '] [' + c.title + '](<' + c.url + '>)')
    L.push('')
  }
  return L.join('\n')
}

// 降级版：report 代理失败时由编排数据确定性合成——可读快讯，不再是原始数据转储。
// 8/22 改为新闻快讯风格：按窗口内/窗口外/否决分节，每条 claim 写为完整句子，附加核查徽标；
// 2026-08-22 再改：来源角标化对齐完整版 + 修 reportError 硬编码 + windowMisses 与 major-out 去重。

// windowMisses 去重：过滤已在 major-out 出现的 name（spec D.3）。
// 判定：完全包含 或 共享区分性拉丁实体 token（如 Grok、Qwen3.8-27B）——8/21 实况「Grok 4.6 in Copilot」与「Qwen3.8-27B edge model」即靠实体 token 命中。
const STOP_TOKENS = new Set(['news', 'note', 'report', 'model', 'models', 'open', 'new', 'blog', 'post', 'api', 'app', 'apps', 'ai', 'pro', 'free', 'beta', 'tool', 'tools', 'official', 'release', 'update'])
const tokenize = s => (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9.%\-]*/g) || []).filter(t => t.length >= 4 && !STOP_TOKENS.has(t))
const dedupWindowMisses = (windowMisses, maj) => {
  if (!windowMisses.length || !maj.length) return windowMisses
  const majClaims = maj.map(m => String(m.claim || '').replace(/\s+/g, ' ').trim())
  const majTokens = new Set()
  for (const c of majClaims) for (const t of tokenize(c)) majTokens.add(t)
  return windowMisses.filter(w => {
    const name = String(w.name || '').trim()
    if (!name) return true
    if (majClaims.some(c => c.includes(name))) return false
    if (tokenize(name).some(t => majTokens.has(t))) return false
    return true
  })
}

export const renderDegradedMarkdown = ({ date, window, confirmed, refuted, coverage, windowMisses, degraded, noNewsCompanies, reportError }) => {
  const S = s => String(s || '').replace(/\s+/g, ' ').trim()
  const voteTag = x => x.verifiedByVote ? '`✓' + (x.vote || '?') + '`' : '`◇' + (x.vote || '?') + '`'
  // 降级版来源形态为单 URL x.source（非数组），统一走 buildCitationMap 角标化（spec D.2）。
  const citeMap = buildCitationMap([
    { items: (confirmed || []).map(x => ({ sources: x.source ? [x.source] : [] })) },
    { items: (refuted || []).map(x => ({ sources: x.source ? [x.source] : [] })) },
  ])
  const badge = x => citationBadges(x.source ? [x.source] : [], citeMap)
  const inW = (confirmed || []).filter(x => x.window === 'in')
  const maj = (confirmed || []).filter(x => x.window === 'major-out')
  // 修 reportError 硬编码（spec D.1）：null/空不抹成 'report agent failed'，如实描述。
  const reason = reportError ? String(reportError).replace(/\s+/g, ' ').trim() : 'report 代理未产出完整版合成结构'
  const L = []
  L.push('# 🤖 AI 日报 · ' + date)
  L.push('')
  L.push('> 覆盖 ' + window + ' 窗口 · 生成器 ai-daily（deepseek-v4-flash）' + (degraded && degraded.length ? ' · 降级标记：`' + degraded.join('`、`') + '`' : ''))
  L.push('')
  L.push('## ⚠️ 本日报为**降级快讯**（report 合成代理未产出，由编排器据已核查归档拼合）')
  L.push('')
  L.push('降级原因：' + reason + '。以下内容依核查结果逐条拼合，无合成代理润色编排。')
  L.push('')
  L.push('### 窗口内新闻（' + inW.length + ' 条，对抗式核查确认）')
  L.push('')
  for (const x of inW) {
    L.push('- ' + voteTag(x) + ' ' + S(x.claim) + badge(x) + ' — *（' + (x.sourceQuality || '?') + '）*' + (x.erroredCount ? ' ⚠️' + x.erroredCount + ' 票异常' : ''))
  }
  L.push('')
  if (maj.length) {
    L.push('### 窗口外·行业里程碑（' + maj.length + ' 条，公认事实未经窗口内投票）')
    L.push('')
    for (const x of maj) {
      L.push('- ' + S(x.claim) + '（' + (x.date || '?') + '）')
    }
    L.push('')
  }
  if (refuted && refuted.length) {
    L.push('### 已否决的提案（' + refuted.length + ' 条，对抗式核查未通过）')
    L.push('')
    for (const x of refuted) {
      L.push('- ~~' + S(x.claim) + '~~ → 否决 `' + (x.vote || '?') + '`' + badge(x) + (x.erroredCount ? ' ⚠️' + x.erroredCount + ' 票异常' : ''))
    }
    L.push('')
  }
  const wm = dedupWindowMisses(windowMisses || [], maj)
  if (wm.length) {
    L.push('### 📎 窗口外参考')
    L.push('')
    for (const w of wm) L.push('- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note)
    L.push('')
  }
  L.push('### ✅ 覆盖矩阵')
  L.push('')
  L.push('| 板块 | 标题 | 覆盖 claim 数 | 备注 |')
  L.push('|---|---|---|---|')
  for (const b of coverage || []) {
    const note = b.board === 'labs'
      ? (noNewsCompanies && noNewsCompanies.length ? '无动态：' + noNewsCompanies.join('、') : (b.degraded ? 'degraded' : ''))
      : (b.degraded ? 'degraded' : '')
    L.push('| ' + b.board + ' | ' + b.title + ' | ' + b.claims + ' | ' + note + ' |')
  }
  L.push('')
  if (citeMap.list.length) {
    L.push('### 参考来源')
    L.push('')
    for (const c of citeMap.list) L.push('- [' + c.n + '] [' + c.title + '](<' + c.url + '>)')
    L.push('')
  }
  return L.join('\n')
}
