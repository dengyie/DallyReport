import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CDP_DEFAULTS, extractTopicsFromJson, extractPostTextFromJson, fetchLinuxDoNews34 } from '../linuxdo.mjs'

const newsJson = JSON.stringify({
  topic_list: { topics: [
    { id: 100001, title: 'DeepSeek V4-Pro 发布', created_at: '2026-08-23T04:12:00.000Z', excerpt: '官方正式版上线，Agent 能力增强。', like_count: 42 },
    { id: 100002, title: 'Gemini 新能力讨论', created_at: '2026-08-22T09:00:00.000Z', excerpt: '', like_count: 0 },
  ] },
})

test('extractTopicsFromJson：标准 Discourse 列表 → {id,title,url,date,snippet,likeCount}', () => {
  const ts = extractTopicsFromJson(newsJson)
  assert.equal(ts.length, 2)
  assert.deepEqual(ts[0], {
    id: 100001, title: 'DeepSeek V4-Pro 发布', url: 'https://linux.do/t/topic/100001',
    date: '2026-08-23', snippet: '官方正式版上线，Agent 能力增强。', likeCount: 42,
  })
  assert.equal(ts[1].likeCount, 0, '缺 like_count 默认 0')
  assert.equal(ts[1].snippet, '', '缺 excerpt 默认空')
})

test('extractTopicsFromJson：容错——非 JSON / 空结构 / null → null', () => {
  assert.equal(extractTopicsFromJson(null), null)
  assert.equal(extractTopicsFromJson(''), null)
  assert.equal(extractTopicsFromJson('<html>challenge page</html>'), null, 'Cloudflare challenge 不是 JSON → null')
  assert.equal(extractTopicsFromJson('{"topic_list":{}}'), null, '无 topics → null')
  assert.equal(extractTopicsFromJson('{"topic_list":{"topics":[]}}'), null, '空 topics → null')
})

test('extractPostTextFromJson：Discourse 帖子 → 去 HTML 后纯文本（剥离标签、压空白）', () => {
  const raw = JSON.stringify({ post_stream: { posts: [
    { cooked: '<p>DeepSeek V4-Pro 正式上线，<b>Agent 能力</b>增强，支持分时段定价。</p><p>第二段  </p>' },
    { cooked: '<p>第二楼的回复。</p>' },
  ] } })
  const text = extractPostTextFromJson(raw)
  assert.ok(text.includes('DeepSeek V4-Pro 正式上线'))
  assert.ok(text.includes('Agent 能力'), '保留内联文本')
  assert.ok(!text.includes('<'), 'HTML 标签被剥离')
  assert.ok(!text.includes('第二楼'), '只取首帖（post_stream.posts[0]）')
})

test('extractPostTextFromJson：容错——非 JSON / 无 cooked → null', () => {
  assert.equal(extractPostTextFromJson('not json'), null)
  assert.equal(extractPostTextFromJson('{"post_stream":{}}'), null)
  assert.equal(extractPostTextFromJson('{"post_stream":{"posts":[{"cooked":""}]}}'), null, '空 cooked → null')
})

test('fetchLinuxDoNews34：无 cdpHost → ok:false + reason no_cdp_host，不降级、零副作用', async () => {
  const out = await fetchLinuxDoNews34({ date: '2026-08-23', cdpHost: null })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no_cdp_host')
  assert.equal(out.degraded, false, '未启用不算通道失败（CLI/手动默认不启用时板不崩）')
  assert.equal(out.posts.length, 0)
  assert.equal(out.pages, 0)
  assert.equal(out.topics, 0)
})

test('CDP_DEFAULTS：默认值符合 spec（host/maxPages/perPageDeep/poll 参数）', () => {
  assert.equal(CDP_DEFAULTS.cdpHost, '127.0.0.1:9222')
  assert.equal(CDP_DEFAULTS.maxPages, 4)
  assert.equal(CDP_DEFAULTS.perPageDeep, 3)
  assert.equal(CDP_DEFAULTS.requestTimeoutMs, 15000)
  assert.equal(CDP_DEFAULTS.pollIntervalMs, 500)
  assert.equal(CDP_DEFAULTS.pollMaxMs, 15000)
})
