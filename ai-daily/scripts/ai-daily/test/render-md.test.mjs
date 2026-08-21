import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, renderDegradedMarkdown, buildCitationMap } from '../render-md.mjs'
import { computeBoardStates } from '../boards.mjs'

const baseReport = {
  oneLiner: '今日 AI 行业一句话。',
  execSummary: '执行摘要三句。',
  sections: [
    { board: 'labs', title: '头部实验室·新模型', items: [
      { title: '[3-0✓] xAI 发布 Grok 4.6', summary: '要点两句。', confidence: 'high', sources: ['https://x.ai/news'], vote: '3-0✓' },
      // 新 prompt 契约：精简陈述式 title（去前置状态标签，status 单独字段）
      { title: 'Stripe $7.5B 收购 OpenRouter', summary: '支付巨头切入 AI 路由。', confidence: 'medium', sources: ['https://t.co'], vote: '2-1', status: '已核查 2-1' },
      // 多源条目：角标化后按全局编号升序 [1][2][3]（t.co 先现→2，x.ai→1，openai→3）
      { title: '多源条目合并引用', summary: '多源摘要。', confidence: 'low', sources: ['https://openai.com/index/a', 'https://t.co', 'https://x.ai/news'], vote: '—', status: '已核查 2-0' },
    ]},
    { board: 'strategy', title: '重磅头条·战略', items: [
      { title: '[窗口外·重大] DeepSeek V4 开源', summary: 'MIT 开源。', confidence: 'high', sources: ['(多源公认)'], vote: '—' },
    ]},
  ],
  caveats: ['某条弱来源。'],
  openQuestions: ['问题一？'],
}
const baseCoverage = [
  { board: 'labs', title: '头部实验室·新模型', claims: 5, urls: 3, degraded: false },
  { board: 'strategy', title: '重磅头条·战略', claims: 2, urls: 1, degraded: true },
]

test('完整版：标题/一句话/摘要/分节/局限/开放问题/覆盖自检齐全', () => {
  const md = renderMarkdown({ date: '2026-08-18', window: '2026-08-16 ~ 2026-08-18', report: baseReport, coverage: baseCoverage, windowMisses: [], degraded: [] })
  assert.ok(md.startsWith('# 🤖 AI 日报 · 2026-08-18'))
  assert.ok(md.includes('## 📌 今日一句话'))
  assert.ok(md.includes('今日 AI 行业一句话。'))
  assert.ok(md.includes('## 📄 执行摘要'))
  assert.ok(md.includes('### 头部实验室·新模型'))
  assert.ok(md.includes('**[3-0✓] xAI 发布 Grok 4.6**'))  // 旧式 title 含 [3-0✓] 前缀
  assert.ok(md.includes('## ⚠️ 未验证与局限'))
  assert.ok(md.includes('某条弱来源。'))
  assert.ok(md.includes('## ❓ 开放问题'))
  assert.ok(md.includes('## ✅ 覆盖自检'))
  assert.ok(md.includes('`[degraded]`'))  // strategy degraded 标注
})

test('完整版：精简陈述式 title 契约——前置状态标签不强制、status 字段可共存，render 原样展示', () => {
  const md = renderMarkdown({ date: '2026-08-18', window: 'w', report: baseReport, coverage: baseCoverage, windowMisses: [], degraded: [] })
  // 新契约 title 不带前置 [xxx] 标签，以此为标题行直接出现
  assert.ok(md.includes('Stripe $7.5B 收购 OpenRouter'), '精简 title 原样呈现')
  // 旧式 title 仍兼容（不为兼容而吞信息）
  assert.ok(md.includes('[3-0✓] xAI 发布 Grok 4.6'), '旧式 title 仍兼容保留')
  assert.ok(md.includes('可信度：中'), '新 title 附可信度')
})

