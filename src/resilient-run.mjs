#!/usr/bin/env node
// Resilience orchestration shell for the main DallyReport daily pipeline.
//
// This wraps the raw `src/run.mjs` call (previously a 3-line .cmd) with the
// same guard layers ai-daily's run-daily-win.sh has proven effective:
//   1. Same-day idempotency skip (product already exists → no rerun)
//   2. Gateway model probe with model-ladder fallback (fail before wasting minutes)
//   3. Spawn run.mjs with log capture (stdout/stderr → logs/task.{out,err}.log)
//   4. Product self-check (output files exist, bytes > 0)
//   5. Failure notification (PowerShell WinRT toast on error)
//   6. Log rotation (keep N runs, rename old tails)
//
// Logging is owned here, not by the launcher: the previous .cmd redirected the
// process into logs/task.*.log with `>>`, which both (a) double-wrote every line
// this shell also appends and (b) held the log file open, so the rotation rename
// below would fail on Windows. The .cmd is now a thin `node src/resilient-run.mjs`
// launcher and every line lands here exactly once.
//
// In the common case (gateway reachable, run succeeds) a silent success is the
// result. A failed run now leaves visible diagnostics in the log and a toast —
// the biggest gap the previous 3-line .cmd had.

import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trackChild, killAllChildren } from "./child-tracker.mjs";
import { loadConfig, beijingDateFor, beijingTimestampFor, KNOWN_BAD_MODELS as KNOWN_BAD_MODEL_LIST } from "./config.mjs";

// Process lifecycle hooks: reap any in-flight child if the scheduler, runner
// or operator interrupts us, so orphaned Node or curl processes never survive.
process.on("exit", () => {
  killAllChildren();
});
process.on("SIGINT", () => {
  killAllChildren();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killAllChildren();
  process.exit(143);
});

// Single source for the known-bad writer set, defined once in config.mjs. A
// `new Set` here would fall out of sync the day a model joins the list; the
// import keeps the shell and the config in lockstep.
const KNOWN_BAD_MODELS = new Set(KNOWN_BAD_MODEL_LIST);

// ── 1. Path helpers ──────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = path.join(PROJECT_ROOT, "logs");
const TASK_OUT_LOG = path.join(LOG_DIR, "task.out.log");
const TASK_ERR_LOG = path.join(LOG_DIR, "task.err.log");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendLine(filePath, line) {
  try {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, line + "\n", "utf-8");
  } catch (_) {
    // Log never blocks the run; best-effort.
  }
}

// Single-point logging: one call writes to stdout AND the durable log, so a
// manual run shows progress and the scheduled run records it. Never duplicated.
function log(line) {
  try { process.stdout.write(line + "\n"); } catch (_) { /* broken pipe */ }
  appendLine(TASK_OUT_LOG, line);
}

function logErr(line) {
  try { process.stderr.write(line + "\n"); } catch (_) { /* broken pipe */ }
  appendLine(TASK_ERR_LOG, line);
}

// Reading creds straight from process.env (not via config, whose explicit rule is
// to keep secrets out of the returned config object — matching assertGrokCreds).
function env(name) {
  return process.env[name]?.trim() || null;
}

// ── 2. Gateway model probe ───────────────────────────────────────────────

// Per-model probe ceiling. Must sit ABOVE the gateway's documented Cloudflare
// ~120s cap (see .env.example: the synth path 524s at ~120s), or a slow-but-alive
// gateway is falsely judged "unreachable" and the whole run is aborted as
// PROBE-FAIL (exit 16) when it would have succeeded a few seconds later. spec §8
// states 180s; export it so a regression test can pin that contract.
export const PROBE_TIMEOUT_MS = 180_000;

// Run-guard knobs (override via env for ops/testing):
//   LAUNCH_FAST_DEATH_S — a child that exited non-zero within this window with no
//     product is a "fast death" (orchestration died early): a distinct signal from
//     a naturally slow failure. Mirrors ai-daily's LAUNCH_FAST_DEATH_S=600.
//   LAUNCH_STALL_CEIL_S — a child still ALIVE this long with no product is stuck;
//     its singleton-lock heartbeat would keep every later day refused, so we kill
//     it rather than hang the scheduled job until Task Scheduler's default 72h cap.
function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const FAST_DEATH_S = intEnv("LAUNCH_FAST_DEATH_S", 600);
const STALL_CEIL_S = intEnv("LAUNCH_STALL_CEIL_S", 3600);
// Bound the in-memory stderr tail; the durable copy lives in the log file.
const STDERR_TAIL_CAP = 64 * 1024;

