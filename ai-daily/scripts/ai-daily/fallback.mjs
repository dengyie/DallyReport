// ai-daily discover 兜底构造器 — 纯函数，供 template inline 与测试直调。
// 8/22 第二十项：disc 失败的组，从 harvest 已抓到的 digestByKey entries 补 URL 候选进 boardURLMap，
// 不重跑代理（省墙钟、不烧 token）。本模块抽出兜底构造逻辑为纯函数，消除"测试复刻修复逻辑"的 forward-test 缺陷
// （测试直调此函数，断言真实兜底行为，而非 grep 模板源码）。
//
// 依赖注入（template inline 后这些都在闭包内可见）：normURL、claimWindow。
// claimWindow = makeClaimWindow(...) 返回的函数 c => 'in'|'out'|'unknown'，判 !== 'out'（含 in 与无日期 unknown）。

/**
 * 从 harvest digest 构造兜底 URL 候选。
 * @param {Map} digestByKey key=normURL(feed.url) → {feed, entries, recent, failed}
 * @param {Array<{key:string,boards:string[],feeds?:string[]}>} failedGroups discover 失败的组
 * @param {(c:{date?:string})=>string} claimWindow 窗口判定函数（!== 'out' 即纳入）
 * @param {(u:string)=>string} normURL URL 归一化（去 query/hash，与 digestByKey 存键一致）
 * @returns {{fallbackByUrl:Array, recoveredBoards:Set<string>}}
 *   fallbackByUrl 每项 {url,title,date,board,found_via:'harvest-fallback'}；recoveredBoards 记救回的板。
 */
export const buildFallback = (digestByKey, failedGroups, claimWindow, normURL) => {
  const fallbackByUrl = []
  const recoveredBoards = new Set()
  for (const g of failedGroups || []) {
    // srcUrls：合组走 g.feeds（硬编码组源），单板组从组 boards 派生订阅源（feeds+companies feed+labs 官方源）。
    // 注意：srcUrls 的来源由调用方（template）构造后传入更合适，但为保持纯函数自包含，这里接收 failedGroups
    // 已带 srcUrls 的形态——template 在调用前把 srcUrls 预算进 g（见 template inline 版本，下方兼容 g.feeds）。
    // 防御：把 g 归一成安全形态——srcUrls/feeds 必须真数组，boards 必须数组，缺省 `[]`——防 8/24 run 兜底入口
    // 对非数组/非可迭代 inputs 抛 "Spread ... iterable requires [Symbol.iterator] to be a function" 打穿整轮日报。
    if (!g || typeof g !== 'object') continue
    const srcUrls = Array.isArray(g.srcUrls) ? g.srcUrls : Array.isArray(g.feeds) ? g.feeds : []
    const gBoards = Array.isArray(g.boards) ? g.boards : []
    if (!srcUrls.length || !gBoards.length) continue
    for (const su of [...new Set(srcUrls.map(normURL))]) {
      const h = digestByKey instanceof Map ? digestByKey.get(su) : null
      if (!h || h.failed) continue
      // feed.boards 是该 feed 被订阅的全部板（feedMap 记录）；与失败组 boards 求交 = 真正归属板。
      // 防御：boards 可能是 Set 或数组；非可迭代值（null/数字/对象）视为空，绝不 spread——命中即整组跳过，不打穿整轮日报。
      const rawBoards = h.feed && h.feed.boards
      let feedBoards = []
      if (rawBoards && typeof rawBoards[Symbol.iterator] === 'function') {
        feedBoards = [...rawBoards].filter(b => g.boards.includes(b))
      }
      // 空交集说明该 feed 不属于当前失败组的任何板（冒烟子集：feed 订阅板被 BOARDS_SELECTED 过滤掉）。
      // 跳过该 entry 更诚实，不制造错误归属（首板被灌满、真实板 0 claim）。
      if (!feedBoards.length) continue
      for (const e of (Array.isArray(h.entries) ? h.entries : [])) {
        if (!(e && e.url && typeof e.url === 'string' && claimWindow({ date: e.date }) !== 'out')) continue
        for (const b of feedBoards) {
          fallbackByUrl.push({ url: e.url, title: e.title || e.url, date: e.date, board: b, found_via: 'harvest-fallback' })
          recoveredBoards.add(b)
        }
      }
    }
  }
  return { fallbackByUrl, recoveredBoards }
}
