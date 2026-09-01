// ai-daily 模型阶梯降级 — 2026-09-02。
//
// 背景（9/01 生产 run 实证）：17 次 Cloudflare 524 打掉 report 两试 → raw archive，
// 连带 3 张 verify 票。网关故障不在代码范围；本模块给 report + verify 一条
// TRANSIENT-only 的四级换模通道，中间失败不计入断路器（调用方只在终局记账）。
//
// 语义：
//   - 仅 TRANSIENT（524/5xx/429/timeout/gateway/…）换级；schema/end_turn 等行为问题同级消化。
//   - null（withDeadline 超时）也换级——这是相对 safeAgent 的唯一偏离，524 超时正是要救的场景。
//   - budgetMs<=0 关闭预算检查；正预算先跑当前级，失败后再看是否还够爬下一级。
//   - 工厂不碰断路器：中间失败不得自吃 4 次计数把 total=5 吹断。
//
// 时钟只能用注入的 now（workflow realm 无 Date.now/performance）。

export const DEFAULT_LADDER = ['deepseek-v4-flash', 'grok-4.6', 'claude-opus-4-8', 'gemini-3.7-flash-high']
export const DEFAULT_LADDER_BUDGET_MS = 900000

/**
 * 模型阶梯降级包装：TRANSIENT / null 逐级换模型，终局才返回 null。
 * @param {{agent, withDeadline, now, log, TRANSIENT, AGENT_TIMEOUT_MS, onRecovered?, onExhausted?}} deps
 * @returns {(prompt:string, opts:object, ladder:string[], budgetMs:number) => Promise<object|null>}
 */
export const makeSafeAgentWithLadder = (deps) => {
  const {
    agent, withDeadline, now, log, TRANSIENT, AGENT_TIMEOUT_MS,
    onRecovered, onExhausted,
  } = deps
  const fail = (label) => {
    if (typeof onExhausted === 'function') onExhausted(label)
    return null
  }
  return async (prompt, opts, ladder, budgetMs) => {
    const label = (opts && opts.label) || '?'
    const list = Array.isArray(ladder) ? ladder : []
    if (!list.length) {
      log('LADDER-FAIL ' + label + ' (empty ladder)')
      return fail(label)
    }
    const t0 = now()
    const timeoutMs = (opts && opts.timeoutMs) || AGENT_TIMEOUT_MS
    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      let r = null
      try {
        r = await withDeadline(agent(prompt, { ...opts, model: m }), timeoutMs)
      } catch (e) {
        const msg = String(((e && (e.message || e.error)) || e) || '')
        const isTrans = TRANSIENT.test(msg)
        const hasNext = i < list.length - 1
        const elapsed = now() - t0
        const budgetOk = !(budgetMs > 0 && elapsed >= budgetMs)
        if (!isTrans) {
          log('LADDER-FAIL ' + label + ' at ' + m + ': ' + msg.slice(0, 120))
          return fail(label)
        }
        if (!hasNext) {
          log('LADDER-FAIL ' + label + ' at ' + m + ': ' + msg.slice(0, 120))
          return fail(label)
        }
        if (!budgetOk) {
          log('LADDER-BUDGET ' + label + ' 阶梯已用 ' + Math.round(elapsed / 1000) + 's ≥ 预算 ' + Math.round(budgetMs / 1000) + 's，停在 ' + m)
          return fail(label)
        }
        log('LADDER-NEXT ' + label + ' ' + m + ' → ' + list[i + 1] + ': ' + msg.slice(0, 100))
        continue
      }
      if (r) {
        if (i > 0) {
          log('LADDER-OK ' + label + ' recovered at ' + m)
          if (typeof onRecovered === 'function') onRecovered(label, m)
        }
        return r
      }
      const hasNext = i < list.length - 1
      const elapsed = now() - t0
      const budgetOk = !(budgetMs > 0 && elapsed >= budgetMs)
      if (!hasNext) {
        log('LADDER-FAIL ' + label + ' (null at ' + m + ')')
        return fail(label)
      }
      if (!budgetOk) {
        log('LADDER-BUDGET ' + label + ' 阶梯已用 ' + Math.round(elapsed / 1000) + 's ≥ 预算 ' + Math.round(budgetMs / 1000) + 's，停在 ' + m)
        return fail(label)
      }
      log('LADDER-NEXT ' + label + ' ' + m + ' → ' + list[i + 1] + ' (null)')
    }
    log('LADDER-FAIL ' + label + ' (exhausted)')
    return fail(label)
  }
}
