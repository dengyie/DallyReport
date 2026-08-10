import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { trackChild } from "./child-tracker.mjs";

// Environment variables grok-search reads via its own config.js (process.env only,
// no .env auto-load). We forward every keys it cares about, sourcing from .env
// (already loaded into process.env by config.mjs).
function childEnv() {
  const fwd = {};
  for (const k of [
    "GROK_API_URL",
    "GROK_API_KEY",
    "TAVILY_API_KEY",
    "TAVILY_API_URL",
    "FIRECRAWL_API_KEY",
    "FIRECRAWL_API_URL",
    "GROK_OUTPUT_DIR",
    "GROK_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    if (process.env[k] != null) fwd[k] = process.env[k];
  }
  return { ...process.env, ...fwd };
}

// Wall-clock budget for a single grok-search child. A wedged upstream (e.g. the
// gateway hanging on /responses) would otherwise leave search.js/fetch.js running
// forever and hang the whole report - Promise.allSettled can't rescue a *pending*
// thunk, only a rejected one. Default 2 min; overridable via GROK_CHILD_TIMEOUT_MS.
function childTimeoutMs() {
  const raw = process.env.GROK_CHILD_TIMEOUT_MS;
  if (raw == null || raw === "") return 120000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 120000;
}

function runScript(scriptPath, args) {
  return new Promise((resolve) => {
    const timeoutMs = childTimeoutMs();
    let timedOut = false;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const child = spawn(
      process.execPath,
      [scriptPath, ...args],
      { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    // Register with the global child tracker so run.mjs reaps this process (SIGKILL)
    // if the main run is interrupted mid-search — otherwise it would orphan.
    trackChild(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => finish({ ok: false, err, stdout, stderr, timedOut }));
    child.on("close", (code) =>
      finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut }),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; the close handler resolves with timedOut=true. Force-kill as a
      // backstop if the child ignores SIGTERM within a short grace window.
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 3000).unref?.();
    }, timeoutMs);
  });
}

function parseJsonOut(stdout, scriptPath, args) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { __parse_error: true, raw: stdout };
  }
}

export async function runSearch(query, config, { days, extra } = {}) {
  const scriptPath = path.join(config.grokSearchDir, "scripts", "search.js");
  const args = [];
  if (days && days > 0) args.push("--days", String(days));
  if (extra != null) args.push("--extra", String(extra));
  if (config?.searchModel) args.push("--model", config.searchModel);
  args.push(query);

  const res = await runScript(scriptPath, args);
  const parsed = parseJsonOut(res.stdout, scriptPath, args);

  // grok-search: on failure it still emits JSON to stdout + a short stderr msg + non-zero.
  if (!res.ok || !parsed || parsed.__parse_error) {
    const err = new Error(
      res.timedOut
        ? `grok-search search.js 超时（${childTimeoutMs()}ms 无响应）`
        : `grok-search search.js 退出码 ${res.code ?? "?"}：${(res.err && res.err.message) || res.stderr.trim() || "no stdout"}`,
    );
    err.script = "search.js";
    err.args = args;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    err.timedOut = res.timedOut === true;
    err.parsed = parsed && !parsed.__parse_error ? parsed : null;
    throw err;
  }
  return parsed;
}

export async function runFetch(url, config, { maxChars, provider = "auto", cacheFile, cachePredicate } = {}) {
  // Disk cache for fetched pages so reruns don't re-hit the network and the parse
  // step can be iterated on offline. Cache key is an explicit cacheFile path.
  if (cacheFile) {
    try {
      const cached = await fs.readFile(cacheFile, "utf8");
      if (cached.trim()) {
        return { text: cached, fromCache: true, provider: "cache", cacheFile };
      }
    } catch {
      /* fall through to live fetch */
    }
  }

  const scriptPath = path.join(config.grokSearchDir, "scripts", "fetch.js");
  const args = ["--provider", provider];
  if (maxChars != null) args.push("--max-chars", String(maxChars));
  args.push(url);

  const res = await runScript(scriptPath, args);
  const parsed = parseJsonOut(res.stdout, scriptPath, args);
  if (!res.ok || !parsed || parsed.__parse_error) {
    const err = new Error(
      res.timedOut
        ? `grok-search fetch.js 超时（${childTimeoutMs()}ms 无响应）`
        : `grok-search fetch.js 退出码 ${res.code ?? "?"}：${(res.err && res.err.message) || res.stderr.trim() || "no stdout"}`,
    );
    err.script = "fetch.js";
    err.args = args;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    err.timedOut = res.timedOut === true;
    throw err;
  }

  const text = parsed.content?.text || "";
  const full = parsed.content?.full_path;
  let body = text;
  if (!body && full) {
    try {
      body = await fs.readFile(full, "utf8");
    } catch {
      /* ignore */
    }
  }
  // Content-signature gate: a 200 + a non-empty but *wrong* body (a Cloudflare /
  // gateway HTML error page, an interstitial) must NOT be written as a fresh cache
  // that a later rerun would replay as "successful". When the live body fails
  // `cachePredicate(text) -> truthy`, we skip the write and flag `cacheSkipped`.
  // We deliberately do NOT serve a prior good cache here: a good cache already
  // short-circuited the top of this function as a cache hit, so falling back now
  // would be unreachable in practice; the live (invalid) body is returned so the
  // caller sees the fresh parse miss and can render its own empty/error state.
  const looksValid = cachePredicate ? !!cachePredicate(body) : true;
  let cacheWriteError = null;
  if (cacheFile && body && looksValid) {
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, body, "utf8");
    } catch (error) {
      cacheWriteError = {
        code: error?.code || "CACHE_WRITE_FAILED",
        message: error?.message || String(error),
      };
    }
  }
  return {
    text: body,
    provider: parsed.diagnostics?.provider || provider,
    fromCache: false,
    cacheFile: cacheFile || undefined,
    cacheWriteError,
    cacheSkipped: !looksValid || null,
    truncated: parsed.content?.truncated || false,
    diagnostics: parsed.diagnostics,
  };
}