/**
 * Send a minimal /chat/completions ping to `model` on `apiUrl`.
 * Returns { reachable, status, error }.
 * A successful 200 (or 202) with max_tokens=8 costs near-zero tokens and is the
 * cheapest verifiable signal that the gateway + model are alive, so a run that
 * is about to spend minutes of writing can be aborted before it starts.
 */
export async function probeModel(apiUrl, apiKey, model, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
      }),
      signal: controller.signal,
    });
    // The timer stays armed through the BODY read: a gateway that returns 200
    // headers and then stalls (the fake-empty-stream failure class this gateway
    // actually exhibits) would otherwise wait on undici's default body timeout —
    // or forever on SSE keepalive bytes, which reset it per chunk. A 4-model
    // ladder could then idle ~20 minutes before spawning anything. The abort
    // signal cancels body reads; an aborted read IS the deadline firing, so it
    // must surface as "timeout" rather than be swallowed into an empty body.
    let body = "";
    try {
      body = await res.text();
    } catch (e) {
      if (e?.name === "AbortError") {
        return { reachable: false, status: null, error: "timeout" };
      }
      return { reachable: false, status: null, error: e?.message || String(e) };
    }
    const reachable = res.ok && body.length > 0;
    return { reachable, status: res.status, error: reachable ? null : `HTTP ${res.status}` };
  } catch (e) {
    const error = e?.name === "AbortError" ? "timeout" : (e?.message || String(e));
    return { reachable: false, status: null, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the model ladder, probing each candidate until one replies.
 * Returns { model, error } — `model` is the first reachable model, or null.
 */
export async function probeLadder(apiUrl, apiKey, candidateModels) {
  const lastErr = { error: "no candidates" };
  for (const model of candidateModels) {
    const r = await probeModel(apiUrl, apiKey, model);
    lastErr.error = r.error;
    if (r.reachable) return { model, error: null };
  }
  return { model: null, error: lastErr };
}

/**
 * Build the ordered probe ladder from config, dropping known-bad writers and
 * duplicates. Order follows spec §4.1: primary → synth-fallback → search model →
 * alt. Pure and exported so the filtering (not just the probing) is unit-testable.
 */
export function probeCandidates(config) {
  const seen = new Set();
  const out = [];
  for (const m of [
    config.synthModel,
    config.synthFallbackModel,
    config.searchModel,
    config.aiAltModel,
  ]) {
    if (!m || KNOWN_BAD_MODELS.has(m) || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * When the probe skipped past a dead primary and selected the configured
 * fallback itself, GROK_SYNTH_FALLBACK_MODEL must be re-pointed so the child's
 * fallback ladder still offers something else. The 2026-10-29 behaviour
 * reassigned the hardcoded pair member — which is exactly the primary the probe
 * just proved dead, leaving a fallback ladder of one dead model. The next
 * unprobed ladder entry is strictly better. Returns null when nothing follows
 * (the caller leaves the env untouched; the child's own dedup makes that safe).
 */
export function nextFallbackCandidate(candidates, probedModel) {
  const idx = candidates.indexOf(probedModel);
  if (idx === -1) return null;
  return candidates[idx + 1] ?? null;
}

/**
 * Pre-flight network and proxy connectivity probe.
 * Checks external (e.g. GitHub/foreign sources) and internal reachability
 * with short timeouts to catch proxy dropouts before launching the crawler.
 */
export async function probeNetworkConnectivity(timeoutMs = 4000) {
  const check = async (url) => {
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
      return res.ok || res.status < 500;
    } catch {
      return false;
    }
  };

  const [foreignOk, domesticOk] = await Promise.all([
    check("https://api.github.com"),
    check("https://linux.do"),
  ]);

  if (foreignOk && domesticOk) {
    return { ok: true, status: "all_healthy" };
  } else if (!foreignOk && domesticOk) {
    return { ok: false, status: "foreign_blocked", warning: "境外网络或代理节点连接受阻（HN/ArXiv/Google等外文源可能受影响）" };
  } else if (foreignOk && !domesticOk) {
    return { ok: false, status: "domestic_blocked", warning: "境内社区/服务连接受阻" };
  } else {
    return { ok: false, status: "network_down", warning: "外网完全不可达，请检查本地网络、DNS或代理配置" };
  }
}

// ── 3. Product self-check ─────────────────────────────────────────────────

const PRODUCT_DAILY = ["AI.md", "GitHub.md"];
const PRODUCT_WEEKLY = ["AI-周报.md", "GitHub-周报.md"];

export function checkProducts(outDir, isWeekly) {
  const files = isWeekly ? PRODUCT_WEEKLY : PRODUCT_DAILY;
  return files.map((name) => {
    const p = path.join(outDir, name);
    let size = 0;
    try { size = fs.statSync(p).size; } catch (_) { /* missing */ }
    return { name, path: p, ok: size > 0, size };
  });
}

/**
 * The idempotency gate: skip the day only when EVERY product for this mode is
 * present and non-empty. Keying on AI.md alone permanently orphaned
 * half-produced days (AI.md on disk, GitHub.md lost to a crash) — every retry,
 * scheduled or manual, exited 0 before checkProducts ever got a say.
 */
export function shouldSkipForIdempotency(outDir, isWeekly) {
  return checkProducts(outDir, isWeekly).every((p) => p.ok);
}

// ── 4. Log rotation ───────────────────────────────────────────────────────

const LOG_KEEP = 20; // keep 20 run-tails, matching ai-daily's archive-depth convention

export function rotateLog(logPath, keep) {
  try {
    if (!fs.existsSync(logPath)) return;
    const dir = path.dirname(logPath);
    const base = path.basename(logPath);
    const stamp = beijingDateFor(Date.now()).replace(/-/g, "");
    // Same-day re-rotation (a manual retry after a failed scheduled run): never
    // clobber the archive already taken today — Windows renameSync to an existing
    // target throws, which the old code swallowed, silently leaving the log
    // un-rotated. Append a sequence suffix instead.
    let stale = path.join(dir, `${base}.stale-${stamp}`);
    for (let n = 2; fs.existsSync(stale); n++) stale = path.join(dir, `${base}.stale-${stamp}-${n}`);
    fs.renameSync(logPath, stale);
    // Prune by the DATE embedded in the archive name, not atime: Windows commonly
    // does not maintain atime, which made the old atime sort arbitrary and could
    // delete today's archive before last week's. The name is the sort key.
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${esc}\\.stale-(\\d{8})(?:-(\\d+))?$`);
    const stales = fs.readdirSync(dir)
      .map((f) => {
        const m = pattern.exec(f);
        if (!m) return null;
        const seq = String(m[2] ?? 1).padStart(6, "0");
        return { name: f, key: `${m[1]}-${seq}` };
      })
      .filter(Boolean)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let toDelete = Math.max(0, stales.length - keep);
    for (const s of stales) {
      if (toDelete <= 0) break;
      try { fs.unlinkSync(path.join(dir, s.name)); } catch (_) { /* best-effort */ }
      toDelete--;
    }
  } catch (_) {
    // Rotation is hygiene, not correctness. Ignore errors.
  }
}

// ── 5. Notification (Windows PowerShell WinRT toast) ──────────────────────

function notify(title, body) {
  if (process.platform !== "win32") return;
  // PS single-quoted strings: variables like $foo are literal text inside, so an
  // error message containing "$env" won't expand or break the toast. Only ' must
  // be escaped (as ''). Mirrors ai-daily's ps_escape.
  const e = (s) => String(s).replace(/'/g, "''");
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null",
    "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$template.GetElementsByTagName('text').Item(0).AppendChild($template.CreateTextNode('" + e(title) + "')) | Out-Null",
    "$template.GetElementsByTagName('text').Item(1).AppendChild($template.CreateTextNode('" + e(body) + "')) | Out-Null",
    "$toast = New-Object Windows.UI.Notifications.ToastNotification($template)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DallyReport').Show($toast)",
  ].join("; ");
  try {
    spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", detached: true }).unref();
  } catch (_) {
    // Toast is additive; failure is not a report failure.
  }
}

// ── 6. Runner auxiliary: spawn run.mjs and stream to log files ───────────

/**
 * Spawn the real `run.mjs` with args. Every child byte is forwarded to this
 * process's stdout/stderr (so a manual run is live) AND appended to the log
 * files (so a scheduled run is recorded). Returns { code, stderr, stalled }.
 *
 * @param {string|null} watchPath  if set, a product file whose absence after
 *   `stallCeilMs` means the run is stuck (the singleton-lock heartbeat would
 *   block every later day) — the child is killed and `stalled=true` returned.
 */
export function spawnRunner(nodeExe, runMjs, args, outLog, errLog, { watchPath = null, stallCeilMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(nodeExe, [runMjs, ...args], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackChild(child); // an interrupted 09:00 job must not orphan the run child
    let stderrBuf = "";
    let settled = false;
    let stalled = false;
    let watchdog;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      const finalCode = stalled ? (code && code !== 0 ? code : 1) : (code ?? 1);
      resolve({ code: finalCode, stderr: stderrBuf, stalled });
    };
    child.stdout.on("data", (chunk) => {
      try { process.stdout.write(chunk); } catch (_) { /* broken pipe */ }
      try { fs.appendFileSync(outLog, chunk); } catch (_) { /* best-effort */ }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf = (stderrBuf + String(chunk)).slice(-STDERR_TAIL_CAP);
      try { process.stderr.write(chunk); } catch (_) { /* broken pipe */ }
      try { fs.appendFileSync(errLog, chunk); } catch (_) { /* best-effort */ }
    });
    child.on("error", (err) => {
      stderrBuf += `\nspawn error: ${err.message}\n`;
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    // Stall ceiling: kill a child that has been running too long with nothing to
    // show. The singleton lock heartbeat stays alive as long as the child does;
    // without this, a hung run refuses every future day until killed by hand.
    //
    // One firing is not enough: a child that hangs AFTER writing the watch file
    // (poster render, full-post crawl, a socket with no timeout) used to run
    // forever behind the old one-shot check. Progress re-arms the guard once and
    // a hard cap of 2× the ceiling then kills even a "productive" hang — one
    // ceiling to produce the note, one for posters + enrichment.
    if (watchPath && stallCeilMs > 0) {
      const killStalled = (reason) => {
        stalled = true;
        stderrBuf += `\n[stall] ${reason}; killing run.mjs\n`;
        if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
          try {
            spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
          } catch (_) { /* best-effort tree kill */ }
        }
        try { child.kill(); } catch (_) { /* already gone */ }
        // close should fire; a 5s fallback in case Node's child-process plumbing
        // is blocked too.
        const fallback = setTimeout(() => finish(1), 5000);
        fallback.unref?.();
      };
      watchdog = setTimeout(function checkStall() {
        if (settled) return;
        let produced = false;
        try { produced = fs.existsSync(watchPath) && fs.statSync(watchPath).size > 0; } catch (_) { /* missing */ }
        if (produced) {
          watchdog = setTimeout(() => {
            if (settled) return;
            killStalled(`hard cap ${Math.round((stallCeilMs * 2) / 1000)}s exceeded (product present but run never finished)`);
          }, stallCeilMs);
          watchdog.unref?.();
          return;
        }
        killStalled(`no ${watchPath} after ${Math.round(stallCeilMs / 1000)}s`);
      }, stallCeilMs);
      watchdog.unref?.();
    }
  });
}

// ── 7. Main entry ────────────────────────────────────────────────────────

async function main() {
  const stamp = beijingTimestampFor(Date.now());
  const date = beijingDateFor(Date.now());

  // Rotate logs before appending so today's run starts clean.
  rotateLog(TASK_OUT_LOG, LOG_KEEP);
  rotateLog(TASK_ERR_LOG, LOG_KEEP);

  // ── 7a. Idempotency skip ──────────────────────────────────────────────
  const config = loadConfig({ date });
  const outDir = path.join(config.obsidianDir, date);
  const aiMd = path.join(outDir, config.isWeekly ? "AI-周报.md" : "AI.md");
  if (shouldSkipForIdempotency(outDir, config.isWeekly)) {
    log(`${stamp} SKIP: ${outDir} 产物齐全，跳过本日 run（幂等）`);
    return 0;
  }

  // ── 7a-2. Network & proxy connectivity probe ──────────────────────────
  try {
    const netStatus = await probeNetworkConnectivity(4000);
    if (!netStatus.ok && netStatus.warning) {
      log(`${stamp} WARN: [network-probe] ${netStatus.warning} (${netStatus.status})`);
    } else {
      log(`${stamp} NET-PROBE OK: 网络连通性良好`);
    }
  } catch (_) {
    // Non-blocking diagnostic probe
  }

  // ── 7b. Gateway model probe ───────────────────────────────────────────
  const apiUrl = env("GROK_API_URL");
  const apiKey = env("GROK_API_KEY");
  // KNOWN_BAD_MODELS (config.mjs) lists writers the gateway advertises but that
  // fail at writing. gpt-5.6-luna returns fake-empty SSE streams
  // (chatcmpl-freeblock000) and 500s on /responses, so the default GROK model is
  // unusable; probe it out first and fall through to a working writer rather than
  // spending minutes on it. probeCandidates owns the order + filtering (primary →
  // synth-fallback → search → alt), dedup and the known-bad cut.
  const candidates = probeCandidates(config);
  if (candidates.length === 0) {
    logErr(`${stamp} PROBE-FAIL: 无可用写手模型（全部 known-bad 或未配置）`);
    notify("DallyReport 日报失败", `${date} 无可用写手模型`);
    return 18;
  }

  const probe = apiUrl && apiKey
    ? await probeLadder(apiUrl, apiKey, candidates)
    : { model: config.synthModel, error: null };
  log(`${stamp} PROBE ${probe.model ? "OK:" + probe.model : "FAIL:" + (probe.error?.error || "?")} (tried ${candidates.join("→")})`);
  if (!probe.model) {
    logErr(`${stamp} PROBE-FAIL: all candidates unreachable`);
    notify("DallyReport 日报失败", `${date} 全部写手不可达`);
    return 16;
  }

  // ── 7c. Spawn run.mjs ─────────────────────────────────────────────────
  // Only --date is passed (no --mode here: run.mjs auto-derives weekly itself).
  // If the probe chose a different writer than the configured primary, the chosen
  // one becomes GROK_MODEL for that child so the run uses a reachable model.
  if (probe.model !== config.synthModel) {
    process.env.GROK_MODEL = probe.model;
    log(`${stamp} PROBE-FALLBACK: primary ${config.synthModel} → ${probe.model}`);
  }
  // Prevent duplicate primary and fallback if probe selected the fallback model.
  // The replacement must NOT be the hardcoded pair member — that is the primary
  // the probe just proved dead, which would leave the child a fallback ladder of
  // exactly one dead model. Take the next unprobed ladder entry instead; if none
  // remains, leave the env as-is (the child's own ladder dedup makes that safe).
  if (process.env.GROK_SYNTH_FALLBACK_MODEL === probe.model) {
    const nextFallback = nextFallbackCandidate(candidates, probe.model);
    if (nextFallback) {
      process.env.GROK_SYNTH_FALLBACK_MODEL = nextFallback;
      log(`${stamp} PROBE-FALLBACK: reassigned GROK_SYNTH_FALLBACK_MODEL to ${nextFallback}`);
    } else {
      log(`${stamp} PROBE-FALLBACK: no ladder entry after ${probe.model}; fallback left as-is`);
    }
  }

  const startMs = Date.now();
  const result = await spawnRunner(
    process.execPath,
    path.join(PROJECT_ROOT, "src", "run.mjs"),
    ["--date", date],
    TASK_OUT_LOG,
    TASK_ERR_LOG,
    // The singleton-lock heartbeat keeps every later day refused while this child
    // is alive, so a hung run must be killed rather than left to occupy the lock.
    { watchPath: aiMd, stallCeilMs: STALL_CEIL_S * 1000 },
  );
  const elapsedS = Math.round((Date.now() - startMs) / 1000);

  // ── 7d. Product self-check ────────────────────────────────────────────
  const products = checkProducts(outDir, config.isWeekly);
  const allOk = products.every((p) => p.ok);
  const productLines = products.map((p) => `${p.name}:${p.ok ? p.size + "B" : "MISSING"}`).join(", ");

  if (allOk && result.code === 0) {
    log(`${stamp} DONE rc=0 ${elapsedS}s products={${productLines}} writer=${probe.model}`);
    return 0;
  }

  // Anything below is a failure: missing products OR non-zero exit. A stalled
  // run is reported distinctly (12) rather than as a generic child-code, so an
  // operator can tell "the gateway died" (16) from "a stall" (12).
  const failReasons = [];
  if (result.code !== 0) failReasons.push(`exit=${result.code}`);
  if (result.stalled) failReasons.push("stall");
  const missing = products.filter((p) => !p.ok).map((p) => p.name);
  if (missing.length) failReasons.push(`missing=${missing.join(",")}`);

  const errTail = result.stderr ? result.stderr.split("\n").slice(-5).join(" | ") : "";
  logErr(`${stamp} FAIL ${elapsedS}s ${failReasons.join(" ")} products={${productLines}} stderr_tail=[${errTail.slice(0, 200)}]`);
  notify("DallyReport 日报失败", `${date} 日报产出异常：${failReasons.join("，")}`);
  if (result.stalled) return 12;
  return result.code || 8;
}

// Only run when invoked directly (node src/resilient-run.mjs), so unit tests can
// import the exported helpers without triggering a real pipeline run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((e) => {
    const stamp = beijingTimestampFor(Date.now());
    logErr(`${stamp} CRASH: ${e?.message || e}`);
    notify("DallyReport", `日报崩溃 - ${e?.message || "未知"}`);
    process.exit(10);
  });
}