test('完整版：major-out 条目 vote — 原样呈现（不冒充投票）→ 契约更新：非 URL 来源不角标化', () => {
  const md = renderMarkdown({ date: '2026-08-18', window: 'w', report: baseReport, coverage: baseCoverage, windowMisses: [], degraded: [] })
  assert.ok(md.includes('**[窗口外·重大] DeepSeek V4 开源**'))
  // 风格优化契约：非 URL 来源（(多源公认)）不再产角标、不进参考来源列表、正文也不再挂 *来源：*
  assert.ok(!md.includes('(多源公认)'), '非 URL 占位来源应被角标化跳过')
  assert.ok(!md.includes('*来源：'), '正文尾巴不再挂 *来源：*')
})

test('完整版：windowMisses 存在时出窗口外参考节，否则不出', () => {
  const withMiss = renderMarkdown({ date: 'd', window: 'w', report: baseReport, coverage: [], windowMisses: [{ name: 'X', date: '2026-08-10', note: '注' }], degraded: [] })
  assert.ok(withMiss.includes('## 📎 窗口外参考'))
  assert.ok(withMiss.includes('X（2026-08-10）：注'))
  const noMiss = renderMarkdown({ date: 'd', window: 'w', report: baseReport, coverage: [], windowMisses: [], degraded: [] })
  assert.ok(!noMiss.includes('## 📎 窗口外参考'))
})

test('完整版：degraded 标记进头行', () => {
  const md = renderMarkdown({ date: 'd', window: 'w', report: baseReport, coverage: [], windowMisses: [], degraded: ['fetch_budget_dropped:2', 'budget_skipped:Verify'] })
  assert.ok(md.includes('`fetch_budget_dropped:2`、`budget_skipped:Verify`'))
})

test('端到端：computeBoardStates 产出 → renderMarkdown 如实输出共享板降级', () => {
  // 8/21 实况：media-cn 失败，media-en 兜底 strategy/funding/policy
  const rows = [
    { group: { key: 'labs' }, degraded: true },
    { group: { key: 'opensource' }, degraded: false },
    { group: { key: 'academic' }, degraded: false },
    { group: { key: 'media-en' }, degraded: false },
  ]
  const keys = ['labs', 'strategy', 'products', 'opensource', 'academic', 'funding', 'policy', 'safety', 'people']
  const states = computeBoardStates(rows, keys)
  const coverage = keys.map(board => ({
    board, title: board, claims: 0, urls: 0, degraded: states.get(board).degraded,
  }))
  const md = renderMarkdown({ date: 'd', window: 'w', report: baseReport, coverage, windowMisses: [], degraded: [] })
  // 逐板行断言（render 输出 '- **<board>**：N claims / N sources [degraded]'）
  const line = b => md.split('\n').find(l => l.includes('- **' + b + '**')) || ''
  // 失败组覆盖的板（含 media-en 兜底的）都应有 [degraded]
  for (const b of ['strategy', 'funding', 'policy', 'safety', 'people']) {
    assert.ok(line(b).includes('`[degraded]`'), `板 ${b} 应标 [degraded]，行：${line(b)}`)
  }
  // media-en 正常覆盖的板不标（labs 自报通道降级例外保留）
  for (const b of ['products', 'opensource', 'academic']) {
    assert.ok(!line(b).includes('`[degraded]`'), `板 ${b} 不应标 [degraded]，行：${line(b)}`)
  }
  // labs（自报通道降级）保留
  assert.ok(line('labs').includes('`[degraded]`'), 'labs 通道降级保留')
})

