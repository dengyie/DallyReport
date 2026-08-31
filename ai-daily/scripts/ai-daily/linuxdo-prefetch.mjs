// ai-daily linux.do Node prefetch 隔离层（Task 2，2026-08-27）。
//
// 定位：把「linux.do 登录态 CDP 抓取」从 Workflow realm 移到宿主 Node 进程（CLI 前置），
// 与既有 linuxdo.mjs 完全复用——本文件不复制任何 CDP 协议实现，只 re-export
// fetchLinuxDoNews34 并包一层 CLI 参数解析 + 可序列化成功 JSON 输出。
//
// 隔离收益：
//   - 「不启动 Chrome、不关闭用户 Chrome」：本脚本只对已运行在 127.0.0.1:9222 的现有 Chrome
//     发 CDP /json/new + /json/close（临时标签的开/关仍由 linuxdo.mjs readBodyText 的 finally
//     收敛负责）。脚本自身不 spawn 任何浏览器进程。
//   - 出错即非零退出 + stderr 诊断，绝不把错误文本当成功 JSON 写 stdout：
//     调用方（run-daily.sh）只认「exit 0 且 stdout 是合法 JSON」为成功。
//
// 注意：本文件不加入 build.mjs MODULES（不进 .claude/workflows/ai-daily.js），它只在宿主 Node
// 运行、不在 workflow realm 内——workflow realm 无 fetch/WebSocket/fs/process/require。

import { fetchLinuxDoNews34, CDP_DEFAULTS } from './linuxdo.mjs'

/** 默认 cdp host（与 linuxdo.mjs CDP_DEFAULTS.cdpHost 一致）。 */
export const DEFAULT_CDP_HOST = CDP_DEFAULTS.cdpHost

/** 默认 --max-sources 配额（与模板 LINUXDO_MAX_SOURCES 默认一致）。 */
export const DEFAULT_MAX_SOURCES = 24

/**
 * 解析 CLI 参数。未知参数/非法值 → throw（main 里 catch 后以非零退出）。
 * @param {string[]} argv e.g. process.argv.slice(2)
 * @returns {{ host: string, maxSources: number, help?: boolean }}
 */
export function parseArgs(argv) {
  const out = { host: DEFAULT_CDP_HOST, maxSources: DEFAULT_MAX_SOURCES }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--host') {
      if (i + 1 >= argv.length) throw new Error('--host 缺参数值')
      out.host = argv[i + 1]; i += 1
    } else if (a === '--max-sources') {
      if (i + 1 >= argv.length) throw new Error('--max-sources 缺参数值')
      const n = Number(argv[i + 1])
      if (!Number.isInteger(n) || n <= 0) throw new Error('--max-sources 必须为正整数')
      out.maxSources = n; i += 1
    } else if (a === '--help' || a === '-h') {
      out.help = true
    } else {
      throw new Error('未知参数 ' + a)
    }
  }
  return out
}

/**
 * 预抓 linux.do 前沿快讯并返回可序列化成功 JSON。
 * @param {{host?: string, maxSources?: number}} opts
 * @returns {Promise<{ok: true, topics: number, posts: Array}>} 可序列化成功目标。
 *   失败/抓取不成功 → throw（携带原 linuxdoResult），调用方负责 stderr 诊断 + 非零退出。
 */
export async function prefetchLinuxDo(opts = {}) {
  const host = opts.host || DEFAULT_CDP_HOST
  const maxSources = typeof opts.maxSources === 'number' && opts.maxSources > 0 ? opts.maxSources : DEFAULT_MAX_SOURCES
  // 复用 fetchLinuxDoNews34（CDP 抓取 + 全部协议逻辑），不复制 transport。
  const ld = await fetchLinuxDoNews34({ cdpHost: host })
  if (!ld.ok || !ld.posts || !ld.posts.length) {
    // 不把失败当成功 JSON 输出：抛错（携带原因），CLI 层打印 stderr。
    const e = new Error('linuxdo-prefetch 未成功: ' + (ld.reason || 'empty_posts'))
    e.linuxdoResult = ld
    throw e
  }
  // 可序列化成功形状：posts（配额截断）+ 元信息，供 Workflow linuxdoPrefetched 消费。
  return {
    ok: true,
    host,
    topics: ld.topics || 0,
    posts: (ld.posts || []).slice(0, maxSources).map(p => ({
      id: p.id, title: p.title, url: p.url, date: p.date || '', snippet: p.snippet || '', likeCount: p.likeCount || 0,
    })),
  }
}

/** 执行预抓并把成功结果序列化为 JSON 文本。失败 → throw。 */
export async function runPrefetch(opts = {}) {
  const result = await prefetchLinuxDo(opts)
  return { ok: true, output: JSON.stringify(result, null, 1) }
}

/** Node CLI 入口：成功 → stdout 打印 JSON；失败 → stderr 诊断 + 非零退出。绝不把错误文本当成功 JSON。 */
export async function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (e) {
    process.stderr.write('linuxdo-prefetch: 参数错误: ' + e.message + '\n')
    process.exit(1)
  }
  if (parsed.help) {
    process.stdout.write('linuxdo-prefetch: 从 9222 登录态 Chrome 预抓 linux.do 前沿快讯。\n用法: node linuxdo-prefetch.mjs [--host 127.0.0.1:9222] [--max-sources 24]\n')
    return
  }
  try {
    const { output } = await runPrefetch({ host: parsed.host, maxSources: parsed.maxSources })
    process.stdout.write(output)
  } catch (e) {
    const diag = (e && e.linuxdoResult && e.linuxdoResult.reason) ? e.linuxdoResult.reason : (e && e.message || e)
    process.stderr.write('linuxdo-prefetch: 失败: ' + String(diag).slice(0, 200) + '\n')
    process.exit(1)
  }
}

// 仅在作为脚本直接执行时运行 main（被 import 时不跑，测试可 import 接口）。
const isMain = process.argv[1] && import.meta.url === 'file://' + process.argv[1]
if (isMain) { main(process.argv.slice(2)) }