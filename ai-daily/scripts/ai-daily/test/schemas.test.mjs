// schemas 全集结构合法性守卫（F5 Important）——5 个 schema 中此前仅 REPORT_SCHEMA.status 有断言，其余 4 个裸。
// 目标：为 DISCOVER/HARVEST/EXTRACT/VERDICT/REPORT 各写结构守卫：required 非空、关键字段/enum 在场、可 JSON.stringify。
// 与 workflow 内逐字节一致（schemas.mjs 是真源，build 剥 export inline 进产物）。改 schema 结构须同步本文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DISCOVER_SCHEMA, HARVEST_SCHEMA, EXTRACT_SCHEMA, VERDICT_SCHEMA, REPORT_SCHEMA, externalCheckState, bindExtractedClaims } from '../schemas.mjs'

const ALL = {
  DISCOVER_SCHEMA,
  HARVEST_SCHEMA,
  EXTRACT_SCHEMA,
  VERDICT_SCHEMA,
  REPORT_SCHEMA,
}

// 通用守卫：每个 schema
//   - 是 object 且可 JSON.stringify（无循环引用/无非法类型）
//   - required 是非空字符串数组
//   - properties 是对象且非空
for (const [name, schema] of Object.entries(ALL)) {
  test(`schema 通用守卫：${name} 结构合法且可序列化`, () => {
    assert.ok(schema && typeof schema === 'object', `${name} 应为对象`)
    assert.equal(schema.type, 'object', `${name}.type 应为 object`)
    assert.ok(Array.isArray(schema.required), `${name}.required 应为数组`)
    assert.ok(schema.required.length > 0, `${name}.required 不应为空`)
    for (const k of schema.required) {
      assert.equal(typeof k, 'string', `${name}.required 元素应为字符串`)
    }
    assert.ok(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties), `${name}.properties 应为对象`)
    assert.ok(Object.keys(schema.properties).length > 0, `${name}.properties 不应为空`)
    assert.doesNotThrow(() => JSON.stringify(schema), `${name} 应可 JSON.stringify（无循环引用）`)
    // 序列化必须保留 required 与 properties 全键（JSON Schema 结构无损失）
    const roundtrip = JSON.parse(JSON.stringify(schema))
    assert.deepEqual(roundtrip.required, schema.required, `${name} 序列化往返后 required 不变`)
    assert.deepEqual(Object.keys(roundtrip.properties), Object.keys(schema.properties), `${name} 序列化往返后 properties 键不变`)
  })
}

// 各 schema 特有结构守卫
test('DISCOVER_SCHEMA：items 含 url/title/found_via/date 且必填', () => {
  const items = DISCOVER_SCHEMA.properties.urls.items
  assert.equal(items.type, 'object', 'urls 元素应为 object')
  for (const k of ['url', 'title', 'found_via', 'date']) {
    assert.ok(items.required.includes(k), `urls 元素 required 应含 ${k}`)
  }
  assert.ok(items.properties && typeof items.properties === 'object' && !Array.isArray(items.properties), 'urls 元素 properties 应为对象')
  assert.ok(DISCOVER_SCHEMA.properties.urls.items.properties.found_via, 'found_via 应在 items.properties 定义类型')
  // noNews / degraded 等辅件存在
  assert.ok(DISCOVER_SCHEMA.properties.noNews, '应有 noNews')
  assert.ok(DISCOVER_SCHEMA.properties.degraded, '应有 degraded')
})

test('HARVEST_SCHEMA：entries 条目标签含 date/title/url，recent 额外含 note', () => {
  const entries = HARVEST_SCHEMA.properties.entries.items
  for (const k of ['date', 'title', 'url']) {
    assert.ok(entries.required.includes(k), `entries 元素 required 应含 ${k}`)
  }
  for (const k of ['date', 'title', 'url', 'note']) {
    assert.ok(HARVEST_SCHEMA.properties.recent.items.required.includes(k), `recent 元素 required 应含 ${k}`)
  }
})

test('EXTRACT_SCHEMA：sourceQuality enum 与 claims.importance enum 在场', () => {
  assert.deepEqual(EXTRACT_SCHEMA.properties.sourceQuality.enum, ['primary', 'secondary', 'blog', 'forum', 'unreliable'], 'sourceQuality enum 应精确匹配')
  const claims = EXTRACT_SCHEMA.properties.claims.items
  for (const k of ['claim', 'quote', 'importance']) {
    assert.ok(claims.required.includes(k), `claims 元素 required 应含 ${k}`)
  }
  assert.deepEqual(claims.properties.importance.enum, ['central', 'supporting', 'tangential'], 'importance enum 应精确匹配')
})

test('VERDICT_SCHEMA：required 三键 + confidence enum', () => {
  assert.deepEqual(VERDICT_SCHEMA.required, ['refuted', 'evidence', 'confidence'], 'required 应精确为三项')
  assert.deepEqual(VERDICT_SCHEMA.properties.confidence.enum, ['high', 'medium', 'low'], 'confidence enum 应精确匹配')
})

