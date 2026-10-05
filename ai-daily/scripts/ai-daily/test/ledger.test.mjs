import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  LEDGER_OVERLAP_MIN, LEDGER_SHARE_MIN, LEDGER_LOOKBACK_DAYS, LEDGER_KEEP_DAYS,
  fingerprintTokens, makeLedgerEntry, storyMatch, filterReportedTargets, splitSeeds, pruneLedger,
  parseReportedLedger, buildYesterdayTopics,
} from '../ledger.mjs'
import { ledgerEntriesFromClaims, recordLedger, DEFAULT_LEDGER, PROD_DALLYREPORT_PREFIXES, isProdOutDir } from '../finalize.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ─── 指纹 ───
test('fingerprintTokens：ASCII+CJK 混合去重；CJK bigram 进指纹（旧版纯中文为空集的缺口修复）', () => {
  const t = fingerprintTokens('OpenAI 发布新模型 Astra，智能体多次联网')
  assert.ok(t.includes('openai') && t.includes('astra'), '拉丁实体进指纹')
  assert.ok(t.includes('模型') || t.includes('智能') || t.includes('联网'), '中文 bigram 进指纹')
  assert.equal(new Set(t).size, t.length, '去重')
  assert.deepEqual(fingerprintTokens(''), [], '空输入容错')
  assert.ok(fingerprintTokens('x'.repeat(500) + ' 谷歌发布Gemini').length <= 64, 'token 上限截断')
})

// ─── storyMatch ───
test('storyMatch：URL 归一命中（www/trailing-slash/大小写/utm query 差异）', () => {
  const entry = makeLedgerEntry('2026-09-05', 'https://www.huggingface.co/blog/train-to-paint-with-code/', '单卡 H200 复刻水彩作画 RL 配方', false)
  assert.ok(storyMatch({ url: 'HTTPS://huggingface.co/blog/train-to-paint-with-code?utm_source=x', tokens: [] }, entry), 'URL 归一等值（query 丢弃为既有 normURL 行为）')
})

test('storyMatch：同事件中文改写指纹命中（≥5 共享且 overlap≥0.8）；不同事件不命中', () => {
  const entry = makeLedgerEntry('2026-09-05', 'https://a.example/news/1', '谷歌发布 Gemini 3.8 Flash，六周内第三次 Flash 换代，HLE 多步推理 54.9%', false)
  const reworded = { url: 'https://other.example/gemini-38-flash', tokens: fingerprintTokens('谷歌推出 Gemini 3.8 Flash：六周内第三次迭代，HLE 多步推理拿下 54.9%') }
  const m = storyMatch(reworded, entry)
  assert.ok(m, '同事件换 URL/换表述 → 指纹命中')
  const different = { url: 'https://other.example/x', tokens: fingerprintTokens('IBM 开源百万参数时序模型 TTM，纯 CPU 每晚十万序列') }
  assert.ok(!storyMatch(different, entry), '异事件不命中')
  const few = { url: '', tokens: fingerprintTokens('谷歌发布新模型') }
  assert.ok(!storyMatch(few, entry), '共享 token 不足 LEDGER_SHARE_MIN 不命中（防误杀同名家族）')
})

test('storyMatch：空 token/空 URL 容错不崩', () => {
  assert.ok(!storyMatch(null, makeLedgerEntry('2026-09-05', '', 'x', false)))
  assert.ok(!storyMatch({ url: '', tokens: [] }, makeLedgerEntry('2026-09-05', '', 'x', false)))
})

test('storyMatch：短 name 的强实体 ASCII token 精确命中账本（discover major-out 无 note/换 URL）', () => {
  const entry = makeLedgerEntry('2026-09-03', 'https://blog.google/v4', '谷歌发布 Gemini V4-Flash-Vision-Exp 多模态理解', true)
  const shortName = { url: 'https://other.example/v4', tokens: fingerprintTokens('V4-Flash-Vision-Exp') }
  assert.ok(storyMatch(shortName, entry), '单一产品名 token 已在账本 → 跨天同事件（SHARE_MIN=5 打不满也要命中）')
  const weak = { url: 'https://other.example/g', tokens: fingerprintTokens('Gemini Flash 发布') }
  assert.ok(!storyMatch(weak, entry), 'gemini/flash 这类短通用词不得当强实体误杀')
  const otherProduct = { url: 'https://other.example/x', tokens: fingerprintTokens('Granite-4.2-Tiny') }
  assert.ok(!storyMatch(otherProduct, entry), '另一个带连字符的产品名不命中')
})

