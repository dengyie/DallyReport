import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { trackChild } from "./child-tracker.mjs";

// Forward the FULL parent environment to the grok-search child: it needs PATH/HOME
// to find node and its own config.js, plus the proxy vars to reach the gateway.
// This intentionally exposes secrets (API keys) to the child — accepted and
// documented here, because the child is this repo's own local grok-search scripts
// and a key whitelist proved to be drift-prone dead code (the spread below already
// forwarded everything).
function childEnv() {
  return { ...process.env };
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

// Cap on the stdout a child may contribute to the accumulated buffer. A runaway
// provider streaming gigabytes through the pipe would otherwise balloon the
// parent's heap (and the error objects that carry `stdout` with it). Past the cap
// further chunks are DROPPED and `truncated` is set on the runScript result.
export const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
// __parse_error.raw keeps only the head+tail of unparsable stdout: enough to see
// what the child actually printed, without shipping megabytes inside error objects.
// Exported for unit tests.
const PARSE_ERROR_RAW_KEEP = 4096;
export function truncateRawForParseError(raw) {
  if (raw.length <= PARSE_ERROR_RAW_KEEP * 2) return raw;
  return (
    raw.slice(0, PARSE_ERROR_RAW_KEEP) +
    "\n...[truncated]...\n" +
    raw.slice(-PARSE_ERROR_RAW_KEEP)
  );
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
    // stdout is accumulated as Buffers (concatenated once at close — also correct
    // for multibyte chars split across chunk boundaries) and capped at
    // MAX_STDOUT_BYTES. stderr stays uncapped: it is the child's small diagnostic
    // channel, and its tail is what the thrown error messages quote.
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let truncated = false;
    child.stdout.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      if (stdoutBytes >= MAX_STDOUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_STDOUT_BYTES - stdoutBytes;
      if (buf.length > room) {
        stdoutChunks.push(buf.subarray(0, room));
        stdoutBytes = MAX_STDOUT_BYTES;
        truncated = true;
        return;
      }
      stdoutChunks.push(buf);
      stdoutBytes += buf.length;
    });
    let stderrRaw = "";
    child.stderr.on("data", (c) => (stderrRaw += c.toString()));
    // Redact on the way OUT of runScript, not at the throw site. The raw stderr
    // is also attached to the error verbatim (`err.stderr = res.stderr`), so a
    // caller reading the PROPERTY — rather than the message — got the unredacted
    // key back even with the message already scrubbed. Redacting at this one sink
    // closes both paths at once. 2026-09-27 review P0-2: leaked IMAGE_API_KEY
    // end-to-end through a real child.
    const currentStderr = () => redactSecrets(stderrRaw);
    const currentStdout = () => Buffer.concat(stdoutChunks).toString("utf8");
    child.on("error", (err) =>
      finish({ ok: false, err, stdout: currentStdout(), stderr: currentStderr(), timedOut, truncated }),
    );
    child.on("close", (code) =>
      finish({
        ok: code === 0 && !timedOut,
        code,
        stdout: currentStdout(),
        stderr: currentStderr(),
        timedOut,
        truncated,
      }),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first, SIGKILL as a backstop. 2026-09-26 review P1: this
      // handler used to rely entirely on `close` arriving to settle the promise.
      // Node emits `close` only once the process has exited AND every stdio pipe
      // is closed — so a grandchild that inherited stdout (a wedged
      // grok-search dependency, the exact thing this module exists to contain)
      // kept the pipe open forever and the promise NEVER settled, hanging the
      // daily run past its window. `Promise.allSettled` cannot rescue a pending
      // thunk. Settle here; the `settled` guard makes any later `close` a no-op.
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
      finish({
        ok: false,
        code: null,
        stdout: currentStdout(),
        stderr: currentStderr(),
        timedOut: true,
        truncated,
      });
    }, timeoutMs);
  });
}

// Extract the last balanced JSON object from noisy stdout. A child that writes a
// single progress/debug line before its payload used to make the WHOLE fetch
// fail with __parse_error, discarding a perfectly good result. Latent today (the
// installed grok-search scripts send diagnostics to stderr, not stdout), but one
// stray console.log in a dependency update would silently convert every working
// fetch into a hard failure across all five collectors.
function extractLastJsonObject(text) {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  // Walk backwards to the matching '{', ignoring braces inside strings.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

function parseJsonOut(stdout, scriptPath, args, truncated = false) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const candidate = extractLastJsonObject(trimmed);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* fall through to the parse-error result */
      }
    }
    // Bounded raw: head+tail only, so a huge garbage dump never rides inside the
    // error object (the full capped stdout stays on err.stdout for debugging).
    const out = { __parse_error: true, raw: truncateRawForParseError(stdout) };
    if (truncated) out.truncated = true;
    return out;
  }
}

// The child inherits the full parent env, so its stderr can contain a key or the
// linux.do session cookie (e.g. an auth path that echoes the request). That text
// is quoted into thrown error messages, which the synthesis tool loop used to
// forward to the third-party LLM gateway. Redact before interpolation.
//
// 2026-09-27 review (round 4) — the previous version enumerated a HAND-KEPT list
// of five variable names. That list was stale on day one: IMAGE_API_KEY is a
// first-class required key in this project (config.mjs imageApiKey() falls back
// to GROK_API_KEY) and it was absent, so an image-gen key echoed by a child went
// straight into a thrown Error verbatim. Every other secret in .env was equally
// exposed, because a list only ever covers what someone remembered to add — a
// hand-list is a bug that regenerates itself. So enumerate the ENVIRONMENT
// instead: any variable whose NAME looks secret-ish has its VALUE redacted,
// whatever it is called and whenever it lands in .env.
const SECRET_NAME_RE =
  /(?:^|[^A-Za-z0-9_])([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTH)[A-Za-z0-9_]*)/;

