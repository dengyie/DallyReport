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

test('tokenize：ASCII ≥4/停用词过滤（既有契约）+ CJK bigram（9/13 中文聚类升级）', () => {
  assert.deepEqual(clusterTokenize('NVIDIA 与 OpenAI'), ['nvidia', 'openai'], '长度≥4 拉丁/数字 token（「与」单字不成 bigram）')
  assert.deepEqual(clusterTokenize('AI news update official'), [], 'STOP_TOKENS（ai/news/update/official）全过滤')
  assert.deepEqual(clusterTokenize('4.25GW 工厂'), ['4.25gw', '工厂'], '数字+单位合一 token；中文进 bigram（9/13 起）')
  assert.deepEqual(clusterTokenize(''), [], '空串 → []')
  // CJK bigram 停用：虚字单字（的/了/在…）与新闻套话（发布/推出/消息…）不进 token
  assert.deepEqual(clusterTokenize('的了吗'), [], '纯虚字串全停用')
  assert.deepEqual(clusterTokenize('发布新的消息'), ['布新'], '套话/虚字 bigram 停用，仅残余真实搭配')
  // 9/19 ④：高频四字术语的内部 bigram 全表停用——单个四字词不再凑满任何阈值（误合最大噪声源）
  assert.deepEqual(clusterTokenize('人工智能'), [], '四字术语（人工智能）内部 bigram 全停用')
  assert.deepEqual(clusterTokenize('机器学习与数据中心'), [], '机器学习/数据中心内部 bigram 全停用')
  // 同一实体中文串产出稳定 bigram（按相邻对插入序，确定性）；9/19 起尾字属通用词表的 bigram 被停用
  assert.deepEqual(clusterTokenize('星尘智能'), ['星尘', '尘智'], '两字名拆相邻对；「智能」入 9/19 停用表')
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

// ─── 9/19 P1 误合修复契约：CJK 阈值 4 + 四字术语停用 + 簇上限 + status 仲裁 ───

test('clusterClaims：无关中文条目各含一个四字术语不再并簇（9/19 实证误合根因）', () => {
  // 旧版：各含「人工智能」即凑满 3 bigram → 误合。9/19：内部 bigram 全停用 → 无共享 token。
  const a = mk('OpenAI 发布新模型', 'OpenAI 发布新一代人工智能模型')
  const b = mk('国内智算中心项目开工', '某地人工智能数据中心项目开工')
  const clusters = clusterClaims([a, b])
  assert.equal(clusters.length, 2, '共享的只有四字术语 bigram（已停用）→ 2 簇')
})

test('clusterClaims：CJK 同事件改写 ≥4 共享 bigram 仍聚簇（升级不丢能力）', () => {
  const a = mk('智谱清言 X 发布', '智谱清言 X 正式发布：智能体能力全面升级')
  const b = mk('智谱清言 X 上线', '智谱推出清言 X：智能体功能大幅增强')
  const clusters = clusterClaims([a, b])
  assert.equal(clusters.length, 1, '共享 智谱/清言/智能体/功能 等实体 bigram ≥4 → 一簇')
})

test('clusterClaims：簇大小上限 4——桥接 token 传递闭包不再串 5+ 条', () => {
  const mkA = n => mk('公司 X 新闻 ' + n, 'acmecorp 相关动态 ' + n)
  const items = [1, 2, 3, 4, 5].map(mkA)
  const clusters = clusterClaims(items)
  const big = clusters.filter(cl => cl.items.length > 1)
  assert.ok(big.every(cl => cl.items.length <= 4), '任一簇不得超 4 条（实得 ' + big.map(cl => cl.items.length) + '）')
  assert.equal(clusters.reduce((n, cl) => n + cl.items.length, 0), 5, '条数守恒（不丢条目）')
})

test('mergeCluster：status 仲裁取「最已核查」——首条未核查不再覆盖已核查', () => {
  const a = mk('T1', '同事件', ['https://a/1'], { status: '[窗口外·重大]' })
  const b = mk('T2', '同事件 B', ['https://b/2'], { status: '已核查 2-0' })
  const merged = mergeCluster([a, b])
  assert.equal(merged.status, '已核查 2-0', '已核查项不被首条的 [窗口外·重大] 拖成未核查')
  const c = mk('T3', '同事件 C', ['https://c/3'], { status: '已核查 2-1' })
  const d = mk('T4', '同事件 D', ['https://d/4'], { status: '已核查 2-0' })
  assert.equal(mergeCluster([c, d]).status, '已核查 2-0', '已核查内部取支持票最强')
  assert.equal(mergeCluster([mk('E', 'E1', null, { status: '未核查' }), mk('F', 'F1')]).status, '未核查', '无已核查项时取首条非空')
})
