import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reportPrompt, fetchPrompt, externalVerifyPrompt } from '../prompts.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROMPTS = fs.readFileSync(path.join(HERE, '../prompts.mjs'), 'utf8')

// 2026-08-22 风格优化（spec C）：reportPrompt 增不确定度措辞要求——继续保留既有约束，仅增量加一条编辑要求。
// 源级测试固化：断言新要求在场，且既有约束（禁工具调用/头条优先序/新闻式标题≤25字）未被削弱。

test('reportPrompt：不确定度措辞要求在场（spec C 增量）', () => {
  assert.match(PROMPTS, /不确定度如实标注[\s\S]*有用户称/, '要求用「有用户称」等措辞')
  assert.match(PROMPTS, /暂不能确认/, '含「暂不能确认」示例措辞')
  assert.match(PROMPTS, /社区传闻与官方动态须用不同措辞区分/, '社区传闻与官方动态措辞区分')
})

test('reportPrompt：既有约束全保留（回归不削弱）', () => {
  assert.match(PROMPTS, /禁止调用任何工具/, '禁工具调用保留')
  assert.match(PROMPTS, /先筛选，再写稿/, '头条优先序保留')
  assert.match(PROMPTS, /≤25字/, '新闻式标题字数约束保留')
  assert.match(PROMPTS, /Structured output only/, '结构化输出保留')
})

// ─── 2026-08-22 三契约缺口修复（spec 2026-08-22-ai-daily-sources-and-uncertainty-design.md）───

test('discoverPrompt：majorOutOfWindow 鼓励带 url（B.3，9/19 收紧为「先搜后带」）', () => {
  assert.match(PROMPTS, /majorOutOfWindow[\s\S]{0,1400}url/, '§5 majorOutOfWindow 描述涉及 url 字段')
  assert.match(PROMPTS, /先花 1 次搜索\/快速确认找到它并\*\*写入 `url` 字段\*\*/, '「先花 1 次搜索…写入 url 字段」——url 从可选鼓励收紧为尽力必带')
  assert.match(PROMPTS, /确实无法溯源（纯行业共识、无任何官方页\/权威报道页）才省略 url/, '无法溯源才省略（旧版占位符 URL 根因治理）')
})

test('reportPrompt §4.5：未核查项措辞硬约束在场（C.1 增量）', () => {
  assert.match(PROMPTS, /status 为 `\[窗口外·重大\]` 或 `未核查`[\s\S]*禁止用/, '未核查项必须用不确定度措辞的硬约束文本')
  assert.match(PROMPTS, /（「据报」「有媒体称」「宣称」「待官方确认」「暂不能确认」之一）/, '必须候选措辞列全')
  assert.match(PROMPTS, /禁止用「已解决」「完成」「正式发布」「确认」等肯定完成态措辞/, '禁令完整列全')
  assert.match(PROMPTS, /有 vote 支撑，可正常陈述/, '已核查项不被迫弱化')
})

// ─── 2026-08-23 第二十一项：双轨聚类 prompt 纪律 ───

test('reportPrompt §4.7：聚类纪律在场（同一事件只写 ONE 条 + 口径不一并陈）', () => {
  assert.match(PROMPTS, /4\.7\..*聚类纪律/, '4.7 段标题在场')
  assert.match(PROMPTS, /\[cluster 已合并 N 条\]/, '已聚类素材打标识别')
  assert.match(PROMPTS, /只写 ONE 条标题正文，其他绝不重复/, '同一事件只写 ONE 条')
  assert.match(PROMPTS, /口径不一/, '口径不一并陈要求')
  assert.match(PROMPTS, /4\.25GW\/\$150-200B\/\$600B\/\$105B/, '并陈示例在场')
  // 双标准判据（实体 token / 日期同域 / 数字字段重叠）
  assert.match(PROMPTS, /共享 ≥1 个实体 token/, '判据①实体 token')
  assert.match(PROMPTS, /日期同域/, '判据②日期同域')
  assert.match(PROMPTS, /数字字段重叠（含数量级）/, '判据③数字字段重叠')
})

