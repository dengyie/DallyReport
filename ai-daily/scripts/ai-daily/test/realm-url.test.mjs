// 验证 workflow realm 缺失 URL 全局时，polyfill 注入后 buildCitationMap/citationBadges 正常产 [n] 角标。
// 根因（2026-08-22 实证）：Workflow 脚本 realm 无 URL 全局（typeof URL === 'undefined'），
// render-md 的 buildCitationMap/citationBadges 用 `new URL(s).href` → 抛 ReferenceError → catch{continue}
// 静默吞掉所有 URL → citeMap 空 → 完整版 md 0 角标、0 参考来源节、全项 [行业公认·无单一链接] 兜底。
// 修复：在 ai-daily.template.js 顶部（模块 inline 前）注入最小 WHATWG URL polyfill 到 globalThis。
// 本测模拟 realm（删 URL）后注入 polyfill，断言角标生成。
import { renderMarkdown, buildCitationMap, setUrlPolyfillForRealm } from '../render-md.mjs'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

// 模拟 workflow realm：临时移除全局 URL，验证 polyfill 注入恢复功能。
const savedURL = globalThis.URL
const withRealmSimulated = fn => {
  try {
    delete globalThis.URL
    return fn()
  } finally {
    if (savedURL) globalThis.URL = savedURL
  }
}

test('realm 无 URL 时 buildCitationMap 返回空（复现 bug）', () => {
  withRealmSimulated(() => {
    const report = { sections: [{ items: [{ sources: ['https://example.com/a'] }] }] }
    const cm = buildCitationMap(report.sections)
    assert.equal(cm.list.length, 0, '无 URL 全局时 citeMap 应为空（复现 0 角标 bug）')
  })
})

test('注入 polyfill 后 buildCitationMap 产 URL 条目', () => {
  withRealmSimulated(() => {
    setUrlPolyfillForRealm()
    const report = { sections: [{ items: [{ sources: ['https://example.com/a', '非URL描述'] }] }] }
    const cm = buildCitationMap(report.sections)
    assert.equal(cm.list.length, 1)
    assert.equal(cm.list[0].url, 'https://example.com/a')
    assert.equal(cm.list[0].n, 1)
    assert.match(cm.list[0].title, /example\.com/)
  })
})

test('注入 polyfill 后完整版 md 含 [n] 角标 + 参考来源节', () => {
  withRealmSimulated(() => {
    setUrlPolyfillForRealm()
    const report = {
      oneLiner: 'x', execSummary: 'y', caveats: [], openQuestions: [],
      sections: [{ board: 'labs', title: '新模型', items: [
        { title: 'Test model', summary: 'A released.', confidence: 'high', sources: ['https://example.com/news'], status: '已核查 2-0', vote: '2-0' }
      ] }]
    }
    const md = renderMarkdown({ date: '2026-08-22', window: '2026-08-20 ~ 2026-08-22', report, coverage: [], windowMisses: [], degraded: [], meta: { date: '2026-08-22', window: 'x', stats: { confirmed: 1, major_out: 0, killed: 0, urls_fetched: 1 }, generated_by: 'ai-daily' } })
    assert.ok(md.includes('[1]'), '应含 [1] 角标')
    assert.ok(md.includes('### 参考来源'), '应含参考来源节')
    assert.ok(!md.includes('[行业公认·无单一链接]'), 'URL 来源项不应触发 noUrl 兜底')
  })
})

test('polyfill href 幂等：同输入两次 new URL 同输出（map key 一致）', () => {
  withRealmSimulated(() => {
    setUrlPolyfillForRealm()
    const a = new globalThis.URL('https://api-docs.deepseek.com/news/').href
    const b = new globalThis.URL('https://api-docs.deepseek.com/news/').href
    assert.equal(a, b)
    assert.equal(a, 'https://api-docs.deepseek.com/news/')
  })
})

test('polyfill hostname 提取正确', () => {
  withRealmSimulated(() => {
    setUrlPolyfillForRealm()
    assert.equal(new globalThis.URL('https://x.ai/news/grok-4-6').hostname, 'x.ai')
    assert.equal(new globalThis.URL('https://blogs.nvidia.com/blog/foo/').hostname, 'blogs.nvidia.com')
  })
})

test('polyfill 非 URL 输入抛错（保留 buildCitationMap 的 catch 语义）', () => {
  withRealmSimulated(() => {
    setUrlPolyfillForRealm()
    assert.throws(() => new globalThis.URL('非URL描述'), /invalid url/i)
  })
})
