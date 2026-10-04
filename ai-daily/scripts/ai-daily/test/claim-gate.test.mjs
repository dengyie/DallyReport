import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isJunkClaim, needsVerification, gateClaims } from '../claim-gate.mjs'

// 10-04 日报质量审计回归（docs/2026-10-04-claim-quality-gate-design.md §1.1）：
// 论坛附件标注被提取为可证伪声明 → "image 580×286 7.97 KB" 通过 2-0 核查投票 → 写入生产账本，
// 并把 Antigravity Opus 5.5 发布（两帖印证）挤出正文。本组 fixture 逐字取自当日
// verified-claims.json 的 unverified 数组——垃圾原文一字不改，作为回归金标准。

const JUNK_10_04 = [
  'image 580×286 7.97 KB',
  '如图： image 487×438 13.4 KB 不用忍受被封号，KYC了，直接200刀ultra',
  'https://www.nytimes.com/2026/09/29/us/anthropic-claude-morals-ai.html The Times',
]

test('isJunkClaim：10-04 实证垃圾原文逐条拦截（回归金标准）', () => {
  for (const t of JUNK_10_04) assert.equal(isJunkClaim({ claim: t }), true, JSON.stringify(t))
})

test('isJunkClaim：ASCII x 尺寸分隔符变体同样拦截（10-04 复审 Suggestion-3）', () => {
  assert.equal(isJunkClaim({ claim: 'image 580x286 7.97 KB' }), true, '提取器产出 ASCII x 不漏')
  assert.equal(isJunkClaim({ claim: '如图： image 487x438 13.4 KB 不用忍受被封号' }), true, '内嵌变体')
})

test('isJunkClaim：模式表边界（附件标注变体 / 过短 / 纯 URL）', () => {
  assert.equal(isJunkClaim({ claim: 'image 487×438' }), true, '附件标注无大小后缀仍拦')
  assert.equal(isJunkClaim({ claim: '13.4 KB' }), true, '纯大小串')
  assert.equal(isJunkClaim({ claim: '涨停了' }), true, '<8 字符不可证伪')
  assert.equal(isJunkClaim({ claim: 'https://linux.do/t/2979428' }), true, '纯 URL')
  assert.equal(isJunkClaim({ claim: null }), true, '非字符串防御')
})

test('isJunkClaim：真实声明不误杀（反例锁死）', () => {
  const REAL = [
    'Gboard 已用基于 TEE 的联邦学习系统训练英语与日语下一词预测模型',            // 10-04 官方一手
    '微软把 Rust 提为一级语言',                                                 // 10-04 被挤出的真头条
    '谷歌宣布自 2026 年 10 月起调整 Gemini 用量限额，未订阅用户 10 月 9 日生效', // 数字 + 专名
    'OpenAI 发布 o6',                                                          // 短但有拉丁实体
    '如图 3 所示，营收增长 30%',                                                // 「如图」收窄模式防误杀（设计 §5）
    'https://research.google/blog/toward-provably-private-learning-from-federated-data/ 提出 TEE 联邦学习系统', // URL 开头但剩余文字 ≥12
  ]
  for (const t of REAL) assert.equal(isJunkClaim({ claim: t }), false, JSON.stringify(t))
})

test('isJunkClaim：残余语义噪声如实不拦（设计 §5 覆盖边界——靠 prompt 层减少；注意 CJK≥10 碎片仍可过 substance 门到达 verify，测试如实锁定边界不夸大）', () => {
  const RESIDUAL = [
    '这个参数和模型的数据知识量有关',                                                          // 无主语评论碎片
    '虽然技术报告都看过，但是看到切开来的电镜图还是有点起鸡皮疹药 哔哩哔哩 逻辑折叠深度解析', // 评论转述
  ]
  for (const t of RESIDUAL) assert.equal(isJunkClaim({ claim: t }), false, '机械模式不判语义——诚实锁定覆盖边界')
})

test('needsVerification：无实质内容不烧核查票（三分支与边界）', () => {
  assert.equal(needsVerification({ claim: '纯中文碎片句子测试' }), false, '9 CJK 无数字无拉丁 → 不核')
  assert.equal(needsVerification({ claim: '纯中文碎片句子测试十条' }), true, '10 CJK 成句 → 核')
  assert.equal(needsVerification({ claim: '版本 2.0 发布' }), true, '含数字')
  assert.equal(needsVerification({ claim: 'Rust 一级语言' }), true, '含拉丁实体')
  assert.equal(needsVerification({ claim: '' }), false, '空串防御')
  // 10-04 实证：垃圾附件标注即使漏过 isJunkClaim 也必须被 substance 门拦在 verify 外
  assert.equal(needsVerification({ claim: 'image 580×286' }), true, '含数字——由 isJunkClaim 前置拦截，双门互补')
})

test('gateClaims：分账不丢不改写（对象引用原样透传）', () => {
  const junk = { claim: 'image 580×286 7.97 KB', sourceUrl: 'https://linux.do/t/2979428' }
  const real = { claim: '微软把 Rust 提为一级语言', sourceUrl: 'https://linux.do/t/2977263', importance: 'central' }
  const { clean, dropped } = gateClaims([junk, real])
  assert.deepEqual(dropped, [junk], '垃圾入 dropped')
  assert.deepEqual(clean, [real], '真声明入 clean')
  assert.equal(clean[0], real, '引用透传（不改写不复制）')
  assert.equal(gateClaims(null).dropped.length, 0, 'null 防御')
  assert.equal(gateClaims([]).clean.length, 0, '空批防御')
})