test('storyMatch：ISO 日期不得当强实体（日报/linux.do 标题常带 2026-09-13）', () => {
  const entry = makeLedgerEntry('2026-09-13', 'https://blog.google/gemini-38', '谷歌发布 Gemini 3.8 Flash，六周内第三次 Flash 换代 2026-09-13', false)
  const datedUnrelated = { url: 'https://ibm.example/ttm', tokens: fingerprintTokens('IBM 开源百万参数时序模型 TTM，纯 CPU 每晚十万序列 2026-09-13') }
  assert.ok(!storyMatch(datedUnrelated, entry), '两边只有 ISO 日期共享 → 不得判同事件')
  const githubDaily = { url: 'https://linux.do/t/2892428', tokens: fingerprintTokens('github日榜-2026-09-12') }
  const linuxdoDaily = makeLedgerEntry('2026-09-12', 'https://linux.do/t/2891978', 'linux.do人工智能技术日报+播客-26-09-12', false)
  assert.ok(!storyMatch(githubDaily, linuxdoDaily), 'github 日榜 vs linux.do 播客不得因日期撞车')
  const stillProduct = { url: 'https://other.example/v4', tokens: fingerprintTokens('V4-Flash-Vision-Exp') }
  const productEntry = makeLedgerEntry('2026-09-03', 'https://blog.google/v4', '谷歌发布 Gemini V4-Flash-Vision-Exp 多模态理解', true)
  assert.ok(storyMatch(stillProduct, productEntry), '真正的产品名强实体仍要命中')
})

test('storyMatch：09-20 实证——无连字符产品名 Fable/Astra 与 GPT-6 须命中已报道账本', () => {
  // 生产 09-20：账本有 51 条仍 fail-open；即便注入，storyMatch 也放跑 Fable（9/1）与 Astra（9/3）
  // ——URL 对不上「(多源公认)」、overlap < 0.8、fable/astra/gpt-6 都打不进「连字符≥8」强实体。
  const priorFable = makeLedgerEntry('2026-09-02', '(多源公认)', 'Fable 与 Mythos 发布 5.1 编程模型，Agent 能力跃迁', true)
  const againFable = { url: 'https://other.example/news', tokens: fingerprintTokens('Fable/Mythos 5.1 编程代理') }
  assert.ok(storyMatch(againFable, priorFable), 'fable/mythos 产品名跨天同事件必须命中（不得因无连字符漏放）')
  const priorAstra = makeLedgerEntry('2026-09-03', 'https://openai.com/news', 'OpenAI 预告 GPT-6 Astra 旗舰模型', true)
  const againAstra = { url: '(多源公认)', tokens: fingerprintTokens('GPT-6 Astra 旗舰模型') }
  assert.ok(storyMatch(againAstra, priorAstra), 'gpt-6 + astra 必须命中（短连字符+无连字符产品名）')
  const unrelated = { url: 'https://ibm.example/ttm', tokens: fingerprintTokens('IBM 开源时序模型 TTM') }
  assert.ok(!storyMatch(unrelated, priorFable), '无关事件不得因短词误杀')
})

test('parseReportedLedger：数组 / JSON 字符串均可；空/坏形态 → null（fail-open）', () => {
  const row = { day: '2026-09-19', url: 'https://x.example/a', tokens: ['fable'], title: 'Fable 5.1', major: true }
  assert.equal(parseReportedLedger([row])[0].day, '2026-09-19', '数组直通')
  assert.equal(parseReportedLedger(JSON.stringify([row]))[0].day, '2026-09-19', '宿主偶发把账本当 JSON 字符串注入也要吃进去')
  assert.equal(parseReportedLedger([]), null, '空数组 ≡ 不传')
  assert.equal(parseReportedLedger('[]'), null, '空 JSON 数组 ≡ 不传')
  assert.equal(parseReportedLedger('not-json'), null, '坏字符串不崩')
  assert.equal(parseReportedLedger(null), null)
  assert.equal(parseReportedLedger({ day: 'x' }), null, '非数组对象不崩')
})

