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
import { DEFAULT_LADDER } from './ladder.mjs'
installUrlPolyfill()
// 供 test/realm-url.test.mjs 模拟 realm（删 globalThis.URL）后重新注入用。
export const setUrlPolyfillForRealm = () => { installUrlPolyfill() }

const CONF_ZH = { high: '高', medium: '中', low: '低' }

// generated_by: 'ai-daily (grok-4.6)' → grok-4.6；缺省回落阶梯首级（向后兼容无 meta / 旧调用）。
const modelFromMeta = meta => {
  const s = meta && meta.generated_by != null ? String(meta.generated_by) : ''
  const m = s.match(/\(([^)]+)\)/)
  const id = m && m[1] ? m[1].trim() : ''
  return id || DEFAULT_LADDER[0]
}

// C.3(2026-08-22): 状态标签规范化——把代理产出的 status 各种写法归一后判定是否「未核查」类（未经窗口内对抗投票）。
// 归一：全半角括号（[]()（）［］）→ 去掉、全角空白→半角、两端去空白、去内部空白、去全角·→. 后比较。
// 真值（标未核查徽标）：[窗口外·重大] / 窗口外·重大 / 窗口外重大 / 未核查；已核查/已否决不算。
const normalizeStatus = s => String(s || '')
  .replace(/[［【\[]/g, '[').replace(/[］】\]]/g, ']')  // 全角括号归一为半角
  .replace(/[（）]/g, '(').replace(/[）]/g, ')')
  .replace(/[\s]+/g, '')               // 去所有空白
  .replace(/[·．]/g, '·')              // 全角点·点归一半角
