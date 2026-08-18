// ai-daily 指纹去重 + 轮询公平分配 — 三个历史 bug 在此固化（测试锁定）。
import { normURL } from './date-utils.mjs'

// 同一事实的关键词指纹（取公司/产品名）：发现代理上报与 KNOWN 种子若指同一事件只保留一份。
// 顺序锁定：hassabis 必须在 jeff-dean 前（8/16 bug：含两人的条目被误并入 jeff-dean）。
export const majorKey = name => {
  const t = String(name).toLowerCase()
  if (/v4\s*(pro|flash)|(?:deepseek|深度求索)\s*v4/.test(t)) return 'deepseek-v4'
  if (/harness/.test(t)) return 'deepseek-harness'
  if (/grok\s*4\.6|4\.6/.test(t) && /grok/.test(t)) return 'grok-4.6'
  if (/muse\s*glimmer/.test(t)) return 'muse-glimmer'
  if (/hassabis|哈萨比斯/.test(t)) return 'hassabis'
  if (/jeff\s*dean|杰夫/.test(t)) return 'jeff-dean'
  if (/gemini/.test(t)) return 'gemini'
  // 8/16 实测补漏：GPT-5.6 与 Fable 联手攻克悬置 25 年数学难题，两个发现组表述不同走不进兜底指纹 → 重复入稿。
  if (/gpt-?5\.6/.test(t) && /fable/.test(t) && /数学|math/.test(t)) return 'gpt5.6-math'
  // 兜底：剥离括号限定词后按实体指纹合并
  return String(name).toLowerCase().replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '')
}

const _mkMajor = (m, board) => ({
  claim: m.name + '：' + m.note, quote: m.note, sourceUrl: '(多源公认)', sourceTitle: '行业客观公认事实',
  date: m.date, board: board, publishDate: m.date, sourceQuality: 'primary', importance: 'central',
  verdicts: [], refutedCount: 0, erroredCount: 0, survives: true, isRefuted: false, isMajorOut: true, vote: '—',
  // verifiedByVote:false —— [窗口外·重大] 未经过窗口内对抗投票，reportBody 统一渲染 Vote: —（未投票），不得冒充 3-0。
})

// 工厂返回 _addMajor(m, board)，语义同现行：全 claim 与首段各测一次指纹（8/16 xAI 前缀 bug 修复）；日期更具体者覆盖。
export const makeAddMajor = majorOutClaims => (m, board) => {
  const k = majorKey(m.name)
  const ex = majorOutClaims.find(x => majorKey(x.claim || '') === k || majorKey(String(x.claim || '').split('：')[0]) === k)
  if (ex) {
    const exHasDay = /\d{4}-\d{2}-\d{2}/.test(ex.date || ''); const newHasDay = /\d{4}-\d{2}-\d{2}/.test(m.date || '')
    if (newHasDay && !exHasDay) { ex.date = m.date; ex.publishDate = m.date; ex.claim = m.name + '：' + m.note; ex.quote = m.note }
    return
  }
  majorOutClaims.push(_mkMajor(m, board))
}

// 轮询公平分配 fetch 预算：每轮每板块至多取 1 个未抓 URL，直到 maxFetch 耗尽——保证晚序板块不被挤掉。
// boardURLMap: Map<boardKey, urlObj[]>（urlObj 带 url 字段；函数内补 board 字段）。
// 返回 { fetchTargets, dupes, budgetDropped }，与现行编排内逻辑逐字对齐。
export const allocateFetchBudget = (boardURLMap, MAX_FETCH) => {
  const dupes = []
  const budgetDropped = []
  const seen = new Map()
  let fetchSlots = MAX_FETCH
  const fetchTargets = []
  const boardURLs = [...boardURLMap.entries()].map(([board, urls]) => ({ board, urls }))
  let progressed = true
  while (progressed && fetchSlots > 0) {
    progressed = false
    for (const b of boardURLs) {
      if (fetchSlots <= 0) break
      for (const u of b.urls) {
        const key = normURL(u.url)
        if (seen.has(key)) continue
        seen.set(key, true); u.board = b.board
        fetchTargets.push(u); fetchSlots--; progressed = true
        break  // 每板块每轮至多一个名额
      }
    }
  }
  for (const b of boardURLs) for (const u of b.urls) if (!seen.has(normURL(u.url))) budgetDropped.push({ url: u.url, board: b.board })
  const keyCount = new Map()
  for (const b of boardURLs) for (const u of b.urls) { const k = normURL(u.url); keyCount.set(k, (keyCount.get(k) || 0) + 1) }
  for (const b of boardURLs) for (const u of b.urls) { const k = normURL(u.url); if ((keyCount.get(k) || 0) > 1) { dupes.push({ url: u.url, board: b.board }); keyCount.set(k, 0) } }
  return { fetchTargets, dupes, budgetDropped }
}
