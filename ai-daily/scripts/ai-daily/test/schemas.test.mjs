// schemas 全集结构合法性守卫（F5 Important）——5 个 schema 中此前仅 REPORT_SCHEMA.status 有断言，其余 4 个裸。
// 目标：为 DISCOVER/HARVEST/EXTRACT/VERDICT/REPORT 各写结构守卫：required 非空、关键字段/enum 在场、可 JSON.stringify。
// 与 workflow 内逐字节一致（schemas.mjs 是真源，build 剥 export inline 进产物）。改 schema 结构须同步本文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DISCOVER_SCHEMA, HARVEST_SCHEMA, EXTRACT_SCHEMA, VERDICT_SCHEMA, REPORT_SCHEMA } from '../schemas.mjs'

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