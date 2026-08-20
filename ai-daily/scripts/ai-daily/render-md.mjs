// ai-daily 确定性 md 渲染 — mdWriter 代理的替代。
// report 成功 → renderMarkdown（完整版）；report 失败 → renderDegradedMarkdown（降级版，原冒烟 compose 脚本正式化）。
// 两者输出都进 payloads.md 由 orchestrator 逐字节落盘，md 产出不再受网关波动影响。

const CONF_ZH = { high: '高', medium: '中', low: '低' }

const itemLine = it =>
  '- **' + it.title + '**' + (it.status ? ' `' + it.status + '`' : '') + '（' + (it.vote ? '`' + it.vote + '` ' : '') + '可信度 ' + (CONF_ZH[it.confidence] || it.confidence) + '）— ' + it.summary +
  (it.sources && it.sources.length ? ' — *来源: ' + it.sources.join(' , ') + '*' : '')

// 完整版：report 代理产出 sections 后的确定性排版。
// 输入即现行 mdWriter prompt 里 reportJson 的同构数据。
export const renderMarkdown = ({ date, window, report, coverage, windowMisses, degraded }) => {
  const L = []
  L.push('# 🤖 AI 日报 · ' + date)
  L.push('')
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
  for (const sec of report.sections || []) {
    L.push('### ' + sec.title)
    L.push('')
    for (const it of sec.items || []) L.push(itemLine(it))
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
  return L.join('\n')
}

// 降级版：report 代理失败时由编排数据确定性合成——可读快讯，不再是原始数据转储。
// 8/22 改为新闻快讯风格：按窗口内/窗口外/否决分节，每条 claim 写为完整句子，附加核查徽标。
export const renderDegradedMarkdown = ({ date, window, confirmed, refuted, coverage, windowMisses, degraded, noNewsCompanies, reportError }) => {
  const S = s => String(s || '').replace(/\s+/g, ' ').trim()
  const voteTag = x => x.verifiedByVote ? '`✓' + (x.vote || '?') + '`' : '`◇' + (x.vote || '?') + '`'
  const srcDomain = x => { try { return new URL(x.source || '').hostname } catch { return x.source || '?' } }
  const inW = (confirmed || []).filter(x => x.window === 'in')
  const maj = (confirmed || []).filter(x => x.window === 'major-out')
  const L = []
  L.push('# 🤖 AI 日报 · ' + date)
  L.push('')
  L.push('> 覆盖 ' + window + ' 窗口 · 生成器 ai-daily（deepseek-v4-flash）' + (degraded && degraded.length ? ' · 降级标记：`' + degraded.join('`、`') + '`' : ''))
  L.push('')
  L.push('## ⚠️ 本日报为**降级快讯**（report 合成代理未产出，由编排器据已核查归档拼合）')
  L.push('')
  L.push('降级原因：' + (reportError || 'report agent failed') + '。以下内容依核查结果逐条拼合，无合成代理润色编排。')
  L.push('')
  L.push('### 窗口内新闻（' + inW.length + ' 条，对抗式核查确认）')
  L.push('')
  for (const x of inW) {
    L.push('- ' + voteTag(x) + ' ' + S(x.claim) + ' — *来源：' + srcDomain(x) + '（' + (x.sourceQuality || '?') + '）*' + (x.erroredCount ? ' ⚠️' + x.erroredCount + ' 票异常' : ''))
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
      L.push('- ~~' + S(x.claim) + '~~ → 否决 `' + (x.vote || '?') + '`（' + srcDomain(x) + '）' + (x.erroredCount ? ' ⚠️' + x.erroredCount + ' 票异常' : ''))
    }
    L.push('')
  }
  if (windowMisses && windowMisses.length) {
    L.push('### 📎 窗口外参考')
    L.push('')
    for (const w of windowMisses) L.push('- ' + w.name + '（' + (w.date || '日期未知') + '）：' + w.note)
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
  return L.join('\n')
}