test('降级版：标注降级原因 + 窗口内新闻/major-out/refuted 分节', () => {
  const md = renderDegradedMarkdown({
    date: '2026-08-18', window: '2026-08-16 ~ 2026-08-18',
    confirmed: [
      { claim: '窗口内声明A', window: 'in', vote: '2-0', verifiedByVote: true, source: 'https://x.ai/a', sourceQuality: 'primary', date: '2026-08-17', erroredCount: 0 },
      { claim: 'DeepSeek V4 开源', window: 'major-out', vote: '—', verifiedByVote: false, source: '(多源公认)', date: '2026-07-31', erroredCount: 0 },
    ],
    refuted: [{ claim: '被否决声明B', vote: '0-2', source: 'https://rumor.example/b', erroredCount: 0 }],
    coverage: baseCoverage, windowMisses: [], degraded: ['report_failed'],
    noNewsCompanies: ['OpenAI', 'NVIDIA'], reportError: 'report agent failed; reverting to raw archive',
  })
  assert.ok(md.includes('降级快讯'))
  assert.ok(md.includes('report agent failed'))
  assert.ok(md.includes('### 窗口内新闻（1 条'))
  assert.ok(md.includes('`✓2-0`'))
  assert.ok(md.includes('### 窗口外·行业里程碑（1 条'))
  assert.ok(md.includes('~~被否决声明B~~ → 否决 `0-2`'))
  assert.ok(md.includes('无动态：OpenAI、NVIDIA'))
  assert.ok(md.includes('`report_failed`'))
})

test('降级版：erroredCount>0 可见（观察项③在降级路径也不丢）', () => {
  const md = renderDegradedMarkdown({
    date: 'd', window: 'w',
    confirmed: [{ claim: 'A', window: 'in', vote: '2-0', verifiedByVote: true, source: 'https://x/a', date: '2026-08-17', erroredCount: 1 }],
    refuted: [], coverage: [], windowMisses: [], degraded: [], noNewsCompanies: [],
  })
  assert.ok(md.includes('⚠️1 票异常'))
})

test('降级版：空数据不崩（边界）', () => {
  const md = renderDegradedMarkdown({ date: 'd', window: 'w', confirmed: [], refuted: [], coverage: [], windowMisses: [], degraded: [], noNewsCompanies: [] })
  assert.ok(md.includes('窗口内新闻（0 条'))
  assert.ok(md.includes('| 板块 | 标题 |'))
})

// ─── 2026-08-22 风格优化（spec 2026-08-22-ai-daily-report-style-design.md）───

test('buildCitationMap：跨 section 按首次出现序编号、URL href 去重、非 URL 跳过', () => {
  const cm = buildCitationMap([
    { items: [{ sources: ['https://x.ai/news', 'https://t.co', '(多源公认)'] }] },
    { items: [{ sources: ['https://t.co', 'https://openai.com/index/a'] }] },
  ])
  assert.equal(cm.list.length, 3, '非 URL 与重复 URL 不计入')
  assert.deepEqual(cm.list.map(c => c.n), [1, 2, 3])
  assert.equal(cm.map.get('https://x.ai/news'), 1)
  assert.equal(cm.map.get('https://t.co/'), 2, 'href 归一化（t.co → 尾斜杠）' )
  assert.equal(cm.map.get('https://openai.com/index/a'), 3)
  assert.deepEqual(cm.list[0], { n: 1, url: 'https://x.ai/news', title: 'x.ai' })
  assert.equal(cm.list[2].title, 'openai.com')
  // 空输入 / 单 item 列表
  const empty = buildCitationMap([])
  assert.equal(empty.list.length, 0)
  assert.equal(empty.map.size, 0)
})

test('完整版：来源角标化 [n] + 末尾「### 参考来源」节 + 多角标升序去重', () => {
  const md = renderMarkdown({ date: '2026-08-18', window: 'w', report: baseReport, coverage: baseCoverage, windowMisses: [], degraded: [] })
  assert.ok(md.includes('要点两句。 [1]'), '单源条目挂 [n]（x.ai=1）')
  assert.ok(md.includes('支付巨头切入 AI 路由。 [2]'), 'Stripe 挂 [2]（t.co=2）')
  assert.ok(md.includes('多源摘要。 [1][2][3]'), '多源条目按全局编号升序去重 [1][2][3]')
  assert.ok(!md.includes('*来源：'), '正文不再挂 *来源：域名*')
  assert.ok(md.includes('### 参考来源'))
  assert.ok(md.includes('- [1] [x.ai](<https://x.ai/news>)'))
  assert.ok(md.includes('- [2] [t.co](<https://t.co/>)'))
  assert.ok(md.includes('- [3] [openai.com](<https://openai.com/index/a>)'))
  // 参考来源在覆盖自检之后（md 末尾）
  assert.ok(md.indexOf('## ✅ 覆盖自检') < md.indexOf('### 参考来源'))
  // 无来源条目不挂角标
  const noSrc = renderMarkdown({ date: 'd', window: 'w', report: { oneLiner: 'o', execSummary: 'e', sections: [{ board: 'x', title: 'T', items: [{ title: '无源', summary: '无源摘要。', sources: [] }] }] }, coverage: [], windowMisses: [], degraded: [] })
  assert.ok(noSrc.includes('无源摘要。\n'))
  assert.ok(!noSrc.includes('### 参考来源'), '无 URL 参考时不出现空参考节')
})

