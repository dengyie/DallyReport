// ai-daily 阶段墙钟预算 — 第十四项语义的可测试化。
// 切片(BUDGET_MS)是用户输入、累计死线(PHASE_DEADLINES)是内部状态，混用即 bug（见 memory ai-daily-budget-deadline-semantics）。

// 累计死线：各阶段切片相加；Verify 在切片和后另减 verifyInflightBuffer（为最后一批在飞票固定 AGENT_TIMEOUT_MS 留空间），
// 墙钟仅为软目标——极端尾批可超 totalLimit 约 300s，由 synthAllowed 绝对闸门 + render-md 降级兜底。
export const computePhaseDeadlines = ({ harvest, discover, fetch, verify, verifyInflightBuffer, totalLimit }) => ({
  Harvest: harvest,
  Discover: harvest + discover,
  Fetch: harvest + discover + fetch,
  Verify: harvest + discover + fetch + verify - verifyInflightBuffer,
  Synthesize: totalLimit,
})

// 工厂：elapsedFn 注入时钟（workflow 里 _wallMs 累加器，测试里 mock）——realm 时钟限制的正确解耦点。
// onSkip(stage) 回调用于 budgetSkipped 记账 + log；同一 stage 越线只记一次（由调用方 includes 判断，见 workflow）。
export const makeBudgetGate = (deadlines, elapsedFn, onSkip) => {
  const skipped = []
  const budgetGate = stage => {
    const e = elapsedFn()
    const dl = deadlines[stage]
    const ok = e <= dl
    if (!ok && !skipped.includes(stage)) { skipped.push(stage); if (onSkip) onSkip(stage, e, dl) }
    return { ok, roomMs: Math.max(0, dl - e) }
  }
  budgetGate.skipped = skipped  // 暴露记账数组供 degraded 标记读取（对应现行 budgetSkipped）
  return budgetGate
}
