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

// hostname 提取（本地实现，不 import render-md——render-md 是末模块，会循环依赖）。
// 种子带可选 url 字段：有 url 的 major-out 项 sourceUrl 是真 URL → buildCitationMap 正常编号挂 [n] 角标。
// (与 render-md buildCitationMap 的 hostname 逻辑复刻一致；两模块都不 import 对方)
const _hostnameOf = s => {
  try { return new URL(s).hostname } catch { return null }
}

const _mkMajor = (m, board) => {
  const host = _hostnameOf(m.url)
  return {
    claim: m.name + '：' + m.note, quote: m.note,
    sourceUrl: m.url || '(多源公认)',
    sourceTitle: host || '行业客观公认事实',
    date: m.date, board: board, publishDate: m.date, sourceQuality: 'primary', importance: 'central',
    verdicts: [], refutedCount: 0, erroredCount: 0, survives: true, isRefuted: false, isMajorOut: true, vote: '—',
    // verifiedByVote:false —— [窗口外·重大] 未经过窗口内对抗投票，reportBody 统一渲染 Vote: —（未投票），不得冒充 3-0。
  }
}

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

// 静态候选优先：把 found_via==='static-fallback' 的项移到数组前部，组内保持原顺序；返回新数组，
// 不修改输入数组与项对象。8/27 Fetch 预算书账：静态源（官方新闻页）在预算紧张时优先摄入，
// 保证 discover 全失败 + harvest 兜底缺时，静态兜底 URL 仍能先进 Fetch 配额（而非被排在普通候选中
// 挤到 budgetDropped）。只排序不增减项——不承诺恢复 budgetDropped 项，MAX_FETCH 是总上限。
export const preferStaticFirst = targets => {
  const statics = []
  const others = []
  for (const t of targets) (t && t.found_via === 'static-fallback' ? statics : others).push(t)
  return statics.concat(others)
}

// 轮询公平分配 fetch 预算：每轮每板块至多取 1 个未抓 URL，直到 maxFetch 耗尽——保证晚序板块不被压占。
// boardURLMap: Map<boardKey, urlObj[]>（urlObj 带 url 字段；函数内补 board 字段）。
// 8/27 Task 1：可选 prefer 通道——found_via 命中 preferFoundVia（默认 ['linuxdo-cdp','static-fallback']）
// 的候选先于轮询占位（去重后按 cap=⌊MAX_FETCH×preferShare⌋ 封顶，单板墙量配额不能吃光整个预算），
// 剩余 slots 仍走既有轮询公平。**默认行为与旧版逐字节一致**（无 prefer 候选时此阶段为 no-op）。
// 用途：linux-do 预抓内容（linuxdo-cdp）与静态兜底（static-fallback）是"已投入资源、应当消费"的候选，
// 之前与普通候选混池轮询，会被其他板块的轮询名额挤到 budgetDropped（8/26 实测 fetch_budget_dropped:45
// 中大量是预抓的 linux.do 帖子）。prefer 通道保证它们在预算紧张时仍真实进入 Fetch/Verify。
// 返回 { fetchTargets, dupes, budgetDropped }，与现行编排内逻辑逐字对齐。
export const allocateFetchBudget = (boardURLMap, MAX_FETCH, opts) => {
  const dupes = []
  const budgetDropped = []
  const seen = new Map()
  const fetchTargets = []
  const prefer = new Set((opts && opts.preferFoundVia) || ['linuxdo-cdp', 'static-fallback'])
  const preferShare = (opts && typeof opts.preferShare === 'number') ? opts.preferShare : 0.5
  // prefer 通道封顶：floor(MAX_FETCH × preferShare)，单板墙量配额不能吃光整个预算。
  // preferShare=0 → 封顶 0 → 通道整体关闭（回退纯轮询）；默认 0.5。
  const preferCap = MAX_FETCH <= 0 ? 0 : Math.floor(MAX_FETCH * Math.min(1, Math.max(0, preferShare)))
  const boardURLs = [...boardURLMap.entries()].map(([board, urls]) => ({ board, urls }))

  // Phase 1 — prefer：吃下命中 prefer 的候选（去重、封顶到 preferCap）。preferCap=0 时本阶段整体关闭。
  //
  // 8/31 P2 修复：改**按通道轮询**分配，不再「板间先到先得」。
  // 旧版按 boardURLMap 插入序逐板吃满 preferCap：template 中 linuxdo CDP 预块的 discoverResults.push
  // 早于普通组（`batch.filter(g => !g.cdp)`）→ linuxdo 带 24 个候选排第一 → preferCap=8 全被它吃光，
  // static-fallback 只能回轮询里挤。8/31 实证 `linuxdo-cdp 进配额 10（丢弃 14）` 而 `static_fallback:5` 全丢。
  // 而 ROI 是**倒挂**的：静态 2 席 → 3 claims（techcrunch 1 confirmed）；linuxdo 9 席 → 3 claims
  // （仅 1 帖有产出，另 8 席 claimCount 0、quality unreliable）→ 静态单席产出是 linuxdo 的 4.5×。
  // MAX_FETCH 12→16 的上调把 preferCap 6→8，旧逻辑下等于又白送 linuxdo 两席。
  //
  // 新语义：preferCap 在**实际有候选的通道**间等分（round-robin 逐轮每通道取 1），任一通道用不满的
  // 余量自然流给其它通道（轮询到无候选即跳过）——既给每条通道保底下限，又不浪费配额。
  // 通道内仍按板轮询（每轮每板至多 1），保持板间公平。
  if (preferCap > 0) {
    // 通道 → 该通道的候选队列（按板轮询序展开：第 1 轮各板首个候选、第 2 轮各板次个……）
    const queues = new Map()
    for (const via of prefer) queues.set(via, [])
    let maxLen = 0
    for (const b of boardURLs) maxLen = Math.max(maxLen, b.urls.length)
    for (let i = 0; i < maxLen; i++) {
      for (const b of boardURLs) {
        const u = b.urls[i]
        if (!u || !prefer.has(u.found_via)) continue
        queues.get(u.found_via).push({ u, board: b.board })
      }
    }
    // 只保留真有候选的通道参与等分（否则空通道会白占份额）
    const live = [...queues.entries()].filter(([, q]) => q.length).map(([via, q]) => ({ via, q, i: 0 }))
    let progressedPrefer = live.length > 0
    while (progressedPrefer && fetchTargets.length < preferCap) {
      progressedPrefer = false
      for (const ch of live) {
        if (fetchTargets.length >= preferCap) break
        // 取该通道下一个未被去重吃掉的候选（每轮每通道至多 1 席）
        while (ch.i < ch.q.length) {
          const { u, board } = ch.q[ch.i++]
          const key = normURL(u.url)
          if (seen.has(key)) continue
          seen.set(key, true); u.board = board
          fetchTargets.push(u); progressedPrefer = true
          break
        }
      }
    }
  }

  let fetchSlots = MAX_FETCH - fetchTargets.length
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
        break // 每板每轮至多一个名额
      }
    }
  }
  for (const b of boardURLs) for (const u of b.urls) if (!seen.has(normURL(u.url))) budgetDropped.push({ url: u.url, board: b.board })
  const keyCount = new Map()
  for (const b of boardURLs) for (const u of b.urls) { const k = normURL(u.url); keyCount.set(k, (keyCount.get(k) || 0) + 1) }
  for (const b of boardURLs) for (const u of b.urls) { const k = normURL(u.url); if ((keyCount.get(k) || 0) > 1) { dupes.push({ url: u.url, board: b.board }); keyCount.set(k, 0) } }
  return { fetchTargets, dupes, budgetDropped }
}