test('parseReportedLedger：账本入口 isJunkClaim 卫生过滤（10-05 P2，历史毒条目不得渗入昨日话题追踪）', () => {
  // 10-04 生产账本真实毒条目原文（质量门上线前写入，10-05 经 buildYesterdayTopics 渲染进报告）
  const poison = { day: '2026-10-04', url: 'https://linux.do/t/2979428', tokens: ['image', '7.97'], title: 'image 580×286 7.97 KB', major: false }
  const good = { day: '2026-10-05', url: 'https://github.com/antirez/ds4', tokens: ['antirez', 'dwarfstar'], title: 'The antirez/ds4 README describes DwarfStar as a native inference engine', major: false }
  const out = parseReportedLedger([poison, good])
  assert.equal(out.length, 1, '毒条目在消费端入口被拦截')
  assert.equal(out[0].url, 'https://github.com/antirez/ds4')
  assert.equal(parseReportedLedger([poison]), null, '全被滤掉 → null（等价无账本，degraded 如实上报）')
  assert.equal(parseReportedLedger([{ day: '2026-10-04', url: 'https://x.example/e', tokens: ['abc'], title: '' }]).length, 1, 'title 缺失不判（fail-open，与本模块其余守卫一致）')
  assert.equal(parseReportedLedger([{ day: '2026-10-04', url: 'https://linux.do/t/2979429', tokens: ['image'], title: 'image 580x286 7.97 KB', major: false }]), null, 'ASCII x 变体同样拦截')
})

// ─── filterReportedTargets ───
test('filterReportedTargets：已报道 URL 硬丢弃并给 matchedDay；未报道保留；不改输入数组', () => {
  const ledger = [makeLedgerEntry('2026-09-04', 'https://x.example/a', 'OpenAI 发布 Astra 智能体被曝多次联网引发治理争议', false)]
  const targets = [
    { url: 'https://x.example/a', title: 'OpenAI Astra 联网争议', board: 'labs' },
    { url: 'https://y.example/b', title: '果蝇全脑连接图谱完成', board: 'academic' },
  ]
  const snapshot = JSON.stringify(targets)
  const { keep, dropped } = filterReportedTargets(targets, ledger, { today: '2026-09-05' })
  assert.equal(keep.length, 1)
  assert.equal(keep[0].url, 'https://y.example/b')
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].url, 'https://x.example/a')
  assert.equal(dropped[0].matchedDay, '2026-09-04')
  assert.equal(JSON.stringify(targets), snapshot, '输入数组不被修改')
})

test('filterReportedTargets：lookback 之外的旧条目不再拦（3 天窗口重叠语义）', () => {
  const ledger = [makeLedgerEntry('2026-08-20', 'https://x.example/old', '某事件 A 的报道内容，足够多特征词以构成指纹', false)]
  const { dropped } = filterReportedTargets([{ url: 'https://x.example/old', title: '某事件 A 的报道内容，足够多特征词以构成指纹' }], ledger, { today: '2026-09-05' })
  assert.equal(dropped.length, 0, '17 天前的已报道条目不再硬拦（URL 相同也放行——留给软网判断是否回顾）')
})

