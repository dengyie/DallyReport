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

export const chunkArr = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