test('reportPrompt §3.2：同事件数字口径不一 → 直接并陈、不各自成条、提醒勿相加', () => {
  assert.match(PROMPTS, /3\.2\..*数字口径/, '3.2 数字口径段在场')
  assert.match(PROMPTS, /直接并陈不同口径、不各自成条、提醒勿相加/, '并陈不各自成条勿相加')
  assert.match(PROMPTS, /4\.25GW\/\$150-200B\/\$600B\/\$105B/, '口径示例在场')
})

// ─── 2026-08-27 修复：report 收口纪律 + fetch 禁止截图───

test('reportPrompt：StructuredOutput 收口约束在场（8/27 修复 report_failed 终版）', () => {
  assert.match(PROMPTS, /收口纪律（最终唯一出口）/, '收口纪律段落标题在场')
  assert.match(PROMPTS, /调用 StructuredOutput 工具/, '强制调 StructuredOutput 工具')
  assert.match(PROMPTS, /素材再少也要调用工具/, '空素材不能 end_turn 纯文本返回')
  assert.match(PROMPTS, /哪怕返回 oneLiner 一句话/, '空内容兜底调用示例')
})

test('fetchPrompt：禁止截图/图片输入（8/27 修复 linuxdo fetch 400）', () => {
  assert.match(PROMPTS, /禁止截图\/图片输入/, 'fetchPrompt 含禁止截图规则')
  assert.match(PROMPTS, /禁止使用 Playwright 截图/, '明确禁止 Playwright 截图')
  assert.match(PROMPTS, /Model only supports text input/, '引述模型限制（text-only）')
  assert.match(PROMPTS, /WebFetch 文本抓取/, 'WebFetch 文本抓取作为兜底方式仍在场')
})

// ─── 9/13 重构：fetch 走 9222 门控 + 索引页治理 + 已报道去重 ───

test('fetchPrompt：webFetchViaCdp=true → cdp-fetch 优先 + WebFetch 兜底；false → 纯 WebFetch（手动默认）', () => {
  const src = { url: 'https://a.example/x', title: 'T', board: 'labs', found_via: 'discover' }
  const on = fetchPrompt(src, { WINDOW_LABEL: 'W', webFetchViaCdp: true, CDP_FETCH_CLI: '/opt/cdp-fetch.mjs' })
  assert.match(on, /node \/opt\/cdp-fetch\.mjs 'https:\/\/a\.example\/x'/, 'Step1 = 宿主 cdp-fetch CLI（URL 原样）')
  assert.match(on, /ok:true.*不要[\s\S]*再 WebFetch/, 'ok:true 直接用 text，不再 WebFetch')
  assert.match(on, /改用 WebFetch 文本抓取兜底/, '失败回落 WebFetch 兜底')
  assert.ok(!/索引页纪律/.test(on), '非 static-fallback 来源不注入索引页指令')
  const off = fetchPrompt(src, { WINDOW_LABEL: 'W', webFetchViaCdp: false })
  assert.match(off, /1\. 用 WebFetch 抓取页面/, '门控关 = 既有行为（纯 WebFetch）')
  assert.ok(!/cdp-fetch/.test(off), '门控关时 prompt 不出现 cdp-fetch')
})

test('fetchPrompt：static-fallback 索引页 → 只做发现入口，claim.sourceUrl 必填真实文章 URL', () => {
  const src = { url: 'https://techcrunch.com/category/artificial-intelligence/', title: 'TechCrunch AI', board: 'strategy', found_via: 'static-fallback' }
  const p = fetchPrompt(src, { WINDOW_LABEL: 'W', webFetchViaCdp: true, CDP_FETCH_CLI: '/opt/cdp-fetch.mjs' })
  assert.match(p, /索引页纪律/, '索引页专用指令在场')
  assert.match(p, /真实文章链接/, '要求选中真实文章')
  assert.match(p, /sourceUrl.*必填/, 'claim.sourceUrl 必填真实文章 URL')
  assert.match(p, /不得拿索引页目录条目本身当 claim/, '禁止拿目录条目当 claim')
})

