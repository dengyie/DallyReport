import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, renderDegradedMarkdown } from '../render-md.mjs'
import { computeBoardStates } from '../boards.mjs'

const baseReport = {
  oneLiner: '今日 AI 行业一句话。',
  execSummary: '执行摘要三句。',
  sections: [
    { board: 'labs', title: '头部实验室·新模型', items: [
      { title: '[3-0✓] xAI 发布 Grok 4.6', summary: '要点两句。', confidence: 'high', sources: ['https://x.ai/news'], vote: '3-0✓' },
      // 新 prompt 契约：精简陈述式 title（去前置状态标签，status 单独字段）
      { title: 'Stripe $7.5B 收购 OpenRouter', summary: '支付巨头切入 AI 路由。', confidence: 'medium', sources: ['https://t.co'], vote: '2-1', status: '已核查 2-1' },
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

test('完整版：major-out 条目 vote — 原样呈现（不冒充投票）', () => {
  const md = renderMarkdown({ date: '2026-08-18', window: 'w', report: baseReport, coverage: baseCoverage, windowMisses: [], degraded: [] })
  assert.ok(md.includes('**[窗口外·重大] DeepSeek V4 开源**'))
  assert.ok(md.includes('(多源公认)'))  // 来源原样呈现
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
