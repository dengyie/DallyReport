// ai-daily 墙钟标定 + 计数型断路器 — 8/31 P1 修复。
//
// 背景（8/31 生产 run wf_e14b2828-ff5 实证）：workflow realm 无 Date.now/performance，唯一时钟是
// `setTimeout(_tick, 250)` 自递归累加器 `_wallMs`——它计的是**tick 发生次数 × 250ms**，不是真实
// 经过时间。54 个代理 + 26 次 stall 把事件循环压满 → tick 被饿死 → 累加器**只会低估，永不高估**：
//   检查点        真实经过    累计死线   低估倍率
//   Fetch gate     6981s      1500s     ≥4.7×
//   Verify gate   11514s      1740s     ≥6.6×
//   synthAllowed  13604s      1800s     ≥7.6×
// 后果：4h13m 的 run 里零 BUDGET-SKIP/BUDGET-BREAK，30min 软目标形同不存在，AGENT_TIMEOUT_MS
// 一起失效（名义 360s 的 fetch 代理实跑 1926/1951/2914s）。
//
// 关键观察：**定时器本身是可信的真实时间证据**。setTimeout(ms) 不会早于 ms 真实毫秒触发；
// 事件循环饱和只让它**晚**触发。所以当一个名义 ms 的 withDeadline 真的超时了，我们就掌握了
// 「真实经过 ≥ ms」这一硬事实；把它与同窗口的累加器增量 d 相比，即得饥饿倍率 ms/d。
// 这让 realm 内**可以**推出真实墙钟的下界，30min 承诺重新变得可执行（不再只能靠宿主侧看门狗）。

// ── 饥饿倍率 ──
// realMs：已被定时器证实的真实经过下界；accumDeltaMs：同一窗口内累加器的增量。
// 累加器只会低估 → 倍率下界 = realMs / accumDeltaMs，且恒 ≥1（健康时 ≈1）。
// accumDeltaMs ≤ 0（tick 完全饿死）时无从取比值，返回 null 交调用方忽略该次观测。
export const starvationFactor = (realMs, accumDeltaMs) => {
  if (!(realMs > 0) || !(accumDeltaMs > 0)) return null
  return Math.max(1, realMs / accumDeltaMs)
}

/**
 * 标定墙钟：包住 raw 累加器，用定时器观测校正其低估。
 * @param {() => number} rawElapsed 原始累加器读数（workflow 里 RUN_ELAPSED）
 * @param {{maxFactor?:number}} opts maxFactor 封顶防单次异常观测把倍率放飞（默认 20）
 * @returns {{elapsed, observe, factor, peakFactor, observations}}
 *   elapsed()  校正后的经过毫秒，**单调不减**（时间绝不倒流，即便倍率回落）
 *   observe(realMs, accumDeltaMs) 记一次标定观测（withDeadline 超时 / 周期标定器各调一次）
 *   factor     最新观测倍率（网关恢复可回落）
 *   peakFactor 本 run 见过的最高倍率（旗标/审计用，回落不抹）
 */
export const makeCalibratedElapsed = (rawElapsed, opts) => {
  const maxFactor = (opts && typeof opts.maxFactor === 'number' && opts.maxFactor > 0) ? opts.maxFactor : 20
  let factor = 1
  let peakFactor = 1
  let floor = 0
  let observations = 0
  const elapsed = () => {
    const v = rawElapsed() * factor
    // 单调闸：倍率回落（网关恢复健康）时读数不得倒退，否则已越线的阶段会「复活」。
    if (v > floor) floor = v
    return floor
  }
  return {
    elapsed,
    observe: (realMs, accumDeltaMs) => {
      const f = starvationFactor(realMs, accumDeltaMs)
      if (f === null) return factor
      observations++
      // 取最新观测（受 maxFactor 封顶）：饱和缓解时倍率应当能回落，
      // 而 elapsed() 的单调闸已保证读数不倒退——两者配合既跟得上变化又不会时间倒流。
      factor = Math.min(maxFactor, f)
      if (factor > peakFactor) peakFactor = factor
      return factor
    },
    get factor() { return factor },
    get peakFactor() { return peakFactor },
    get observations() { return observations },
  }
}

/**
 * 计数型断路器：不依赖时钟，纯靠**失败/停滞计数**决定是否放弃后续昂贵阶段。
 * 8/31 实证 Harvest 烧 70min、Discover 再烧 129min，而此间失败信号早已密集出现——
 * 计数信号在饱和下依然准确（与墙钟不同，它不会被事件循环饿死），是最后一道可靠闸门。
 *
 * @param {{consecutive?:number, total?:number}} opts 跳闸阈值
 *   consecutive 连续失败数（默认 3）；total 累计失败数（默认 5）
 * @returns {{record, open, reason, stats}}
 *   record(ok, label) 记一次代理结果（ok=false 即失败/超时/null 产出）
 *   open() 是否已跳闸；reason() 跳闸原因串（未跳闸为 null）
 */
export const makeCircuitBreaker = opts => {
  // 0 是合法阈值（关闭该跳闸条件），不得用 `|| 3` 把 0 吞成默认。
  const maxConsecutive = (opts && typeof opts.consecutive === 'number') ? opts.consecutive : 3
  const maxTotal = (opts && typeof opts.total === 'number') ? opts.total : 5
  let consecutive = 0
  let failures = 0
  let successes = 0
  let reason = null
  return {
    record: (ok, label) => {
      if (ok) { successes++; consecutive = 0 } else {
        failures++; consecutive++
        if (!reason) {
          // ≤0 = 关闭该条件（consecutive:0 + total:0 → 断路器永不跳闸）。
          if (maxConsecutive > 0 && consecutive >= maxConsecutive) reason = 'consecutive_failures:' + consecutive + (label ? '@' + label : '')
          else if (maxTotal > 0 && failures >= maxTotal) reason = 'total_failures:' + failures + (label ? '@' + label : '')
        }
      }
      return !reason
    },
    open: () => !!reason,
    reason: () => reason,
    get stats() { return { failures, successes, consecutive } },
  }
}
