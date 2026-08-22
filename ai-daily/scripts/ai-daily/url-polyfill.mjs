// workflow realm 缺失 URL 全局的最小 WHATWG URL polyfill（2026-08-22 实证根因）。
// Workflow 脚本 realm 无 URL（typeof URL==='undefined'），dedup._hostnameOf / render-md.buildCitationMap /
// render-md.citationBadges 的 `new URL(s)` 抛 ReferenceError 被 catch{continue/null} 静默吞：
//  → buildCitationMap 空 → 完整版 0 [n] 角标、0 参考来源节、全项 [行业公认·无单一链接] 兜底（8/22 两次 run 实证）。
// 本 polyfill 须在任何 inline 模块前注入（build MODULES 顺序：url-polyfill 第一）。
// 仅覆盖 pipeline 实际用到的 .href / .hostname / protocol；非 URL 输入抛 TypeError（保留各处 catch 语义）。
// 幂等：已存在全局 URL（node:test 直跑、或已注入）时不覆盖，保证宿主 URL 优先。
// href 返回构造时原输入字符串（规范 URL 已归一），保证 buildCitationMap 建图与 citationBadges 查图
// 用同一 polyfill、同一 key（map.get 命中）。

export const installUrlPolyfill = () => {
  if (typeof globalThis === 'undefined') return false
  if (typeof globalThis.URL !== 'undefined') return false
  const MinURL = class URL {
    constructor(input) {
      const s = String(input)
      const m = s.match(/^(https?):\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i)
      if (!m) throw new TypeError('invalid url: ' + s)
      this._href = s
      this.protocol = m[1].toLowerCase() + ':'
      this.hostname = m[2].toLowerCase()
      this.pathname = m[3] || '/'
    }
    get href() { return this._href }
  }
  globalThis.URL = MinURL
  return true
}

// 模块加载即注入（workflow realm inline 后于顶部执行；node:test 已有全局 URL 则跳过）。
installUrlPolyfill()
