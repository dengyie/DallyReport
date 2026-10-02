// 2026-09-28 weekly DRY RUN — collector layer only.
//
// Deliberately narrow: it loads the real config (so the .env-derived values
// and the weekly capacity defaults are the ones that would ship), then calls
// the hard-source + forum collectors and prints what survived the window. It
// does NOT call runSearch (LLM/gateway spend), does NOT generate posters, and
// does NOT write to the vault.
//
// Run:  node scripts/dry-run-weekly.mjs [--date YYYY-MM-DD]
import { loadConfig } from "../src/config.mjs";
import { fetchAllDailySources } from "../src/sources-daily.mjs";
import { fetchLinuxDoAiSources, beijingDayRange } from "../src/linuxdo.mjs";
import { filterByRecency } from "../src/snippet-hygiene.mjs";
import { materialWindow } from "../src/report-window.mjs";
import { trendingUrlFor, parseTrending } from "../src/sections/github-trending.mjs";
import { runFetch } from "../src/grok-cli.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dateArg = process.argv.includes("--date")
  ? process.argv[process.argv.indexOf("--date") + 1]
  : null;

// A throwaway cache dir: this script must never read or write the production
// reports cache, where a weekly body could otherwise be mistaken for today's.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "dally-dryrun-"));
process.env.CACHE_DIR = cacheDir;

const config = loadConfig({ date: dateArg, mode: "weekly" });
const win = materialWindow(config);

console.log(`mode          ${config.reportMode}`);
console.log(`date          ${config.date}`);
console.log(`window        ${config.windowLabel}  (${win.days} 天)`);
console.log(`startDate     ${win.startDate}   endDate ${win.endDate}`);
console.log(`GROK_DAYS     ${config.days}   ${process.env.GROK_DAYS ? "(来自 .env)" : "(默认)"}`);
console.log(
  `caps          sourceMaxTotal=${config.sourceMaxTotal} aggLimit=${config.aggregateDailySourceLimit} ` +
    `synthMaxTokens=${config.synthMaxTokens} synthTimeout=${config.synthTimeoutMs}`,
);
console.log(`cacheDir      ${cacheDir} (临时)`);
console.log("");

// --- hard sources ---
const daily = await fetchAllDailySources(config);
const diag = collectDiag(daily);
console.log(`[硬源] ${daily.length} 条  (上限 ${config.aggregateDailySourceLimit})`);
const byProvider = new Map();
for (const s of daily) {
  const k = s.provider || "?";
  byProvider.set(k, (byProvider.get(k) || 0) + 1);
}
for (const [k, n] of [...byProvider].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(16)} ${n}`);
}
if (Object.keys(diag).length) {
  console.log("   诊断:");
  for (const [p, info] of Object.entries(diag)) {
    const sample = info.sample?.[0]?.reason || "?";
    console.log(`     ${p.padEnd(14)} ${info.count} 项  首条原因: ${sample}`);
  }
} else {
  console.log("   诊断: 无（全部采集正常）");
}
console.log("");

// --- forum ---
const winDays = config.materialWindowDays;
const { startLocal, endLocal } = beijingDayRange(config.date, winDays);
console.log(`[linux.do] 窗口 ${new Date(startLocal).toISOString()} → ${new Date(endLocal).toISOString()}`);
const forum = await fetchLinuxDoAiSources(config);
console.log(`   ${forum.length} 条 AI 帖`);
console.log("");

// --- window check ---
const all = [...daily, ...forum];
const { sources, dropped } = filterByRecency(all, config.date, win);
console.log(`[时效过滤] 输入 ${all.length} → 保留 ${sources.length}，过期丢弃 ${dropped}`);
let inWin = 0;
let noTs = 0;
for (const s of sources) {
  if (s.publishedAt == null) { noTs++; continue; }
  if (s.publishedAt >= win.startMs && s.publishedAt < win.endMs) inWin++;
}
console.log(`   带时间戳且落在窗口内: ${inWin}；无时间戳(放行): ${noTs}`);
const dailyCapped = sources.slice(0, config.sourceMaxTotal);
console.log(`   经 sourceMaxTotal=${config.sourceMaxTotal} 截断后进入综合: ${dailyCapped.length} 条`);
console.log("");

// --- github weekly page ---
console.log(`[GitHub] ${trendingUrlFor("weekly")}`);
const gh = await runFetch(trendingUrlFor("weekly"), config, { provider: "direct", maxChars: config.fetchMaxChars });
const rows = parseTrending(gh.text);
console.log(`   解析出 ${rows.length} 行（Top ${Math.min(15, rows.length)} 进表）`);
for (const r of rows.slice(0, 5)) {
  console.log(`   +${r.starsToday}\t${r.repo}\t${(r.language || "-")}`);
}
if (rows.length === 0) {
  console.log("   ⚠️ 周榜解析为 0 行 —— 页面结构可能已变，日报会静默空表");
}

fs.rmSync(cacheDir, { recursive: true, force: true });
console.log("\n（未调用 LLM、未生成海报、未写 vault）");

function collectDiag(arrays) {
  const out = {};
  for (const arr of [arrays]) {
    const d = arr && arr.dailyDiagnostics;
    if (!d) continue;
    if (d.failureCount > 0) out[d.provider] = { count: d.failureCount, sample: d.failures };
  }
  return out;
}