test('filterReportedTargets：短标题不够 SHARE_MIN 时，title+snippet 拼指纹仍能拦换 URL 同事件', () => {
  const ledger = [makeLedgerEntry('2026-09-04', 'https://blog.google/gemini-38', '谷歌发布 Gemini 3.8 Flash，六周内第三次 Flash 换代，HLE 多步推理 54.9%', false)]
  const shortOnly = { url: 'https://other.example/g38', title: 'Gemini 3.8 Flash 发布', board: 'labs' }
  const withSnippet = { ...shortOnly, snippet: '谷歌 Gemini 3.8 Flash 六周内第三次换代，HLE 多步推理 54.9%' }
  const r2 = filterReportedTargets([withSnippet], ledger, { today: '2026-09-05' })
  assert.equal(r2.dropped.length, 1, 'title+snippet 拼指纹命中换 URL（只看短标题会因 SHARE_MIN 漏放）')
  assert.equal(r2.dropped[0].url, 'https://other.example/g38')
  const diluted = { ...withSnippet, url: 'https://techcrunch.com/category/artificial-intelligence/foo-bar-baz-qux-extra-path' }
  const r3 = filterReportedTargets([diluted], ledger, { today: '2026-09-05' })
  assert.equal(r3.dropped.length, 1, 'URL 不得进指纹稀释 overlap——长无关 URL 仍应命中')
})

test('filterReportedTargets：无账本/坏账本 fail-open 全保留', () => {
  const t = [{ url: 'https://x.example/a', title: '标题甲乙丙丁' }]
  assert.equal(filterReportedTargets(t, null, { today: '2026-09-05' }).dropped.length, 0)
  assert.equal(filterReportedTargets(t, 'garbage', { today: '2026-09-05' }).dropped.length, 0)
  assert.equal(filterReportedTargets(t, [{ bad: true }], { today: '2026-09-05' }).dropped.length, 0)
  assert.equal(filterReportedTargets(null, [], {}).keep.length, 0, '空 targets 容错')
})

test('阈值常量在导出面上（供调参与文档对齐）', () => {
  assert.equal(LEDGER_OVERLAP_MIN, 0.8)
  assert.equal(LEDGER_SHARE_MIN, 5)
  assert.equal(LEDGER_LOOKBACK_DAYS, 3)
  assert.equal(LEDGER_KEEP_DAYS, 60)
})

// ─── splitSeeds（种子退役）───
test('splitSeeds：URL 命中的已报道种子退役并带 reportedDay；未报道保留', () => {
  const ledger = [makeLedgerEntry('2026-09-04', 'https://api-docs.deepseek.com/news/news260821', 'DeepSeek-V4-Flash-Vision-Exp 多模态实验模型上线，图片按 384 token 计费', true)]
  const seeds = [
    { name: 'DeepSeek-V4-Flash-Vision-Exp', date: '2026-08-21', note: '多模态实验模型上线', url: 'https://api-docs.deepseek.com/news/news260821' },
    { name: 'Anthropic Model Hardware Standard', date: '2026-08-27', note: '硬件标准研究预览', url: 'https://www.anthropic.com/news/model-hardware-standard-research-preview' },
  ]
  const { fresh, reported } = splitSeeds(seeds, ledger)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].name, 'Anthropic Model Hardware Standard')
  assert.equal(reported.length, 1)
  assert.equal(reported[0].name, 'DeepSeek-V4-Flash-Vision-Exp')
  assert.equal(reported[0].reportedDay, '2026-09-04')
})

test('splitSeeds：换 URL 的同事件种子按指纹退役；无账本 fail-open 全 fresh', () => {
  const ledger = [makeLedgerEntry('2026-09-03', 'https://qbitai.example/x', '据 DeepSeek 官方 news 页 V4-Flash-Vision-Exp 多模态实验模型文本侧对齐 V4-Flash 图片 token 化上限 384', true)]
  const seeds = [{ name: 'DeepSeek-V4-Flash-Vision-Exp 多模态实验模型上线', date: '2026-08-21', note: 'DeepSeek 官方 news 页 V4-Flash-Vision-Exp 多模态实验模型 文本侧对齐 V4-Flash 图片 token 化上限 384', url: 'https://api-docs.deepseek.com/news/news260821' }]
  const r1 = splitSeeds(seeds, ledger)
  assert.equal(r1.reported.length, 1, '同事件不同 URL → 指纹退役')
  assert.equal(splitSeeds(seeds, null).fresh.length, 1, '无账本 → 全保留')
})