const isUncheckedStatus = s => {
  const n = normalizeStatus(s)
  return n === '[窗口外·重大]' || n === '窗口外·重大' || n === '窗口外重大' || n === '未核查'
}

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
  // C.2: 未核查项（status 为 [窗口外·重大] 或 未核查）→ 机器徽标双保险，不依赖代理措辞。
  // C.3(2026-08-22): 状态标签容错——8/22 生产 run 实证 major-out 条目 status 有 `[窗口外·重大]`/`窗口外重大`
  // （无方括号）等写法，精确匹配漏判 6/7 条。规范化（去 []／""、空白、全半角）后统一判定，真值走正常。
  const unchecked = isUncheckedStatus(it.status)
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
  L.push('model: ' + modelFromMeta(meta))
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
  L.push('> 覆盖 ' + window + ' 窗口 · 生成器 ai-daily（' + modelFromMeta(meta) + '）' + (degraded && degraded.length ? ' · 降级标记：`' + degraded.join('`、`') + '`' : ''))
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
  // 8/23 第二十一项：事件驱动分节——无内容的板块整体不出现（信息熵契约：不摆空骨架）。
  for (const sec of report.sections || []) {
    const items = (sec.items || []).filter(Boolean)
    if (!items.length) continue
    L.push('### ' + sec.title)
    L.push('')
    for (const it of items) { L.push(itemBlock(it, citeMap)); L.push('') }
    L.push('')
  }
  if (report.caveats && report.caveats.length) {
    L.push('## ⚠️ 未验证与局限')
    L.push('')
    for (const c of report.caveats) L.push('- ' + c)
    L.push('')
  }
  // 层 1 去重：过滤已在 report.sections items 标题中出现的窗口外项（对齐降级版 D.3，2026-08-22）。
  const majFromSections = (report.sections || []).flatMap(s => s.items || []).map(it => ({ claim: it.title }))
  const windowMissesDedup = windowMisses ? dedupWindowMisses(windowMisses, majFromSections) : []
  if (windowMissesDedup.length) {
    L.push('## 📎 窗口外参考')
    L.push('')
    for (const w of windowMissesDedup) L.push('- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note)
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

// windowMisses 去重：过滤已在 major-out/正文出现的 name（spec D.3）+ 09-21 列表内部近重复折叠。
// 词法名必须用 wm* 前缀——build.mjs 整文件 inline 后与 cluster.mjs 的 clusterTokenize 同顶层；
// 旧名 tokenize/STOP_TOKENS 也曾与 cluster 撞车（产物 C1 SyntaxError）。
// 判定：完全包含、CJK bigram 共享 ≥4，或拉丁实体 token 共享。
// 对正文/major-out：共享 1 个拉丁 token 即去掉（8/22 OpenAI/Grok 契约）。
// 列表内部：拉丁 token 必须共享 ≥2。只共享一个厂商标记（claude/openai）的两条不同事件不得互折。
// 09-21「陶哲轩联名」纯中文近重复走 CJK 路径，不靠拉丁 token。
const wmStopTokens = new Set(['news', 'note', 'report', 'model', 'models', 'open', 'new', 'blog', 'post', 'api', 'app', 'apps', 'ai', 'pro', 'free', 'beta', 'tool', 'tools', 'official', 'release', 'update'])
const wmCjkStopChars = new Set('的一是在不了有和人这中大为上个时来用们生到作地于出就分对成会可主发年动同进还也说要把被给跟与或及但很太更都也又再才只之所得自心又如其事吗吧呢啊嘛呀么'.split(''))
const wmCjkStopBigrams = new Set(['发布', '推出', '宣布', '上线', '开源', '报道', '消息', '披露', '据悉', '表示', '今日', '今天', '昨日', '昨天', '最新', '正式', '已经', '即将', '预计', '有望', '目前', '全新', '相关', '升级', '更新', '支持', '提供', '包括', '通过', '之后', '以前', '以后', '进行', '出现', '成为', '以及', '同时', '另外', '此外', '其中', '日报', '视频', '图片', '模型',
  '智能', '人工', '工智', '数据', '中心', '学习', '机器', '器学', '神经', '网络', '训练', '推理', '算力', '算法', '芯片', '基准', '评测', '能力', '性能', '参数', '版本', '公司', '科技', '集团', '有限', '全球', '首个', '业界', '行业', '产品', '用户', '服务', '平台', '系统', '技术', '团队', '计划', '投资', '融资', '市场', '收入', '增长'])
const WM_CJK_RE = /[\u4e00-\u9fff]/
const WM_CJK_MIN_SHARED = 4
const wmTokenize = s => {
  const text = String(s || '').toLowerCase()
  const out = []
  for (const t of (text.match(/[a-z0-9][a-z0-9.%\-]*/g) || [])) {
    if (t.length >= 4 && !wmStopTokens.has(t)) out.push(t)
  }
  for (const run of (text.match(/[\u4e00-\u9fff]+/g) || [])) {
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2)
      if (wmCjkStopChars.has(bg[0]) || wmCjkStopChars.has(bg[1])) continue
      if (wmCjkStopBigrams.has(bg)) continue
      out.push(bg)
    }
  }
  return out
}
const WM_ASCII_MIN_INTERNAL = 2
const wmNearDup = (a, b, minAscii) => {
  const na = String(a || '').replace(/\s+/g, ' ').trim()
  const nb = String(b || '').replace(/\s+/g, ' ').trim()
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.length >= 8 && nb.includes(na)) return true
  if (nb.length >= 8 && na.includes(nb)) return true
  const ta = new Set(wmTokenize(na))
  const tb = new Set(wmTokenize(nb))
  let asciiShared = 0, cjkShared = 0
  for (const t of ta) {
    if (!tb.has(t)) continue
    if (WM_CJK_RE.test(t)) cjkShared++
    else asciiShared++
  }
  if (asciiShared >= minAscii) return true
  return cjkShared >= WM_CJK_MIN_SHARED
}
export const foldWindowMisses = items => {
  const out = []
  for (const m of items || []) {
    if (!m || !String(m.name || '').trim()) continue
    if (out.some(w => wmNearDup(w.name, m.name, WM_ASCII_MIN_INTERNAL))) continue
    out.push(m)
  }
  return out
}
const dedupWindowMisses = (windowMisses, maj) => {
  const folded = foldWindowMisses(windowMisses)
  if (!folded.length || !maj.length) return folded
  const majClaims = maj.map(m => String(m.claim || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  return folded.filter(w => {
    const name = String(w.name || '').trim()
    if (!name) return true
    return !majClaims.some(c => wmNearDup(c, name, 1))
  })
}

export const renderDegradedMarkdown = ({ date, window, confirmed, refuted, coverage, windowMisses, degraded, noNewsCompanies, reportError, generated_by }) => {
  const S = s => String(s || '').replace(/\s+/g, ' ').trim()
  const voteTag = x => x.verifiedByVote ? '`✓' + (x.vote || '?') + '`' : '`◇' + (x.vote || '?') + '`'
  // 降级版来源形态为单 URL x.source（非数组），统一走 buildCitationMap 角标化（spec D.2）。
  const citeMap = buildCitationMap([
    { items: (confirmed || []).map(x => ({ sources: x.source ? [x.source] : [] })) },
    { items: (refuted || []).map(x => ({ sources: x.source ? [x.source] : [] })) },
  ])
  const badge = x => citationBadges(x.source ? [x.source] : [], citeMap)
  const inW = (confirmed || []).filter(x => x.window === 'in')
  // 8/24 修复：maj 过滤改为 `x.window !== 'in'`——此前只收 'major-out'，window 为 'out'/'unknown'
  // 的已确认项既不进 inW 也不进 maj，静默丢失。现在非 in 的已确认项都归入窗口外节，不再消失。
  const maj = (confirmed || []).filter(x => x.window !== 'in')
  // 修 reportError 硬编码（spec D.1）：null/空不抹成 'report agent failed'，如实描述。
  const reason = reportError ? String(reportError).replace(/\s+/g, ' ').trim() : 'report 代理未产出完整版合成结构'
  const L = []
  L.push('# 🤖 AI 日报 · ' + date)
  L.push('')
  L.push('> 覆盖 ' + window + ' 窗口 · 生成器 ai-daily（' + modelFromMeta({ generated_by }) + '）' + (degraded && degraded.length ? ' · 降级标记：`' + degraded.join('`、`') + '`' : ''))
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
    L.push('### 窗口外·已确认（' + maj.length + ' 条，未经窗口内投票）')
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
    // 8/23 第二十一项：事件驱动分节——无 claims 且无 URL 来源且公司三态均为空态之外的板：空矩阵行不渲染。
    // 8/23 I1 复核修复：模板 8/22 第二十项 labs 花名册跨板块校正已把全部 no_news 翻转为 no_dynamic，
    // render 时 no_news 永不出现。若枚举仍缺 no_dynamic，经校正的板（0 claims、0 urls、公司全
    // no_dynamic）会被误判成空行跳过——「已核查这些公司、当日均无动态」的覆盖自检信息（无动态 备注列）
    // 静默丢失（amnesia 类）。枚举补 'no_dynamic' → 该行保留渲染。真正空行仍是
    // 「0 claims 且无 urls 且无任何公司三态信息」（无 companiesChecked 或全空态）。
    // 8/31 P3 修复①：`degraded` 板即使 0 claims / 0 urls / 无公司三态也**保留行**。此前它们被
    // 当空行跳过——8/31 生产 run 里 opensource/academic/funding/policy/safety/people 六个 degraded
    // 的 0/0 板整行消失，10 板矩阵只剩 4 行，读者无法区分「查过·当日无新闻」与「压根没查到」。
    // 通道失败本身就是必须上报的覆盖事实，不是「无内容」。
    if (!b.degraded && (b.claims || 0) === 0 && !(b.urls || 0) && !(b.companiesChecked || []).some(c => ['has_dynamic', 'no_news', 'unreached', 'no_dynamic'].includes(c.state))) continue
    // 8/31 P3 修复②：degraded 与「无动态花名册」**并存渲染**（`degraded · 无动态：…`）。此前 labs 的
    // 三元在 noNewsCompanies 非空时直接替换掉 degraded 标记 → md 写「无动态：OpenAI、Google DeepMind…」
    // 而 meta 里 labs degraded=True、根本没有通道真正查过 OpenAI = 假确信（把「没查到」印成「查过无事」）。
    const notes = []
    if (b.degraded) notes.push('degraded')
    if (b.board === 'labs' && noNewsCompanies && noNewsCompanies.length) notes.push('无动态：' + noNewsCompanies.join('、'))
    L.push('| ' + b.board + ' | ' + b.title + ' | ' + b.claims + ' | ' + notes.join(' · ') + ' |')
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
