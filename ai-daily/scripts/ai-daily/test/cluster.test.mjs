import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clusterClaims, mergeCluster, clusterTokenize, detectNumericConflict } from '../cluster.mjs'

const mk = (title, claim, sources, extras) => ({ title, claim, ...(sources ? { sources } : {}), ...extras })

test('clusterClaims：共享实体 token（NVIDIA×OpenAI）两声明并入同一簇', () => {
  // 8-22 实证重合：同一事件被拆成多条（4.25GW AI 工厂 / Nvidia 千亿加码），共享 nvidia/openai token → 一簇。
  const a = mk('NVIDIA 与 OpenAI 共建 4.25GW AI 工厂', 'NVIDIA 与 OpenAI 共建 4.25GW AI 工厂')
  const b = mk('Nvidia 千亿美元加码 OpenAI 数据中心', 'Nvidia 千亿美元加码 OpenAI 数据中心')
  const c = mk('Stripe 收购 OpenRouter', 'Stripe 收购 OpenRouter')
  const clusters = clusterClaims([a, b, c])
  assert.equal(clusters.length, 2, 'NVIDIA×OpenAI 合并，Stripe 独立 → 共 2 簇')
  const nvidiaCl = clusters.find(cl => cl.items.includes(a) && cl.items.includes(b))
  assert.ok(nvidiaCl, 'a 与 b 应在同一簇')
  assert.equal(nvidiaCl.items.length, 2)
  assert.deepEqual(nvidiaCl.items.map(x => x.title), ['NVIDIA 与 OpenAI 共建 4.25GW AI 工厂', 'Nvidia 千亿美元加码 OpenAI 数据中心'])
  const stripeCl = clusters.find(cl => cl.items.includes(c))
  assert.equal(stripeCl.items.length, 1, '异实体不误合，Stripe 自成一簇')
  assert.equal(nvidiaCl.key, a.title, '簇 key 取首条 title')
})

test('clusterClaims：异实体不误合（无共享 token → 各自成簇）', () => {
  const a = mk('Google 发布 Gemini 3 Pro', 'Google 发布 Gemini 3 Pro')
  const b = mk('NVIDIA 发布 Blackwell Ultra', 'NVIDIA 发布 Blackwell Ultra')
  const clusters = clusterClaims([a, b])
  assert.equal(clusters.length, 2, 'google/gemini 与 nvidia/blackwell 无共享 token → 2 簇')
  assert.deepEqual(clusters.map(cl => cl.items.length), [1, 1])
})

test('clusterClaims：单体声明自成一簇；空输入 → []', () => {
  const solo = clusterClaims([mk('DeepSeek 发布 V4 Pro', 'DeepSeek 发布 V4 Pro')])
  assert.equal(solo.length, 1)
  assert.equal(solo[0].items.length, 1)
  assert.deepEqual(clusterClaims([]), [], '空输入 → []')
  assert.deepEqual(clusterClaims(null), [], 'null 输入容错 → []')
})

test('clusterClaims：共享任一 token 即成对（半共享合并，传递闭包）', () => {
  // a 与 b 共享 nvidia；b 与 c 共享 openai → 三者并入同一簇（b 为桥梁）
  const a = mk('NVIDIA 发布新一代 AI 芯片', 'NVIDIA 发布新一代 AI 芯片')
  const b = mk('NVIDIA 与 OpenAI 联合声明', 'NVIDIA 与 OpenAI 联合声明')
  const c = mk('OpenAI 新模型将开放 API', 'OpenAI 新模型将开放 API')
  const clusters = clusterClaims([a, b, c])
  assert.equal(clusters.length, 1, '经 b 传递合并为 1 簇')
  assert.equal(clusters[0].items.length, 3)
})

test('tokenize：与 render-md 同款正则（长度≥4、STOP_TOKENS 过滤、中文不进 token）', () => {
  assert.deepEqual(clusterTokenize('NVIDIA 与 OpenAI'), ['nvidia', 'openai'], '长度≥4 拉丁/数字 token')
  assert.deepEqual(clusterTokenize('AI news update official'), [], 'STOP_TOKENS（ai/news/update/official）全过滤')
  assert.deepEqual(clusterTokenize('4.25GW 工厂'), ['4.25gw'], '数字+单位合一 token；中文不进')
  assert.deepEqual(clusterTokenize(''), [], '空串 → []')
})