test('REPORT_SCHEMA：required 五键 + 嵌套 items 结构完整', () => {
  assert.deepEqual(REPORT_SCHEMA.required, ['oneLiner', 'execSummary', 'sections', 'caveats', 'openQuestions'])
  const itemProps = REPORT_SCHEMA.properties.sections.items.properties.items.items.properties
  for (const k of ['title', 'summary', 'confidence', 'sources']) {
    assert.ok(REPORT_SCHEMA.properties.sections.items.properties.items.items.required.includes(k), `REPORT items required 应含 ${k}`)
  }
  // status 枚举字面量（与 status-enum.test.mjs 同一断言，此处聚焦结构连通性）
  assert.ok(itemProps.status && Array.isArray(itemProps.status.enum), 'sections[].items[].items.properties.status 应为 enum 约束')
  assert.deepEqual(itemProps.status.enum, ['已核查 2-0', '已核查 2-1', '[窗口外·重大]', '未核查', '已否决'])
  // sources 元素为 string 数组
  assert.equal(itemProps.sources.type, 'array', 'sources 应为数组')
  assert.equal(itemProps.sources.items.type, 'string', 'sources 元素应为 string')
})
// ─── 9/19 P2-2：外部抽查票三态判定（行为级）───

test('externalCheckState：refuted / corroborated / unavailable 三态判定', () => {
  assert.equal(externalCheckState({ refuted: true, evidence: 'e', confidence: 'high' }), 'refuted', '独立证据否决')
  assert.equal(externalCheckState({ refuted: false, evidence: 'e', confidence: 'high' }), 'corroborated', '佐证成立')
  assert.equal(externalCheckState({ refuted: false, toolsUnavailable: true, evidence: '工具不可用', confidence: 'low' }), 'unavailable',
    '模型自报 toolsUnavailable → unavailable（绝不落 corroborated——9/19 review P2-2 根因）')
  assert.equal(externalCheckState({ refuted: false, toolsUnavailable: true, evidence: 'e' }), 'unavailable', '无 confidence 也可判（字段可选消费）')
  // fail-safe：代理失败（null）/异常形状一律 unavailable，不冒充佐证
  assert.equal(externalCheckState(null), 'unavailable')
  assert.equal(externalCheckState(undefined), 'unavailable')
  assert.equal(externalCheckState('garbage'), 'unavailable')
  assert.equal(externalCheckState({}), 'corroborated', '合法空票（refuted=false 隐含）→ corroborated')
})

test('VERDICT_SCHEMA：toolsUnavailable 可选字段在场（内部票零影响）', () => {
  assert.equal(VERDICT_SCHEMA.properties.toolsUnavailable.type, 'boolean')
  assert.ok(!VERDICT_SCHEMA.required.includes('toolsUnavailable'), '可选字段——内部票不填仍过 schema')
})

// ─── 09-21：index_page_citation 把文章页缺 sourceUrl 也算进去（21/42）───
// 根因：模板对所有 !su 的 claim 都 indexCitation++，再 sourceUrl 回落 src.url。
// 文章页（huggingface/qbitai/reuters）的 src.url 本身就是正文页，缺可选 sourceUrl 不是索引页引用。
// 只有 static-fallback 索引页缺文章 sourceUrl 才算 index citation，且不得把索引 URL 注入 claim。

const _claim = (over = {}) => ({ claim: 'c', quote: 'q'.repeat(80), importance: 'central', ...over })

test('bindExtractedClaims：文章页缺 sourceUrl 回落 src.url，不计 index citation（09-21 误计根因）', () => {
  const src = { url: 'https://huggingface.co/papers/2609.20519', title: 'SoL-Pi', found_via: 'huggingface.co/papers 共享源摘要', date: '2026-09-17', board: 'opensource' }
  const ext = { sourceQuality: 'primary', publishDate: '2026-09-17', claims: [_claim(), _claim({ claim: 'c2' })] }
  const out = bindExtractedClaims(ext, src)
  assert.equal(out.indexClaimDropped, 0, '文章页缺可选 sourceUrl 不是索引页引用')
  assert.equal(out.indexCitation, undefined, '返回值不得再叫 indexCitation')
  assert.equal(out.claims.length, 2)
  assert.equal(out.claims[0].sourceUrl, src.url)
  assert.equal(out.sourceQuality, 'primary')
})

test('bindExtractedClaims：索引页缺文章 sourceUrl → 丢弃 claim 且计数（不得拿栏目页当引用）', () => {
  const src = { url: 'https://x.ai/news', title: 'xAI News', found_via: 'static-fallback', date: '2026-09-18', board: 'labs' }
  const ext = { sourceQuality: 'primary', publishDate: '2026-09-18', claims: [_claim(), _claim({ claim: 'c2' }), _claim({ claim: 'c3' })] }
  const out = bindExtractedClaims(ext, src)
  assert.equal(out.indexClaimDropped, 3, '3 条缺文章 URL 的索引页 claim 计入丢弃数')
  assert.equal(out.claims.length, 0, '不得把 https://x.ai/news 栏目页注入 claim.sourceUrl')
  assert.equal(out.sourceQuality, 'unreliable', '索引页零文章 claim → unreliable（对齐 fetchPrompt）')
})

test('bindExtractedClaims：索引页选出真实文章 URL 则保留，不计 citation', () => {
  const src = { url: 'https://www.anthropic.com/news', title: 'Anthropic News', found_via: 'static-fallback', date: '2026-09-18', board: 'labs' }
  const ext = { sourceQuality: 'primary', publishDate: '2026-09-18', claims: [
    _claim({ sourceUrl: 'https://www.anthropic.com/news/claude-opus' }),
    _claim({ claim: '目录条目本身', sourceUrl: 'not-a-url' }),
  ] }
  const out = bindExtractedClaims(ext, src)
  assert.equal(out.claims.length, 1)
  assert.equal(out.claims[0].sourceUrl, 'https://www.anthropic.com/news/claude-opus')
  assert.equal(out.indexClaimDropped, 1, '无合法文章 URL 的那条计入丢弃数')
  assert.equal(out.sourceQuality, 'primary', '仍有真实文章 claim → 不降 unreliable')
})