test('完整版：frontmatter + 素材窗口横幅（meta 可选参数）', () => {
  const meta = {
    date: '2026-08-21', window: '2026-08-19 ~ 2026-08-21',
    stats: { confirmed: 30, major_out: 14, killed: 2, urls_fetched: 7, urls_discovered: 35 },
    generated_by: 'ai-daily (deepseek-v4-flash)',
  }
  const md = renderMarkdown({ date: '2026-08-21', window: 'w', report: baseReport, coverage: baseCoverage, windowMisses: [], degraded: [], meta })
  assert.ok(md.startsWith('---\ndate: 2026-08-21'), 'frontmatter 置于最顶')
  assert.ok(md.includes('window: 2026-08-19 ~ 2026-08-21'))
  assert.ok(md.includes('generator: ai-daily'))
  assert.ok(md.includes('model: deepseek-v4-flash'))
  assert.ok(md.includes('tags: [日报, AI]'))
  assert.ok(md.includes('stats: {confirmed:30, major_out:14, killed:2, urls_fetched:7}'))
  assert.ok(md.includes('> **素材窗口**：当日素材 30 条；近几日来源 35 条。'))
  assert.ok(!md.includes('低素材提示'), 'confirmed+major_out=44 ≥ 8 不提示')
  // 横幅在标题后、覆盖行前
  assert.ok(md.indexOf('# 🤖 AI 日报 · 2026-08-21') < md.indexOf('> **素材窗口**'))
  assert.ok(md.indexOf('> **素材窗口**') < md.indexOf('> 覆盖 '))
  // 标题随后仍是可读结构（frontmatter 后标题行）
  assert.ok(md.includes('\n# 🤖 AI 日报 · 2026-08-21'))
})

test('完整版：低素材提示仅当 confirmed+major_out < 8', () => {
  const mk = stats => renderMarkdown({ date: 'd', window: 'w', report: baseReport, coverage: [], windowMisses: [], degraded: [], meta: { stats } })
  const low = mk({ confirmed: 6, major_out: 1, urls_discovered: 20 })
  assert.ok(low.includes('> ⚠️ **低素材提示**：当日硬源不足 8 条，正文以近期趋势为主，请注意时效。'))
  const low2 = mk({ confirmed: 6, major_out: 1 })
  assert.ok(low2.includes('> **素材窗口**：当日素材 6 条；近几日来源 ? 条。'), 'M 缺失退化与素材横幅仍出')
  const boundary = mk({ confirmed: 8, major_out: 0 })
  assert.ok(!boundary.includes('低素材提示'), '8+0=8 不提示（边界）')
})

test('完整版：无 meta 时不产出 frontmatter（向后兼容旧调用）', () => {
  const md = renderMarkdown({ date: '2026-08-18', window: 'w', report: baseReport, coverage: baseCoverage, windowMisses: [], degraded: [] })
  assert.ok(!md.startsWith('---'))
  assert.ok(!md.includes('tags: [日报, AI]'))
  assert.ok(md.startsWith('# 🤖 AI 日报 · 2026-08-18'))
})

