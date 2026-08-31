import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computePhaseDeadlines, makeBudgetGate } from '../budget.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TPL = fs.readFileSync(path.join(HERE, '../ai-daily.template.js'), 'utf8')

// 8/26 修复（Discover 慢代理不得拖垮 Fetch）回归测试。
// 根因（8/24/8/25 实证）：discover 单代理 timeout 上限 30/40min，慢批把墙钟拖过 Fetch 累计死线 →
// budgetGate('Fetch') 在 Fetch START 判定整段跳过（urls_fetched=0, budget_skipped:Fetch）。
// no-room 硬约束禁止把 room/elapsed 注入 timeoutMs——本修复只在批边界层加 WallClock 闸门。

test('guard: budgetGate.roomTo 存在且纯读（不记 skipped、不调 onSkip）', () => {
  let elapsed = 0
  const onSkipCalls = []
  const dl = computePhaseDeadlines({ harvest: 480000, discover: 540000, fetch: 480000, verify: 300000, verifyInflightBuffer: 60000, totalLimit: 1800000 })
  const gate = makeBudgetGate(dl, () => elapsed, (s) => onSkipCalls.push(s))
  elapsed = 1_400_000  // 距 Fetch 死线 1500000 剩 100s
  assert.equal(gate.roomTo('Fetch'), 100_000)
  assert.equal(gate('Fetch').ok, true)   // 未真正越线，不误记 skipped
  assert.deepEqual(gate.skipped, [])     // roomTo 不写记账
  assert.deepEqual(onSkipCalls, [])
  elapsed = 1_600_000  // 已越 Fetch 死线 → roomTo=0、gate ok=false 记一次
  assert.equal(gate.roomTo('Fetch'), 0)
  assert.equal(gate('Fetch').ok, false)
  assert.deepEqual(gate.skipped, ['Fetch'])
})

test('guard: 模板 Discover 批首含 roomTo(Fetch) 闸门，避免慢批吞掉 Fetch 窗口', () => {
  assert.match(TPL, /budgetGate\.roomTo\('Fetch'\)\s*<\s*DISCOVER_FETCH_RESERVE_MS/, 'Discover 批首须查剩给 Fetch 的墙钟余量')
  assert.match(TPL, /DISCOVER_FETCH_RESERVE_MS\s*=\s*\d+/, '保护窗口常量在场')
  assert.match(TPL, /BUDGET-BREAK Discover 距 Fetch 死线/, '触发时有可 grep 日志（区别于整段 BUDGET-SKIP Fetch）')
})

test('guard: 修复不触碰单一 timeoutMs——仍遵守 no-room 五固定上界（harvest 1800000 / discover labs?:1800000:2400000 / fetch AGENT_TIMEOUT_MS / verify=vtimeout / report SYNTHESIS_LIMIT_MS）', () => {
  // 8/26 修复的唯一抓手是批边界物质：timeoutMs 全部保持固定上界，不得因守卫改变。
  // 五条断言与 no-room-in-timeout 源级清单逐字一致，防本修复把 discover/fetch 上界悄悄收紧以「解」墙钟。
  // 9/01 方案 D：report 上界从魔法数 600000 提升为 SYNTHESIS_LIMIT_MS（默认仍 600s，不随 room 收紧）。
  const codeLines = TPL.split('\n').filter(l => !l.trim().startsWith('//'))
  assert.ok(codeLines.some(l => /timeoutMs:\s*1800000/.test(l)), 'harvest 上界 1800000 在场')
  assert.ok(codeLines.some(l => /timeoutMs:\s*g\.key === 'labs' \? 1800000 : 2400000/.test(l)), 'discover labs?:1800000:2400000 在场')
  assert.ok(codeLines.some(l => /timeoutMs:\s*AGENT_TIMEOUT_MS/.test(l)), 'fetch 上界=AGENT_TIMEOUT_MS 在场')
  assert.ok(codeLines.some(l => /timeoutMs:\s*SYNTHESIS_LIMIT_MS/.test(l)), 'report 上界=SYNTHESIS_LIMIT_MS 在场')
  const vline = codeLines.find(l => /vtimeout\s*=/.test(l))
  assert.ok(vline && /AGENT_TIMEOUT_MS/.test(vline), 'vtimeout 仍取 AGENT_TIMEOUT_MS')
})

