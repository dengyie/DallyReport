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

// 9/13 中文聚类升级：旧版 tokenizer 只匹配 ASCII → 纯中文 claim token 集为空 → 永不聚类（同名事件
// 连日重复成稿的帮凶之一）。CJK bigram 引入后必须压住误合：①虚字/代词单字停用表（bigram 含任一即弃）；
// ②新闻套话 bigram 停用表（发布/推出/宣布……几乎每条标题都有，是「万物皆桥」的噪声源）；
// ③clusterClaims 对 CJK 路径要求 ≥3 个共享 bigram（ASCII 路径保持 ≥1 不变——拉丁实体名本身即强身份）。
const clusterCjkStopChars = new Set('的一是在不了有和人这中大为上个时来用们生到作地于出就分对成会可主发年动同进还也说要把被给跟与或及但很太更都也又再才只之所得自心又如其事吗吧呢啊嘛呀么'.split(''))
const clusterCjkStopBigrams = new Set(['发布', '推出', '宣布', '上线', '开源', '报道', '消息', '披露', '据悉', '表示', '今日', '今天', '昨日', '昨天', '最新', '正式', '已经', '即将', '预计', '有望', '目前', '全新', '相关', '升级', '更新', '支持', '提供', '包括', '通过', '之后', '以前', '以后', '进行', '出现', '成为', '以及', '同时', '另外', '此外', '其中', '日报', '视频', '图片', '模型'])

// 9/13 token 输出 = ASCII token（≥4、停用词过滤，既有契约）+ CJK bigram（≥2 汉字连续串内相邻对，
// 双停用表过滤）。中文因此进入聚类/账本指纹；拉丁行为逐字节不变。
export const clusterTokenize = s => {
  const text = String(s || '').toLowerCase()
  const out = []
  for (const t of (text.match(/[a-z0-9][a-z0-9.%\-]*/g) || [])) {
    if (t.length >= 4 && !clusterStopTokens.has(t)) out.push(t)
  }
  for (const run of (text.match(/[\u4e00-\u9fff]+/g) || [])) {
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2)
      if (clusterCjkStopChars.has(bg[0]) || clusterCjkStopChars.has(bg[1])) continue
      if (clusterCjkStopBigrams.has(bg)) continue
      out.push(bg)
    }
  }
  return out
}

// 聚为簇：①ASCII 路径——a 与 b 的 claim/claims 任一共享 ≥1 token 即成对（既有语义，拉丁实体名即强身份）；
// ②CJK 路径（9/13）——bigram 共享 ≥CJK_MIN_SHARED(3) 才成对：无关中文条目常共享 1-2 个通用词
// bigram（模型/权重/发布…后者已停用），弱信号不合并。多簇命中取计数最高，平局取最小 index（确定性）。
// keyOf/unionTokens 供 clusterClaims 内部使用：claim 优先，次 title。
const unionTokens = c => new Set([...(c.claim ? clusterTokenize(c.claim) : []), ...(c.title ? clusterTokenize(c.title) : [])])
const CJK_RE = /[\u4e00-\u9fff]/
const CJK_MIN_SHARED = 3

/**
 * 把共享实体的声明聚成簇（ASCII token ≥1 或 CJK bigram ≥3）。
 * @param {Array} claims 声明数组，每项可含 claim/title/summary/sources/status/quote 等
 * @returns {Array<{key:string, items:Array}>} 簇：key 取首条 title/claim，items 为簇内声明（原样）
 * 确定性：按输入序首现注册 token，无随机性。
 */
export const clusterClaims = claims => {
  if (!claims || !Array.isArray(claims)) return []
  const clusters = []
  const seen = new Map()   // token → cluster index（首现注册；ASCII 与 CJK bigram 同表）
  for (const c of claims) {
    const ts = [...unionTokens(c)]
    // ① ASCII 路径（既有语义）
    let idx = -1
    for (const t of ts) if (!CJK_RE.test(t) && seen.has(t)) { idx = seen.get(t); break }
    // ② CJK 路径（9/13）：bigram 计数配额
    if (idx < 0) {
      const counts = new Map()
      for (const t of ts) {
        if (!CJK_RE.test(t)) continue
        const ci = seen.get(t)
        if (ci !== undefined) counts.set(ci, (counts.get(ci) || 0) + 1)
      }
      let bestN = 0
      for (const [ci, n] of counts) {
        if (n >= CJK_MIN_SHARED && (n > bestN || (n === bestN && (idx < 0 || ci < idx)))) { idx = ci; bestN = n }
      }
    }
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

// 数字口径冲突由 report prompt 4.7 / 3.2 在文案层处置（聚类层不主动判定——保守设计，YAGNI）。
// 保留 detectNumericConflict 导出供 test 锁定保守语义，但 mergeCluster 不再消费其返回值（死分支已清理）。
export const detectNumericConflict = items => false

const distinctByClaim = claims => { const m = new Map(); for (const c of claims) m.set((c.claim || '').trim(), c); return [...m.values()] }

const honestMergeSummary = items => {
  // 取 items 摘要拼接（中文顿号分隔）。数字口径冲突由 report prompt 4.7/3.2 文案层处置，聚类层不标注。
  const parts = items.map(c => (c.summary || c.quote || '').trim()).filter(Boolean)
  if (!parts.length) return ''
  return parts.join('；')
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
  const sources = [...new Set(distinct.flatMap(c => c.sources || []))]
  const vote = distinct[0] && distinct[0].status ? distinct[0].status : null
  const summary = honestMergeSummary(distinct)
  const out = { ...distinct[0], claim: key, summary, sources, ...(vote ? { status: vote } : {}), mergedCount: total }
  return out
}