/** Exported for tests: the env-var names this redactor would consult. */
export function secretEnvKeys(env = process.env) {
  return Object.keys(env).filter((k) => SECRET_NAME_RE.test(k));
}

export function redactSecrets(text, env = process.env) {
  let out = String(text || "");
  // Pass 1: the value of every secret-looking env var. The `>= 8` floor guards
  // against a 1-2 char value ("1", "on") being scrubbed out of every ordinary
  // word; real credentials are far longer than that.
  for (const key of secretEnvKeys(env)) {
    const value = env[key];
    if (typeof value === "string" && value.length >= 8) {
      out = out.split(value).join(`[${key} 已脱敏]`);
    }
  }
  // Pass 2: labelled secrets the env sweep cannot know about. Three shapes, each
  // with a concrete child that prints it:
  //  1. label + separator:   `api_key=…`, `cookie: …`, `X-Grok-Key: …`
  //  2. label + whitespace:  `apiKey sk-live-…`   (no separator at all)
  //  3. auth word + token:   `Bearer ghs_…`, `Basic dXNlcjpwYXNzd29yZDEyMw==`
  //
  // The round-3 alternation listed `bearer`/`authorization` but then REQUIRING
  // `[=:]` after the label made both of them unreachable — the single most likely
  // thing for an auth failure to print ("Bearer <token>") matched nothing. And
  // because the label was a bare alternation with no `[-_]` allowed, `X-Grok-Key:`
  // and `x-api-key=` did not match either.
  const SECRET_VALUE = String.raw`[A-Za-z0-9._~+/=-]{8,}`;
  // A label may be compound: "X-Grok-Key", "x_api_key", "apiKey", "session-token".
  const SECRET_LABEL = String.raw`(?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|access[-_]?key|private[-_]?key|key|token|secret|cookie|session|auth|authorization|bearer|password|passwd|credential|signature)[A-Za-z0-9_-]*`;
  // 1. label + [=:]
  out = out.replace(
    new RegExp(String.raw`\b(${SECRET_LABEL})\s*[=:]\s*${SECRET_VALUE}`, "gi"),
    (m, p1) => `${p1} [已脱敏]`,
  );
  // 2. label + whitespace. The value must additionally look like a credential
  // (>= 12 chars AND containing a `-` or `_`) so that "token count=12345" and
  // "timeout after 20000ms" survive intact — over-redaction is its own outage.
  out = out.replace(
    new RegExp(
      String.raw`\b(${SECRET_LABEL}\s+)((?=[^\s]*[-_])${String.raw`[A-Za-z0-9._~+/=-]{12,}`})`,
      "gi",
    ),
    (m, p1) => `${p1}[已脱敏]`,
  );
  // 3. auth word + bare token (RFC 7235 shape).
  out = out.replace(
    /\b(bearer|authorization|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    (m, p1) => `${p1} [已脱敏]`,
  );
  return out;
}

export async function runSearch(query, config, { days, extra } = {}) {
  const scriptPath = path.join(config.grokSearchDir, "scripts", "search.js");
  const args = [];
  if (days && days > 0) args.push("--days", String(days));
  if (extra != null) args.push("--extra", String(extra));
  if (config?.searchModel) args.push("--model", config.searchModel);
  args.push(query);

  const res = await runScript(scriptPath, args);
  const parsed = parseJsonOut(res.stdout, scriptPath, args, res.truncated);

  // grok-search: on failure it still emits JSON to stdout + a short stderr msg + non-zero.
  if (!res.ok || !parsed || parsed.__parse_error) {
    const err = new Error(
      res.timedOut
        ? `grok-search search.js 超时（${childTimeoutMs()}ms 无响应）`
        : `grok-search search.js 退出码 ${res.code ?? "?"}：${redactSecrets((res.err && res.err.message) || res.stderr.trim() || "no stdout")}`,
    );
    err.script = "search.js";
    err.args = args;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    err.timedOut = res.timedOut === true;
    err.truncated = res.truncated === true;
    if (parsed?.__parse_error) err.parseError = parsed;
    err.parsed = parsed && !parsed.__parse_error ? parsed : null;
    throw err;
  }
  return parsed;
}

export async function runFetch(url, config, { maxChars, provider = "auto", cacheFile, cachePredicate } = {}) {
  // Disk cache for fetched pages so reruns don't re-hit the network and the parse
  // step can be iterated on offline. Cache key is an explicit cacheFile path.
  // When the caller passes a cachePredicate it gates the READ path too: a cached
  // body that fails it (e.g. a 200 challenge page cached before the gate existed)
  // is treated as a cache MISS and re-fetched — poison is never replayed all day.
  if (cacheFile) {
    try {
      const cached = await fs.readFile(cacheFile, "utf8");
      if (cached.trim() && (!cachePredicate || cachePredicate(cached))) {
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
  const parsed = parseJsonOut(res.stdout, scriptPath, args, res.truncated);
  if (!res.ok || !parsed || parsed.__parse_error) {
    const err = new Error(
      res.timedOut
        ? `grok-search fetch.js 超时（${childTimeoutMs()}ms 无响应）`
        : `grok-search fetch.js 退出码 ${res.code ?? "?"}：${redactSecrets((res.err && res.err.message) || res.stderr.trim() || "no stdout")}`,
    );
    err.script = "fetch.js";
    err.args = args;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    err.timedOut = res.timedOut === true;
    err.truncated = res.truncated === true;
    if (parsed?.__parse_error) err.parseError = parsed;
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