test('guard: 行为仿真——slow discover 后 roomTo(Fetch) 变 0，但救护首批仍摄入已发现 URL', () => {
  // 直接驱动 budget.mjs 复刻 8/25 病灶：discover 末波重代理把墙钟推到 > Fetch 累计死线。
  // 断言：①守卫在余量低于 DISCOVER_FETCH_RESERVE_MS 时对后续批返回「不再放行」的可判据（roomTo 低）；
  //       ②即使到达 Fetch 死线，Fetch 首批仍在救护语义下被允许（FETCH-SALVAGE）。
  // 这里把墙钟推到底，验证 roomTo 数学 + 救护条件的主体，模板字面部分由上面的 grep 测试守。
  const dl = computePhaseDeadlines({ harvest: 540000, discover: 480000, fetch: 480000, verify: 300000, verifyInflightBuffer: 60000, totalLimit: 1800000 })
  let elapsed = 0
  const gate = makeBudgetGate(dl, () => elapsed)
  // Default args: Harvest 9, Discover 8 → Discover cumulative 17min, Fetch cumulative 25min.
  assert.equal(dl.Discover, 1_020_000)
  assert.equal(dl.Fetch, 1_500_000)
  // Batch 1 / Batch 2 start inside healthy window (elapsed 6min, 9min) → guard keeps fetch reserve > 8min
  elapsed = 360_000
  assert.equal(gate.roomTo('Fetch'), 1_500_000 - 360_000)           // healthy, no reserve pressure
  // slow media wave pushes elapsed past Fetch deadline (like 8/25: discover ate the fetch window)
  elapsed = 1_600_000
  // Guard: current batch must not start (would send discover again) — roomTo is 0
  assert.equal(gate.roomTo('Fetch'), 0)
  // Salvage: if we were already IN Fetch, FIRST batch still runs despite ok=false
  // (fetched.length===0 && targets>0 branch) — 关键非零摄入
  assert.ok(gate('Fetch').ok === false)
  // 同时带预算语义：跳过记账正常
  assert.deepEqual(gate.skipped, ['Fetch'])
})

test('guard: Fetch 救护首批——已过死线仍抓首批（非零摄入），其余批才 BREAK', () => {
  // 8.26 关键保证：即使已过 Fetch 死线（discover 末波慢批不可能再有批边界），FETCH-SALVAGE 首批也必须放行——
  // 这正是把「已 discover 结果摄入」从可能 0 撬到非 0 的实际杠杆。
  assert.match(TPL, /FETCH-SALVAGE/, '止血日志在场（fetch 救护首批）')
  // 需把救护与「整段跳过」区分清楚：救护 = 抓到 1 批、绝不标 budget_skipped:Fetch。
  assert.match(TPL, /const salvageFirst\s*=\s*extracted\.length === 0\s*&&\s*fetchTargets\.length > 0\s*&&\s*budgetGate\.roomTo\('Fetch'\)\s*===\s*0/, '救护判定在场（纯读 roomTo === 0，不记 skipped）')
  assert.match(TPL, /if \(!salvageFirst\)\s*\{/, '非救护路径再弹普通 budgetGate(Fetch)')
  assert.ok(TPL.includes("const gate = budgetGate('Fetch')"), '非救护路径调用 budgetGate(Fetch) 保留（真整段跳过才记）')
  assert.match(TPL, /BUDGET-BREAK Fetch 余批跳过，用已完成批次结果/, '普通 BREAK 语义保留（非救护越线即停）')
})

test('guard: 救护首批后余批整批 break，不再调用 budgetGate(Fetch) → budget_skipped:Fetch 不误标', () => {
  // 8/26 统筹复核修正：救护首批执行后，若下一轮又调 budgetGate('Fetch')，死线已过 → ok:false →
  // 先把 Fetch 记入 budgetSkipped 再 break —— meta 同时出现「抓了首批」+「budget_skipped:Fetch」自相矛盾。
  // 修正：salvaged 标记置位后，余批循环在顶部 if (salvaged) break 直接退出，期间绝不调用
  // 记 skipped 的 budgetGate('Fetch') → budgetSkipped 不含 Fetch → 降级旗标如实（非整段跳过）。
  assert.match(TPL, /let salvaged = false/, 'salvaged 标记在场')
  assert.match(TPL, /if \(salvaged\) break/, '救护后余批顶部整批 break（不碰 budgetGate(Fetch)）')
  assert.match(TPL, /if \(salvageFirst\) salvaged = true/, '救护首批抓完即置 salvaged，供下轮 break')
  // 救护判定只落在第一批（extracted.length===0）；SEAL 要求的「绝不把 Fetch 记 skipped」由上述 break 保证。
})