test('降级版：reportError=null 时如实描述、不含字面 failed（修硬编码 bug）', () => {
  const md = renderDegradedMarkdown({
    date: '2026-08-21', window: 'w',
    confirmed: [{ claim: '窗口内声明A', window: 'in', vote: '2-0', verifiedByVote: true, source: 'https://x.ai/a', sourceQuality: 'primary', date: '2026-08-20', erroredCount: 0 }],
    refuted: [], coverage: [], windowMisses: [], degraded: [], noNewsCompanies: [], reportError: null,
  })
  assert.ok(md.includes('降级原因：report 代理未产出完整版合成结构'))
  assert.ok(!/failed/i.test(md), 'reportError=null 时 md 不得含字面 failed')
  assert.ok(!md.includes('report agent failed'))
  // 非空 reportError 仍如实展示（老测试已覆盖），此处双保险
  const withErr = renderDegradedMarkdown({ date: 'd', window: 'w', confirmed: [], refuted: [], coverage: [], windowMisses: [], degraded: [], noNewsCompanies: [], reportError: 'timed out after 600s' })
  assert.ok(withErr.includes('降级原因：timed out after 600s'))
})

test('降级版：confirmed/refuted 来源角标化 + 末尾参考来源节 + URL 去重', () => {
  const md = renderDegradedMarkdown({
    date: 'd', window: 'w',
    confirmed: [
      { claim: '声明A', window: 'in', vote: '2-0', verifiedByVote: true, source: 'https://techcrunch.com/a', sourceQuality: 'secondary', date: '2026-08-19', erroredCount: 0 },
      { claim: '声明B', window: 'in', vote: '2-1', verifiedByVote: true, source: 'https://techcrunch.com/a', sourceQuality: 'secondary', date: '2026-08-19', erroredCount: 0 },
      { claim: 'MajorOut 重大项', window: 'major-out', vote: '—', verifiedByVote: false, source: '(多源公认)', date: '2026-08-14', erroredCount: 0 },
    ],
    refuted: [{ claim: '否决C', vote: '0-2', source: 'https://example.org/b', erroredCount: 0 }],
    coverage: [], windowMisses: [], degraded: [], noNewsCompanies: [],
  })
  assert.ok(md.includes('声明A [1]'), '窗口内条目挂 [1]')
  assert.ok(md.includes('声明B [1]'), '重复 URL 共享同角标')
  assert.ok(!md.includes('来源：'), '降级版正文不再挂 *来源：*')
  assert.ok(md.includes('### 参考来源'))
  assert.ok(md.includes('- [1] [techcrunch.com](<https://techcrunch.com/a>)'))
  assert.ok(md.includes('- [2] [example.org](<https://example.org/b>)'))
  assert.ok(!md.includes('(多源公认)'), '非 URL 来源不角标化')
})

test('降级版：windowMisses 过滤已在 major-out 出现的条目（去重）', () => {
  const md = renderDegradedMarkdown({
    date: 'd', window: 'w',
    confirmed: [
      { claim: 'Qwen3.8-27B 开源：行业公认事实', window: 'major-out', vote: '—', verifiedByVote: false, source: '(多源公认)', date: '2026-08-15', erroredCount: 0 },
      { claim: 'Grok 4.6 发布：官方确认', window: 'major-out', vote: '—', verifiedByVote: false, source: '(多源公认)', date: '2026-08-12', erroredCount: 0 },
    ],
    refuted: [], coverage: [], degraded: [], noNewsCompanies: [],
    windowMisses: [
      { name: 'Grok 4.6 in GitHub Copilot', date: '2026-08-14', note: 'Copilot 集成' },
      { name: 'Qwen3.8-27B edge model', date: '2026-08-14', note: '端侧模型' },
      { name: 'Reproducing 2,200 ICML 论文', date: '2026-08-13', note: '复现项目' },
    ],
  })
  assert.ok(md.includes('### 窗口外·行业里程碑（2 条'))
  assert.ok(md.includes('### 📎 窗口外参考'))
  assert.ok(!md.includes('Grok 4.6 in GitHub Copilot'), '已入 major-out 的 windowMiss 去除')
  assert.ok(!md.includes('Qwen3.8-27B edge model'), '已入 major-out 的 windowMiss 去除')
  assert.ok(md.includes('Reproducing 2,200 ICML 论文'), '未入 major-out 的保留')
})