test('reportPrompt：已报道名单块 + 4.8 去重纪律（严格策略软网）', () => {
  const ctx = { ...reportCtx, reportedBlock: '\n## 已报道（近 3 天已出现在日报正文的条目，禁止重复成文）\n- [2026-09-05] 某事件' }
  const p = reportPrompt(ctx)
  assert.match(p, /## 已报道（近 3 天已出现在日报正文的条目，禁止重复成文）\n- \[2026-09-05\] 某事件/, '名单块原样注入')
  assert.match(p, /4\.8\.【已报道去重/, '4.8 纪律段落在场')
  assert.match(p, /一律不写正文条目/, '同事件换 URL 也不写正文')
  assert.match(p, /前情提要：/, '实质新增进展只写增量并标注前情提要')
  // 无名单（首跑/无账本）→ prompt 不含已报道名单块头（4.8 纪律文本提及「## 已报道」不算注入）
  const p2 = reportPrompt(reportCtx)
  assert.ok(!/## 已报道（近 3 天已出现在日报正文的条目，禁止重复成文）/.test(p2), '无 reportedBlock 时不注入名单块')
})

const reportCtx = {
  WINDOW_LABEL: '2026-08-23',
  confirmedVerifyCount: 0,
  majorOutCount: 0,
  reportBody: '素材',
  killedCount: 0,
  unverifiedCount: 0,
  refutedList: '',
  unverifiedList: '',
  missBlock: '',
  coverBlock: '自检',
}

test('reportPrompt title 分轨约束：按 status 分轨 + 禁止 + 肯定完成态关键词在场', () => {
  const s = reportPrompt(reportCtx)
  assert.match(s, /按 status 分轨/, '标题规则携带「按 status 分轨」约束')
  assert.match(s, /禁止/, '未确认项 title 有「禁止」强硬约束')
  assert.match(s, /肯定完成态/, '拒绝肯定完成态措辞')
})

test('reportPrompt title 分轨示例：未确认「某报」与已确认 LFM2.5 正反均在场', () => {
  const s = reportPrompt(reportCtx)
  assert.match(s, /据报/, '未核查示例措辞：以「据报」开头')
  assert.match(s, /LFM2\.5/, '已核查示例 LFM2.5 在场')
})

// ─── 9/19 F1 外部抽查票契约 ───
test('externalVerifyPrompt：必须外部搜索找独立证据 + 工具不可用约定 + 预算纪律', () => {
  assert.match(PROMPTS, /export const externalVerifyPrompt/, '外部抽查票 prompt 在场（9/19 F1）')
  const ctx = { WINDOW_LABEL: 'w', WTO: '2026-09-19', DATE: '2026-09-19' }
  const s = externalVerifyPrompt({ claim: 'C', sourceUrl: 'https://x/1', sourceQuality: 'forum', quote: 'q', publishDate: '2026-09-18' }, ctx)
  assert.match(s, /必须用外部搜索找独立证据/, '与内部票（禁外部搜索）对立的任务定义')
  assert.match(s, /至少一个独立来源/, '佐证判定标准')
  assert.match(s, /工具不可用，未完成独立佐证/, '工具不可用 → 约定返回 refuted=false + evidence 注明（编排层烘焙未核查）')
  assert.match(s, /最多 2 次搜索 \+ 1 次 WebFetch/, '外部票预算纪律')
  assert.match(s, /禁止截图/, '截图禁令保留')
})

test('reportPrompt §4：status 改为照抄素材行 Status（编排层烘焙，禁止自行推导）', () => {
  assert.match(PROMPTS, /status：核查状态，\*\*直接照抄素材行标注的 `Status:`\*\*/, 'status 烘焙契约（9/19 F5）')
  assert.match(PROMPTS, /禁止自行推导或改写/, '禁令在场')
})