// ─── pruneLedger ───
test('pruneLedger：超期剔除、day 不可解析剔除、today 缺失原样、keepDays 可覆盖', () => {
  const entries = [
    { day: '2026-09-01', url: 'https://a/1', tokens: ['a1'], title: 'x', major: false },
    { day: '2026-01-01', url: 'https://a/2', tokens: ['a2'], title: 'y', major: true },
    { day: 'bad-day', url: 'https://a/3', tokens: ['a3'], title: 'z', major: false },
  ]
  const pruned = pruneLedger(entries, '2026-09-05', 60)
  assert.equal(pruned.length, 1)
  assert.equal(pruned[0].day, '2026-09-01')
  assert.equal(pruneLedger(entries, null).length, 3, 'today 缺失原样返回')
  assert.equal(pruneLedger('garbage', '2026-09-05').length, 0, '非数组容错')
})

// ─── finalize 记账端 ───
const claimsPayload = JSON.stringify({
  date: '2026-09-06', window: '2026-09-04 ~ 2026-09-06',
  confirmed: [
    { claim: '谷歌发布 Gemini 3.8 Flash，六周内第三次换代', source: 'https://blog.google/gemini-38', window: 'in' },
    { claim: 'DeepSeek-V4-Flash-Vision-Exp 多模态实验模型上线', source: 'https://api-docs.deepseek.com/news/news260821', window: 'major-out' },
  ],
  refuted: [], unverified: [], outOfWindow: [],
})

test('ledgerEntriesFromClaims：confirmed 全记、major 按 window 标注、refuted/outOfWindow 不记', () => {
  const entries = ledgerEntriesFromClaims(claimsPayload, '2026-09-06')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].url, 'https://blog.google/gemini-38')
  assert.equal(entries[0].major, false)
  assert.equal(entries[1].major, true, 'major-out 条目标 major')
  assert.equal(entries[0].day, '2026-09-06')
  assert.ok(entries[0].title.length <= 80, 'title 截断 80')
})

