// ai-daily 日期/URL/数组纯函数 — 与 workflow 内逐字节一致（claimWindow 改工厂注入，唯一签名变化）。

export const URL_HOST_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\\]*@)?(?:www\.)?([^/:?#@\\]+)(?::\d+)?([^?#]*)/i
export const normURL = u => { const m = String(u).match(URL_HOST_PATTERN); return m ? (m[1] + m[2].replace(/\/$/, '')).toLowerCase() : String(u).toLowerCase() }
export const hostOf = u => (String(u || '').match(URL_HOST_PATTERN)?.[1] || 'unknown').toLowerCase()

export const pad2 = n => String(n).padStart(2, '0')
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
export const normalizeDate = s => {
  if (!s) return null
  const str = String(s).trim()
  let m
  if ((m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return +(m[1] + pad2(+m[2]) + pad2(+m[3]))
  if ((m = str.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/))) return +(m[1] + pad2(+m[2]) + pad2(+m[3]))
  if ((m = str.match(/^(\d{4})(\d{2})(\d{2})/))) return +m[0]
  if ((m = str.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/))) return +(m[3] + pad2(+m[1]) + pad2(+m[2]))
  const mm = MONTHS[str.slice(0, 3).toLowerCase()]
  if (mm) {
    if ((m = str.match(/(\d{1,2}),?\s*(\d{4})/))) return +(m[2] + pad2(mm) + pad2(+m[1]))
    if ((m = str.match(/(\d{4}),?\s+(\d{1,2})/))) return +(m[1] + pad2(mm) + pad2(+m[2]))
  }
  return null
}

// 工厂化：现行 claimWindow 闭包依赖全局 WIN_FROM/WIN_TO，模块化后显式注入。返回的函数语义逐字不变。
export const makeClaimWindow = (WIN_FROM, WIN_TO) => c => {
  const cands = [c.publishDate, c.date].map(normalizeDate).filter(x => x != null)
  if (!cands.length) return 'unknown'
  return cands.every(x => x >= WIN_FROM && x <= WIN_TO) ? 'in' : 'out'
}

// 日历天数差（reportDay − seedDay；正=seed 早于 report）。YYYYMMDD 数值→天数。
// 纯算术、无 Date.now()/new Date()——Workflow realm 安全（realm 禁 Date）。
export const daysBetween = (seedDayNum, reportDayNum) => {
  const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const dom = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  const dayNum = (y, m, d) => { let n = 0; for (let Y = 1970; Y < y; Y++) n += isLeap(Y) ? 366 : 365; for (let M = 1; M < m; M++) n += dom(y, M); return n + d }
  const p = n => ({ y: Math.floor(n / 10000), m: Math.floor(n / 100) % 100, d: n % 100 })
  const a = p(seedDayNum), b = p(reportDayNum)
  return dayNum(b.y, b.m, b.d) - dayNum(a.y, a.m, a.d)
}

// age gate：种子距 report 超 maxAgeDays，或日期不可解析（normalizeDate→null）→ 剔除。
// fail-open：reportDateNum == null（未知）返回原数组，不因 gate 清空 major-out 节。
export const filterSeedsByAge = (seeds, reportDayNum, maxAgeDays) => {
  if (reportDayNum == null) return seeds
  return seeds.filter(s => {
    const day = normalizeDate(s.date)
    if (day == null) return false            // 无日期 → 超期剔除（调用方 SEED-AGE 日志可见）
    return daysBetween(day, reportDayNum) <= maxAgeDays
  })
}

export const chunkArr = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
