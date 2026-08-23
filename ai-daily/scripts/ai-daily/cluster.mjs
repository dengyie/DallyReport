// ai-daily 确定性聚类（verify → report 之间的纯函数去重，2026-08-23 第二十一项）。
// 只做"主视图"聚类不放行：被合并的冗余 item 仍保留在 confirmed/claimsJson 归档，cluster 只影响
// reportBody 的「已聚类」呈现与正文去重（report prompt 4.7 纪律据此写）。
// clusterTokenize/clusterStopTokens 与 render-md 同款（正则 `/[a-z0-9][a-z0-9.%\-]*/g`、长度≥4、过滤
// clusterStopTokens），但**必须用不同词法名**——build.mjs 整文件 inline 会让 render-md 的同名未导出
// `tokenize`/`STOP_TOKENS` 与本文件的导出在同一顶层作用域 → 宿主 new Function 加载必抛
// `Identifier 'tokenize' has already been declared` SyntaxError（产物 C1 溃败；node --check 是假绿）。
// 双轨各自留副本（render-md 内 dedupWindowMisses 是私有函数、用户明令不改，不抽公共模块），仅为改名。

// 8/23 C1 复核修复：原名 STOP_TOKENS/tokenize 与 render-md 顶层同名冲突 → 改 clusterStopTokens/clusterTokenize。
const clusterStopTokens = new Set(['news', 'note', 'report', 'model', 'models', 'open', 'new', 'blog', 'post', 'api', 'app', 'apps', 'ai', 'pro', 'free', 'beta', 'tool', 'tools', 'official', 'release', 'update', 'announce', 'launch', 'said'])
export const clusterTokenize = s => (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9.%\-]*/g) || []).filter(t => t.length >= 4 && !clusterStopTokens.has(t))

// 聚为 unordered 对：a 与 b 的 claim/claims 任一共享 ≥1 token 即成对。
// keyOf/unionTokens 供 clusterClaims 内部使用：claim 优先，次 title。
const unionTokens = (c, f) => new Set([...(c.claim ? clusterTokenize(c.claim) : []), ...(c.title ? clusterTokenize(c.title) : [])])

/**
 * 把共享实体 token 的声明聚成簇。
 * @param {Array} claims 声明数组，每项可含 claim/title/summary/sources/status/quote 等
 * @returns {Array<{key:string, items:Array}>} 簇：key 取首条 title/claim，items 为簇内声明（原样）
 * 确定性：按输入序首现注册 token，无随机性。
 */
export const clusterClaims = claims => {
  if (!claims || !Array.isArray(claims)) return []
  const clusters = []
  const seen = new Map()   // token → cluster index（首现注册）
  for (const c of claims) {
    const ts = unionTokens(c)
    let idx = -1
    for (const t of ts) if (seen.has(t)) { idx = seen.get(t); break }
    if (idx < 0) {
      clusters.push({ key: c.title || c.claim, items: [c] })
      for (const t of ts) if (!seen.has(t)) seen.set(t, clusters.length - 1)
      continue
    }
    clusters[idx].items.push(c)
    for (const t of ts) if (!seen.has(t)) seen.set(t, idx)
  }
  return clusters
}

// 源码页的数字各自被 verify 阶段用什么字段注载——此为启发式：只在摘要文本中出现同一实体+数字差异
// 才算真冲突；否则只是两则独立陈述。当前实现保守返回 false（由 report prompt 4.7 / 3.2 在文案层处置）。
export const detectNumericConflict = items => false

const distinctByClaim = claims => { const m = new Map(); for (const c of claims) m.set((c.claim || '').trim(), c); return [...m.values()] }

const honestMergeSummary = (items, conflict) => {
  // 取 items 摘要拼接（中文顿号分隔），冲突时 + 一句「口径不一，勿相加」。
  const parts = items.map(c => (c.summary || c.quote || '').trim()).filter(Boolean)
  if (!parts.length) return ''
  return parts.join('；') + (conflict ? '（该事件多源数字口径不一，引用时勿叠加相加。）' : '')
}

/**
 * 合并同一簇：nodup 计算 -> 数字冲突解析 -> merge。
 * 返回编排同构输入（claim/title/summary/sources/status 齐），report prompt 依然只吃原始 resolved 输入。
 * @param {Array} items 同一簇的声明（原样，可能含重复 claim）
 * @param {string} [dateLabel] 保留位（合并主视图可带日期标注）
 * @param {Object} [majorOutMap] 保留位（major-out 映射，本实现不使用）
 * @returns {Object} { ...首条, claim: key, summary, sources, status?, mergedCount, numericConflict? }
 */
export const mergeCluster = (items, dateLabel, majorOutMap) => {
  const total = items.length
  const distinct = distinctByClaim(items)
  const key = distinct.map(c => c.claim || c.title).join('\n')   // 编排 key（信息熵契约新 claim）
  const numMismatch = detectNumericConflict(distinct)
  const sources = [...new Set(distinct.flatMap(c => c.sources || []))]
  const vote = distinct[0] && distinct[0].status ? distinct[0].status : null
  const summary = honestMergeSummary(distinct, numMismatch)
  const out = { ...distinct[0], claim: key, summary, sources, ...(vote ? { status: vote } : {}), mergedCount: total }
  if (numMismatch) out.numericConflict = true
  return out
}