// ─── 2026-08-22 三契约缺口修复（spec 2026-08-22-ai-daily-sources-and-uncertainty-design.md）───

test('B.5 noUrl 兜底：sources 全非 URL 文字描述 + status [窗口外·重大] → [行业公认·无单一链接] 且不进参考来源节', () => {
  const report = {
    oneLiner: 'o', execSummary: 'e',
    sections: [{ board: 'labs', title: 'T', items: [
      { title: 'DeepSeek V4-Pro 上线', summary: '官方登记。', confidence: 'high', sources: ['HuggingFace 官方博客（多源公认）'], vote: '—', status: '[窗口外·重大]' },
    ]}],
    caveats: [], openQuestions: [],
  }
  const md = renderMarkdown({ date: 'd', window: 'w', report, coverage: [], windowMisses: [], degraded: [] })
  assert.ok(md.includes('[行业公认·无单一链接]'), '非 URL 来源不假装有链接')
  assert.ok(!md.includes('### 参考来源'), '该项无 URL，整份 md 不出参考来源节')
})

test('C.2 未核查徽标：status [窗口外·重大] → *[未核查·待证实]*；已核查 2-0 → 无', () => {
  const mkOne = (s, status) => renderMarkdown({ date: 'd', window: 'w',
    report: { oneLiner: 'o', execSummary: 'e', sections: [{ board: 'x', title: 'T', items: [
      { title: 'T', summary: s, confidence: 'medium', sources: ['https://x.ai/1'], vote: status.includes('已核查') ? '2-0' : '—', status },
    ]}], caveats: [], openQuestions: [] },
    coverage: [], windowMisses: [], degraded: [] })
  const unchecked = mkOne('摘要文本', '[窗口外·重大]')
  assert.ok(unchecked.includes('*[未核查·待证实]*'), '未核查项徽标必须在场')
  const plain = mkOne('摘要文本', '已核查 2-0')
  assert.ok(!plain.includes('*[未核查·待证实]*'), '已核查项不得挂未核查徽标')
})

test('B.4+A：major-out 带 URL → [n] 角标 + 参考来源节对应条目', () => {
  const md = renderMarkdown({ date: 'd', window: 'w',
    report: { oneLiner: 'o', execSummary: 'e', sections: [{ board: 'x', title: 'T', items: [
      { title: 'DeepSeek V4-Pro 上线', summary: '官方登记。', confidence: 'high', sources: ['https://api-docs.deepseek.com/news/'], vote: '—', status: '[窗口外·重大]' },
    ]}], caveats: [], openQuestions: [] },
    coverage: [], windowMisses: [], degraded: [] })
  assert.ok(md.includes('[1]'), 'major-out 带 URL 挂 [1] 角标')
  assert.ok(md.includes('### 参考来源'))
  assert.ok(md.includes('- [1] [api-docs.deepseek.com](<https://api-docs.deepseek.com/news/>)'))
})

test('已核查正常项带 URL sources → 无 [行业公认·无单一链接] 标注', () => {
  const md = renderMarkdown({ date: 'd', window: 'w',
    report: { oneLiner: 'o', execSummary: 'e', sections: [{ board: 'x', title: 'T', items: [
      { title: 'Stripe 7.5B', summary: '支付巨头。', confidence: 'medium', sources: ['https://t.co'], vote: '2-0', status: '已核查 2-0' },
    ]}], caveats: [], openQuestions: [] },
    coverage: [], windowMisses: [], degraded: [] })
  assert.ok(!md.includes('[行业公认·无单一链接]'), '已核查项带真 URL 不标 noUrl 兜底')
})
