import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, renderDegradedMarkdown } from '../render-md.mjs'

const baseReport = {
  oneLiner: '今日 AI 行业一句话。',
  execSummary: '执行摘要三句。',
  sections: [
    { board: 'labs', title: '头部实验室·新模型', items: [
      { title: '[3-0✓] xAI 发布 Grok 4.6', summary: '要点两句。', confidence: 'high', sources: ['https://x.ai/news'], vote: '3-0✓' },
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
  assert.ok(md.includes('`3-0✓`'))
  assert.ok(md.includes('## ⚠️ 未验证与局限'))
  assert.ok(md.includes('某条弱来源。'))
  assert.ok(md.includes('## ❓ 开放问题'))
  assert.ok(md.includes('## ✅ 覆盖自检'))
  assert.ok(md.includes('`[degraded]`'))  // strategy degraded 标注
})

test('完整版：major-out 条目 vote — 原样呈现（不冒充投票）', () => {
  const md = renderMarkdown({ date: '2026-08-18', window: 'w', report: baseReport, coverage: baseCoverage, windowMisses: [], degraded: [] })
  assert.ok(md.includes('[窗口外·重大] DeepSeek V4 开源'))
  assert.ok(md.includes('`—`'))
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

test('降级版：标注降级原因 + 窗口内/major-out/refuted 分节', () => {
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
  assert.ok(md.includes('降级合成版'))
  assert.ok(md.includes('report agent failed'))
  assert.ok(md.includes('## 窗口内已核查（1 条'))
  assert.ok(md.includes('✓ 投票 2-0'))
  assert.ok(md.includes('[窗口外·重大] 行业里程碑注入（1 条'))
  assert.ok(md.includes('~~被否决声明B~~ → 否决 0-2'))
  assert.ok(md.includes('无动态：OpenAI、NVIDIA'))
  assert.ok(md.includes('`report_failed`'))
})

test('降级版：erroredCount>0 可见（观察项③在降级路径也不丢）', () => {
  const md = renderDegradedMarkdown({
    date: 'd', window: 'w',
    confirmed: [{ claim: 'A', window: 'in', vote: '2-0', verifiedByVote: true, source: 'https://x/a', date: '2026-08-17', erroredCount: 1 }],
    refuted: [], coverage: [], windowMisses: [], degraded: [], noNewsCompanies: [],
  })
  assert.ok(md.includes('⚠️1 票错误'))
})

test('降级版：空数据不崩（边界）', () => {
  const md = renderDegradedMarkdown({ date: 'd', window: 'w', confirmed: [], refuted: [], coverage: [], windowMisses: [], degraded: [], noNewsCompanies: [] })
  assert.ok(md.includes('窗口内已核查（0 条'))
  assert.ok(md.includes('| 板块 | 标题 |'))
})