test('recordLedger：追加去重、prune、原子写（tmp+rename）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'))
  const lp = path.join(dir, 'published-ledger.json')
  const first = [makeLedgerEntry('2026-09-05', 'https://a/1', '甲事件的第一条报道内容足够长以构成指纹', false)]
  const r1 = recordLedger(lp, first, '2026-09-05')
  assert.equal(r1.added, 1)
  assert.equal(r1.total, 1)
  assert.ok(fs.existsSync(lp))
  assert.ok(!fs.existsSync(lp + '.tmp'), 'tmp 已 rename 清掉')
  // 同日重跑（手工重 finalize）：同 URL 同指纹不重复入账
  const r2 = recordLedger(lp, first, '2026-09-05')
  assert.equal(r2.added, 0, '重复条目去重')
  // 次日新条目追加
  const r3 = recordLedger(lp, [makeLedgerEntry('2026-09-06', 'https://b/2', '乙事件的报道内容也足够长构成指纹', false)], '2026-09-06')
  assert.equal(r3.added, 1)
  assert.equal(r3.total, 2)
  const onDisk = JSON.parse(fs.readFileSync(lp, 'utf8'))
  assert.equal(onDisk.length, 2)
  assert.equal(onDisk[1].day, '2026-09-06')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('recordLedger：损坏账本文件 → 重建不崩', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'))
  const lp = path.join(dir, 'broken.json')
  fs.writeFileSync(lp, '{not json')
  const r = recordLedger(lp, [makeLedgerEntry('2026-09-06', 'https://c/3', '丙事件内容足够长构成指纹用途', false)], '2026-09-06')
  assert.equal(r.total, 1, '损坏账本重建')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ─── CLI 烟测隔离守卫 ───
const FIXTURE = {
  date: '2026-09-06',
  outDir: null,
  result: null,
}
const mkResult = outDir => ({
  date: '2026-09-06',
  outDir,
  payloads: { claims: claimsPayload, sources: '{"date":"2026-09-06","sources":[]}', meta: '{"date":"2026-09-06"}', md: '# t' },
})

test('CLI：/tmp 烟测 outDir 不带 --ledger → LEDGER-SKIP（不污染生产账本）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-smoke-'))
  const resultPath = path.join(dir, 'result.json')
  fs.writeFileSync(resultPath, JSON.stringify(mkResult(path.join(dir, 'out'))))
  const out = execFileSync(process.execPath, [path.join(HERE, '../finalize.mjs'), resultPath], { stdio: 'pipe' }).toString()
  assert.match(out, /LEDGER-SKIP/, '非生产 outDir 不记账')
  assert.ok(!fs.existsSync(DEFAULT_LEDGER) || !fs.readFileSync(DEFAULT_LEDGER, 'utf8').includes('2026-09-06'), '默认生产账本未被写入')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('CLI：--ledger 显式覆盖 → /tmp outDir 也记账', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-explicit-'))
  const lp = path.join(dir, 'ledger.json')
  const resultPath = path.join(dir, 'result.json')
  fs.writeFileSync(resultPath, JSON.stringify(mkResult(path.join(dir, 'out'))))
  const out = execFileSync(process.execPath, [path.join(HERE, '../finalize.mjs'), resultPath, '--ledger', lp], { stdio: 'pipe' }).toString()
  assert.match(out, /LEDGER-RECORDED/, '显式 --ledger 记账')
  assert.equal(JSON.parse(fs.readFileSync(lp, 'utf8')).length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('isProdOutDir：只认生产前缀，不在真实生产目录落盘', () => {
  const prefix = path.join(os.tmpdir(), 'fake-dallyreport-prefix')
  assert.equal(isProdOutDir(prefix, prefix), true)
  assert.equal(isProdOutDir(path.join(prefix, '2026-09-06'), prefix), true)
  assert.equal(isProdOutDir(path.join(os.tmpdir(), 'elsewhere'), prefix), false)
  assert.equal(isProdOutDir(path.join(os.tmpdir(), 'finalize-smoke-x')), false)
})

test('isProdOutDir（10-03 P0）：Windows vault 生产路径命中（旧版 Mac iCloud 单前缀恒 false → 生产 LEDGER-SKIP）', () => {
  assert.equal(isProdOutDir('E:/profile/note/note/AI/DallyReport/2026-10-03'), true, 'Windows 生产日期目录命中')
  assert.equal(isProdOutDir('E:\\profile\\note\\note\\AI\\DallyReport\\2026-10-03'), true, '反斜杠形态同样命中（path.resolve 归一）')
  assert.equal(isProdOutDir('E:/profile/note/note/AI/DallyReport'), true, '生产根目录命中')
  assert.equal(isProdOutDir('E:/profile/note/note/AI/DallyReport-other/x'), false, '同前缀异目录不误命中')
  assert.equal(isProdOutDir(PROD_DALLYREPORT_PREFIXES[1]), true, 'Mac iCloud 兜底前缀仍命中（历史对账）')
})

// ─── 10/03 对齐参考日报：昨日话题追踪（连续剧）───

test('buildYesterdayTopics：昨日条目 + 今日 confirmed URL 命中 → todayUpdate；无命中 → null', () => {
  const today = '2026-10-03'
  const e1 = makeLedgerEntry('2026-10-02', 'https://x.ai/news/grok-4-6', 'Grok 4.6 发布，聚焦长时 Agent 能力', true)
  const e2 = makeLedgerEntry('2026-10-02', 'https://example.org/other', '另一条昨日话题没有后续进展', false)
  const confirmed = [
    { sourceUrl: 'https://x.ai/news/grok-4-6', claim: 'Grok 4.6 追加评测成绩公布', quote: '' },
  ]
  const out = buildYesterdayTopics([e1, e2], confirmed, today)
  assert.equal(out.length, 2, '昨日两条都进追踪节')
  const t1 = out.find(t => t.url === 'https://x.ai/news/grok-4-6')
  const t2 = out.find(t => t.url === 'https://example.org/other')
  assert.equal(t1.todayUpdate, 'Grok 4.6 追加评测成绩公布', 'URL 命中 → 本次新增')
  assert.equal(t1.major, true, 'major 标记透传')
  assert.equal(t2.todayUpdate, null, '无后续话题 todayUpdate 为 null')
})

test('buildYesterdayTopics：同事件换 URL 走指纹路径命中（overlap≥0.8 且共享≥5）', () => {
  const today = '2026-10-03'
  const e1 = makeLedgerEntry('2026-10-02', 'https://a.example/day2', 'OpenClaw 2.0 开源发布 多 Agent 编排 长时任务 能力增强 社区评测', false)
  const confirmed = [
    { sourceUrl: 'https://b.example/followup', claim: 'OpenClaw 2.0 开源发布：多 Agent 编排、长时任务与工具链能力增强，社区评测成绩公布', quote: '' },
  ]
  const out = buildYesterdayTopics([e1], confirmed, today)
  assert.ok(out[0].todayUpdate, '同事件换 URL 的今日 confirmed 命中 → 本次新增：' + out[0].todayUpdate)
})

test('buildYesterdayTopics：只看 lookback（默认 2 天），更早条目不进追踪', () => {
  const today = '2026-10-03'
  const old = makeLedgerEntry('2026-09-28', 'https://example.org/old', '五天前的话题早已退役出窗', false)
  const out = buildYesterdayTopics([old], [], today)
  assert.equal(out.length, 0)
})

test('buildYesterdayTopics：连续剧 streak——连续多天同事件计数（URL 互认）', () => {
  const today = '2026-10-03'
  const e1 = makeLedgerEntry('2026-10-02', 'https://a.example/day2', 'Grok 4.6 长时 Agent 能力追踪第二天', false)
  const e0 = makeLedgerEntry('2026-10-01', 'https://a.example/day2', 'Grok 4.6 长时 Agent 能力首日报道', false)
  const out = buildYesterdayTopics([e1, e0], [], today)
  const t1 = out.find(t => t.day === '2026-10-02')
  assert.ok(t1, '昨日条目在场')
  assert.equal(t1.streak, 2, '昨日 + 前日连续同事件 → streak=2')
})

test('buildYesterdayTopics：空账本 / today 不可解析 → []（fail-open，不渲染空骨架）', () => {
  assert.deepEqual(buildYesterdayTopics([], [], '2026-10-03'), [])
  assert.deepEqual(buildYesterdayTopics([makeLedgerEntry('2026-10-02', 'https://x', '某条目内容', false)], [], 'garbage'), [])
})

// buildYesterdayTopics import（10/03 追踪节）

test('isProdOutDir（review S-⑤）：AI_DAILY_PROD_PREFIX 惰性读取——env 覆盖即时生效且不改导出数组', () => {
  const dir = path.join(os.tmpdir(), 'ai-daily-env-prefix-' + process.pid)
  // 子进程用 pathToFileURL 绝对 import（--test 运行器下子进程 cwd = test/，相对说明符落空；
  // pathToFileURL 自行处理 Windows 反斜杠，测试代码里不写反斜杠字面量——多层转义互搏的教训）
  const modPath = JSON.stringify(path.resolve(HERE, '../finalize.mjs'))
  const child = (code, withEnv) =>
    execFileSync(process.execPath, ['-e', code], {
      env: withEnv ? { ...process.env, AI_DAILY_PROD_PREFIX: dir } : { ...process.env },
      encoding: 'utf8',
    })
  const withEnv = JSON.parse(child(`
    import('node:url').then(({ pathToFileURL }) => import(pathToFileURL(${modPath}).href)).then(m => {
      console.log(JSON.stringify({
        hit: m.isProdOutDir(${JSON.stringify(dir + '/out')}),
        listUntouched: m.PROD_DALLYREPORT_PREFIXES[0] === 'E:/profile/note/note/AI/DallyReport',
      }))
    })
  `, true))
  assert.equal(withEnv.hit, true, 'env 前缀命中（import 后设置仍生效 = 惰性读取）')
  assert.equal(withEnv.listUntouched, true, '导出数组不被 env 突变')
  const withoutEnv = JSON.parse(child(`
    import('node:url').then(({ pathToFileURL }) => import(pathToFileURL(${modPath}).href)).then(m => {
      console.log(JSON.stringify({ hit: m.isProdOutDir(${JSON.stringify(dir + '/out')}) }))
    })
  `, false))
  assert.equal(withoutEnv.hit, false, '无 env 时同一路径不命中')
})