test('mergeCluster：sources 去重、mergedCount 记数、claim 为合并 key、title/summary 保首条', () => {
  const a = mk('NVIDIA 与 OpenAI 共建 4.25GW AI 工厂', 'NVIDIA 与 OpenAI 共建 4.25GW AI 工厂', ['https://a.com/1'], { summary: '共建 4.25GW 工厂。', status: '已核查 2-0' })
  const b = mk('Nvidia 千亿美元加码 OpenAI 数据中心', 'Nvidia 千亿美元加码 OpenAI 数据中心', ['https://b.com/2'], { summary: '千亿加码数据中心。' })
  const c = mk('NVIDIA 新工厂将推动训练', 'NVIDIA 新工厂将推动训练', ['https://a.com/1', 'https://c.com/3'], { summary: '推动训练加速。' })
  const merged = mergeCluster([a, b, c])
  assert.equal(merged.mergedCount, 3, 'mergedCount = 簇内原始条数' )
  assert.equal(merged.title, a.title, 'title 保首条')
  assert.equal(merged.claim, 'NVIDIA 与 OpenAI 共建 4.25GW AI 工厂\nNvidia 千亿美元加码 OpenAI 数据中心\nNVIDIA 新工厂将推动训练', 'claim = distinct claim 顿排')
  assert.deepEqual(merged.sources, ['https://a.com/1', 'https://b.com/2', 'https://c.com/3'], 'sources 跨首条并入且去重')
  assert.equal(merged.status, '已核查 2-0', 'status 取首条')
  assert.ok(merged.summary.includes('共建 4.25GW 工厂。') && merged.summary.includes('千亿加码数据中心。') && merged.summary.includes('推动训练加速。'), 'summary = 各条摘要顿号拼接')
  assert.ok(!('numericConflict' in merged), '无数字冲突时不标 numericConflict')
})

test('mergeCluster：相同 claim 的冗条不放大 key（distinctByClaim 去重、后写胜）、sources 不放大，mergedCount 仍计全', () => {
  const a = mk('首条标题', '同一事件 claim', ['https://x.com/1'], { summary: '视角一。' })
  const b = mk('后条标题', '同一事件 claim', ['https://x.com/1'], { summary: '视角二。' })
  const merged = mergeCluster([a, b])
  assert.equal(merged.mergedCount, 2, 'mergedCount 计原始条数（含冗余）')
  assert.equal(merged.claim, '同一事件 claim', '重复 claim 在 key 只出现一次（distinctByClaim 去重）')
  assert.deepEqual(merged.sources, ['https://x.com/1'])
  // spec：distinct 按 claim 去重（后写胜）→ title/status/summary 取幸存者
  assert.equal(merged.title, b.title, 'distinctByClaim 后写胜：相同 claim 取末条')
  assert.ok(merged.summary.includes('视角二。'), '幸存条摘要为主')
})

test('mergeCluster：数字冲突启发式当前保守——detectNumericConflict 恒 false（全文层由 prompt 4.7 兜底）', () => {
  assert.equal(detectNumericConflict([]), false)
  assert.equal(detectNumericConflict([{ summary: '4.25GW' }, { summary: '$600B' }]), false, '跨 item 数字差异由 prompt 侧处置，模块不自动改数字')
  const m = mergeCluster([mk('A', 'A', ['https://a/1'], { summary: '口径一：4.25GW' }), mk('A', 'A', ['https://b/2'], { summary: '口径二：$600B' })])
  assert.ok(!m.numericConflict)
})

test('mergeCluster：空输入容错返回对象不崩', () => {
  const m = mergeCluster([])
  assert.equal(m.mergedCount, 0)
  assert.equal(m.claim, '', '空 claim 不崩')
  assert.deepEqual(m.sources, [])
})
