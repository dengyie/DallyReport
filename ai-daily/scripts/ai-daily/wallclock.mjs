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
 * 周期标定链（10-03 §12-③ 根因版）——治「健康跑零观测、饱和跑无证据」的观测盲区。
 *
 * 仪器原理：setTimeout(nominal) 绝不早于真实 nominal 毫秒触发 → 触发即证明「真实经过 ≥ nominal」，
 * 与同窗 tick 累加器增量相比即饥饿倍率（starvationFactor）。
 *
 * 根因约束（250ms 首版 review 实证教训）：**nominal 必须远大于 tick 粒度**——delta 恒为 tick 粒度
 * 的整数倍，nominal == 粒度时 factor 的可达值域只有 {1, null}（delta≥nominal → 1；delta=0 → null），
 * 仪器退化为 no-op。默认 120s = 480 拍：健康跑 fire 时 delta=120000 → factor=1（零影响）；
 * 全饱和跑 fire 晚到、delta 停在解除批次的首拍 250 → factor=480 → maxFactor 封顶。
 *
 * 链式语义：**窗口首尾相接**（fire 即续排下一窗）——观测无缝隙，饱和无论落在哪段墙钟，
 * 都会被随后（晚触发的）fire 按窗口占比如实捕获。
 *
 * @param {{windowMs?:number, observe:(realMs:number, accumDeltaMs:number)=>number|null,
 *          readAccum:()=>number, log?:(s:string)=>void,
 *          setTimer?:(fn:()=>void, ms:number)=>unknown}} deps
 *   observe 一般直接传 WALL.observe（闭包方法，无 this 依赖）；readAccum 读 tick 累加器；
 *   setTimer 供测试注入假时钟（默认 setTimeout）。
 * @returns {{start:()=>void}} start() 启动标定链；幂等（重复 start 不叠加链）。
 */
export const makeWallCalibrator = ({ windowMs, observe, readAccum, log, setTimer }) => {
  // 0 是合法值 = 显式禁用（start 的 !(win>0) 守卫承接）；缺省 = 默认窗长；非法类型 fail-fast 不静默回落
  // （首版把 0 吞进默认分支 → args.wallCalibrateMs=0 关不掉仪器，行为级测试实证后修复）。
  let win = 120000
  if (windowMs !== undefined) {
    if (typeof windowMs !== 'number' || !(windowMs >= 0)) throw new TypeError('makeWallCalibrator: windowMs must be a non-negative number (ms), got: ' + JSON.stringify(windowMs))
    win = windowMs
  }
  const _setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms))
  let running = false
  // P3（10-03 review 根因）：旧版 `once().then(chain)` 对 rejection 零兜底——
  //   ① observe/readAccum 抛错（如标定仪器自身 bug）→ 链 reject → 未处理 rejection，且标定永久停摆不可见；
  //   ② 定时器回调内抛错（observe 同步抛）会被 setTimeout 当作宿主未捕获异常抛出，resolve 永不调用 →
  //      Promise 永久挂起（链静默死掉，日志无痕）。
  // 修复：定时器回调体 try/catch（异常→ resolve(null)，不挂起）+ 链尾 .catch（异常→ 一行日志 + 停链，
  // 绝不无限空转）。标定是尽力而为的仪器，故障只允许降级、不允许拖垮 run 或静默消失。
  const once = () => new Promise(resolve => {
    const t0 = readAccum()
    _setTimer(() => {
      let f = null
      try {
        const delta = readAccum() - t0
        f = observe(win, delta)
        if (f && f > 1 && typeof log === 'function') {
          log('[墙钟标定·周期] ' + Math.round(win / 1000) + 's 标定窗累加器仅计 ' + Math.round(delta / 1000) + 's → 饥饿倍率 ' + f.toFixed(2) + '×')
        }
      } catch (e) {
        if (typeof log === 'function') log('[墙钟标定] 标定窗异常，本窗跳过: ' + String(e && e.message || e).slice(0, 120))
      }
      resolve(f)
    }, win)
  })
  const chain = () => once().then(chain).catch(e => {
    if (typeof log === 'function') log('[墙钟标定] 标定链异常终止（不再续排）: ' + String(e && e.message || e).slice(0, 120))
    running = false
  })
  return {
    start: () => {
      if (running || !(win > 0)) return
      running = true
      chain()
    },
  }
}

/**
 * 计数型断路器：不依赖时钟，纯靠**失败/停滞计数**决定是否放弃后续昂贵阶段。
 * 8/31 实证 Harvest 烧 70min、Discover 再烧 129min，而此间失败信号早已密集出现——
 * 计数信号在饱和下依然准确（与墙钟不同，它不会被事件循环饿死），是最后一道可靠闸门。
 *
 * @param {{consecutive?:number, total?:number}} opts 跳闸阈值
 *   consecutive 连续失败数（默认 3）；total 累计失败数（默认 5）
 * @returns {{record, open, reason, stats, resetConsecutive}}
 *   record(ok, label) 记一次代理结果（ok=false 即失败/超时/null 产出）
 *   open() 是否已跳闸；reason() 跳闸原因串（未跳闸为 null）
 *   resetConsecutive() 清连续计数，不清 failures/successes/reason（阶段隔离；已跳闸仍 open）
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
    resetConsecutive: () => { consecutive = 0 },
    get stats() { return { failures, successes, consecutive } },
  }
}
