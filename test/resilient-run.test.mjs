import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { tmpDirSync } from "./helpers/tmp.mjs";
import {
  checkProducts,
  rotateLog,
  probeModel,
  probeLadder,
  probeCandidates,
  probeNetworkConnectivity,
  nextFallbackCandidate,
  shouldSkipForIdempotency,
  spawnRunner,
  PROBE_TIMEOUT_MS,
} from "../src/resilient-run.mjs";
import { KNOWN_BAD_MODELS } from "../src/config.mjs";

function tmpDir() {
  return tmpDirSync("resilient-run-");
}

// Swap globalThis.fetch for one test, then put the original back. The probe
// never touches the network in tests — the gateway contract is asserted against
// a stub so the suite is deterministic and offline-safe.
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ── probeModel: the 180s contract must hold through the BODY phase ────────

test("probeModel: a 200 whose body stalls is aborted at the ceiling (timeout, not an eternal hang)", async () => {
  // 2026-10-30 P2: the old probe cleared the abort timer as soon as response
  // HEADERS arrived, so a gateway that returned 200 and then stalled made
  // text() wait on undici's default body timeout (or forever on SSE
  // keepalives) — the exported ceiling was a constant the code never enforced.
  // The stub wires the abort signal into text() so the test observes exactly
  // what a stalled gateway does under an armed deadline.
  const result = await withFetch(async (_url, init = {}) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    }),
  }), () => probeModel("https://gateway.test/v1", "k", "m", { timeoutMs: 60 }));
  assert.equal(result.reachable, false);
  assert.equal(result.error, "timeout", "the armed deadline, not the body stall, decides the outcome");
  assert.equal(result.status, null);
});

test("probeModel: default ceiling stays the exported PROBE_TIMEOUT_MS", async () => {
  // The injectable override is for tests only; production callers pass nothing
  // and must keep the 180s contract (spec §8).
  assert.ok(PROBE_TIMEOUT_MS >= 120_000);
});

// ── nextFallbackCandidate (probe-driven fallback reassignment) ────────────

test("nextFallbackCandidate: returns the next unprobed ladder entry, never the probed-dead primary", () => {
  // 2026-10-30 P2: the old reassignment hardcoded the pair member — the exact
  // primary the probe had just proved dead — leaving the child a fallback
  // ladder of one dead model on a primary-outage day.
  const candidates = ["gemini-3.8-flash", "deepseek-v4-flash", "grok-4.5"];
  assert.equal(nextFallbackCandidate(candidates, "deepseek-v4-flash"), "grok-4.5");
});

test("nextFallbackCandidate: no entry after the last, and unknown models yield null", () => {
  const candidates = ["gemini-3.8-flash", "deepseek-v4-flash"];
  assert.equal(nextFallbackCandidate(candidates, "deepseek-v4-flash"), null);
  assert.equal(nextFallbackCandidate(candidates, "not-in-ladder"), null);
  assert.equal(nextFallbackCandidate([], "gemini-3.8-flash"), null);
});

// ── shouldSkipForIdempotency (all-products gate) ──────────────────────────

test("shouldSkipForIdempotency: a full product set skips; a half-produced day does NOT", () => {
  // 2026-10-30 P2: keying the idempotency skip on AI.md alone permanently
  // orphaned days where GitHub.md was lost to a mid-run crash — every retry
  // exited 0 before checkProducts ever ran.
  const dir = tmpDir();
  assert.equal(shouldSkipForIdempotency(dir, false), false, "nothing on disk → run");
  fs.writeFileSync(path.join(dir, "AI.md"), "# AI 日报\n内容", "utf-8");
  assert.equal(shouldSkipForIdempotency(dir, false), false, "AI.md alone is a half-produced day → still run");
  fs.writeFileSync(path.join(dir, "GitHub.md"), "# GitHub\n内容", "utf-8");
  assert.equal(shouldSkipForIdempotency(dir, false), true, "every product present → skip");
  fs.writeFileSync(path.join(dir, "GitHub.md"), "", "utf-8");
  assert.equal(shouldSkipForIdempotency(dir, false), false, "a 0-byte product is not a product");
});

// ── checkProducts ─────────────────────────────────────────────────────────

test("checkProducts: daily mode reports both products, marking missing ones", () => {
  const dir = tmpDir();
  const before = checkProducts(dir, false);
  assert.deepEqual(before.map((p) => p.name), ["AI.md", "GitHub.md"]);
  assert.ok(before.every((p) => p.ok === false));
  assert.ok(before.every((p) => p.size === 0));

  fs.writeFileSync(path.join(dir, "AI.md"), "# AI 日报\n内容", "utf-8");
  const after = checkProducts(dir, false);
  const ai = after.find((p) => p.name === "AI.md");
  const gh = after.find((p) => p.name === "GitHub.md");
  assert.equal(ai.ok, true);
  assert.ok(ai.size > 0);
  assert.equal(gh.ok, false);
});

test("checkProducts: weekly mode uses the -周报 names", () => {
  const dir = tmpDir();
  const products = checkProducts(dir, true);
  assert.deepEqual(products.map((p) => p.name), ["AI-周报.md", "GitHub-周报.md"]);
});

test("checkProducts: an empty (0-byte) file is NOT a usable product", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "AI.md"), "", "utf-8");
  const products = checkProducts(dir, false);
  assert.equal(products.find((p) => p.name === "AI.md").ok, false);
});

// ── rotateLog ─────────────────────────────────────────────────────────────

test("rotateLog: renames the active log to a dated .stale archive", () => {
  const dir = tmpDir();
  const logPath = path.join(dir, "task.out.log");
  fs.writeFileSync(logPath, "line before rotation\n", "utf-8");

  rotateLog(logPath, 20);

  assert.equal(fs.existsSync(logPath), false, "active log is moved aside");
  const stales = fs.readdirSync(dir).filter((f) => /^task\.out\.log\.stale-\d{8}$/.test(f));
  assert.equal(stales.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, stales[0]), "utf-8"), "line before rotation\n");
});

test("rotateLog: prunes archives beyond the keep count, oldest first", () => {
  const dir = tmpDir();
  const logPath = path.join(dir, "task.err.log");
  fs.writeFileSync(logPath, "active\n", "utf-8");

  // Equal atimes on purpose: the date embedded in the name, not atime, must drive
  // the order. (Windows commonly does not maintain atime, which made the old atime
  // sort arbitrary and could delete a fresh archive before an old one.)
  const sameAtime = new Date("2020-06-01T00:00:00Z");
  const oldest = path.join(dir, "task.err.log.stale-20200101");
  const newer = path.join(dir, "task.err.log.stale-20200102");
  fs.writeFileSync(oldest, "old\n", "utf-8");
  fs.writeFileSync(newer, "mid\n", "utf-8");
  fs.utimesSync(oldest, sameAtime, sameAtime);
  fs.utimesSync(newer, sameAtime, sameAtime);

  rotateLog(logPath, 2); // today's archive + 1 survive

  const stales = fs.readdirSync(dir).filter((f) => f.startsWith("task.err.log.stale-"));
  assert.equal(stales.length, 2, "pruned down to the keep count");
  assert.equal(fs.existsSync(oldest), false, "the oldest archive was deleted");
  assert.equal(fs.existsSync(newer), true, "the newer archive survived");
});

// Same-day retry: the second rotation must NOT clobber the archive taken at the
// first fire (Windows renameSync to an existing target throws; the old code
// swallowed that and left the active log un-rotated). Assert a sequenced suffix.
test("rotateLog: a same-day re-rotation never overwrites the earlier archive", () => {
  const dir = tmpDir();
  const logPath = path.join(dir, "task.out.log");
  fs.writeFileSync(logPath, "first run\n", "utf-8");
  rotateLog(logPath, 20);
  const first = fs.readdirSync(dir).filter((f) => /^task\.out\.log\.stale-\d{8}$/.test(f));
  assert.equal(first.length, 1, "first archive is the bare date name");
  assert.equal(fs.readFileSync(path.join(dir, first[0]), "utf-8"), "first run\n", "first archive kept its content");

  fs.writeFileSync(logPath, "second run\n", "utf-8");
  rotateLog(logPath, 20);
  const all = fs.readdirSync(dir).filter((f) => f.startsWith("task.out.log.stale-"));
  assert.equal(all.length, 2, "second archive kept alongside the first");
  const suffixed = all.find((f) => /^task\.out\.log\.stale-\d{8}-2$/.test(f));
  assert.ok(suffixed, "suffixed -2 archive created for the same-day retry");
  assert.equal(fs.readFileSync(path.join(dir, suffixed), "utf-8"), "second run\n", "the retry's log is the one archived");
  assert.equal(fs.existsSync(logPath), false, "active log moved aside both times");
});

// The seq suffix is part of the sort key so a same-day "-2" sorts after the bare
// archive, and older dates always before newer regardless of directory order.
test("rotateLog: sorts same-day archives by sequence, not by readdir order", () => {
  const dir = tmpDir();
  const logPath = path.join(dir, "task.out.log");
  for (const f of [
    "task.out.log.stale-20200103",
    "task.out.log.stale-20200101",
    "task.out.log.stale-20200102-7",
    "task.out.log.stale-20200102",
  ]) {
    fs.writeFileSync(path.join(dir, f), f, "utf-8");
  }
  fs.writeFileSync(logPath, "active\n", "utf-8");

  // Keys: 0101, 0102-1, 0102-7, 0103, <today>. keep=2 → 0101 + 0102-1 + 0102-7 go.
  rotateLog(logPath, 2);

  assert.equal(fs.existsSync(path.join(dir, "task.out.log.stale-20200101")), false, "oldest date pruned first");
  assert.equal(fs.existsSync(path.join(dir, "task.out.log.stale-20200102")), false, "bare 0102 (seq 1) pruned before its -7 sibling");
  assert.equal(fs.existsSync(path.join(dir, "task.out.log.stale-20200102-7")), false, "same-day -7 pruned before the newer date");
  assert.equal(fs.existsSync(path.join(dir, "task.out.log.stale-20200103")), true, "newest date kept");
});

test("rotateLog: a missing log is a no-op (first run ever)", () => {
  const dir = tmpDir();
  assert.doesNotThrow(() => rotateLog(path.join(dir, "never.log"), 20));
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ── probeModel ────────────────────────────────────────────────────────────

test("probeModel: a 200 with a body is reachable, and hits /chat/completions", async () => {
  let seen = null;
  const result = await withFetch(
    async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => "data: pong" };
    },
    () => probeModel("https://gw.example/v1", "sk-test", "gemini-3.6-flash"),
  );
  assert.equal(result.reachable, true);
  assert.equal(result.error, null);
  assert.equal(seen.url, "https://gw.example/v1/chat/completions");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, "gemini-3.6-flash");
  assert.equal(body.max_tokens, 8);
});

test("probeModel: a 500 is unreachable with the status in the error", async () => {
  const result = await withFetch(
    async () => ({ ok: false, status: 500, text: async () => "boom" }),
    () => probeModel("https://gw.example/v1", "sk-test", "m"),
  );
  assert.equal(result.reachable, false);
  assert.equal(result.status, 500);
  assert.equal(result.error, "HTTP 500");
});

test("probeModel: a 200 with an empty body is NOT reachable (free-block guard)", async () => {
  const result = await withFetch(
    async () => ({ ok: true, status: 200, text: async () => "" }),
    () => probeModel("https://gw.example/v1", "sk-test", "m"),
  );
  assert.equal(result.reachable, false);
  assert.equal(result.error, "HTTP 200");
});

test("probeModel: an aborted request reports timeout, not a raw stack", async () => {
  const result = await withFetch(
    async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    },
    () => probeModel("https://gw.example/v1", "sk-test", "m"),
  );
  assert.equal(result.reachable, false);
  assert.equal(result.error, "timeout");
});

// ── probeLadder ───────────────────────────────────────────────────────────

test("probeLadder: skips a dead model and returns the first live one", async () => {
  const calls = [];
  const result = await withFetch(
    async (url, init) => {
      const model = JSON.parse(init.body).model;
      calls.push(model);
      if (model === "dead-model") return { ok: false, status: 502, text: async () => "nope" };
      return { ok: true, status: 200, text: async () => "data: pong" };
    },
    () => probeLadder("https://gw.example/v1", "sk-test", ["dead-model", "live-model"]),
  );
  assert.equal(result.model, "live-model");
  assert.equal(result.error, null);
  assert.deepEqual(calls, ["dead-model", "live-model"], "probed in ladder order until one worked");
});

test("probeLadder: all candidates dead → model null with the last error", async () => {
  const result = await withFetch(
    async () => ({ ok: false, status: 503, text: async () => "down" }),
    () => probeLadder("https://gw.example/v1", "sk-test", ["a", "b"]),
  );
  assert.equal(result.model, null);
  assert.equal(result.error.error, "HTTP 503");
});

// ── probeCandidates ────────────────────────────────────────────────────────

test("probeCandidates: drops known-bad writers, dedupes, and keeps ladder order", () => {
  const config = {
    synthModel: "gemini-3.6-flash",
    synthFallbackModel: "grok-4.5",
    searchModel: "gemini-3.6-flash", // duplicate of the primary
    aiAltModel: "gpt-5.6-luna", // known-bad
  };
  assert.deepEqual(probeCandidates(config), ["gemini-3.6-flash", "grok-4.5"]);
  assert.ok(KNOWN_BAD_MODELS.includes("gpt-5.6-luna"), "test fixture must use a real known-bad model");
});

test("probeCandidates: includes the search model in the ladder (spec 4.1)", () => {
  const config = {
    synthModel: "m-primary",
    synthFallbackModel: "m-fallback",
    searchModel: "m-search",
    aiAltModel: null,
  };
  assert.deepEqual(probeCandidates(config), ["m-primary", "m-fallback", "m-search"]);
});

test("probeCandidates: all known-bad → empty ladder (no writer to probe at all)", () => {
  const config = {
    synthModel: "gpt-5.6-luna",
    synthFallbackModel: "gpt-5.6-luna",
    searchModel: "gpt-5.6-luna",
    aiAltModel: null,
  };
  assert.deepEqual(probeCandidates(config), []);
});

// ── PROBE_TIMEOUT_MS ──────────────────────────────────────────────────────

test("PROBE_TIMEOUT_MS: the per-model probe ceiling satisfies the ≥120s spec", () => {
  // The gateway's Cloudflare proxy 524s at ~120s. A ceiling below that would abort
  // a slow-but-alive gateway as unreachable (PROBE-FAIL exit 16) right before it
  // would have answered — exactly the false-negative this constant exists to avoid.
  assert.ok(PROBE_TIMEOUT_MS >= 120_000, `PROBE_TIMEOUT_MS=${PROBE_TIMEOUT_MS} must sit above the CF ~120s cap`);
  assert.equal(PROBE_TIMEOUT_MS, 180_000, "spec §8 pins the probe timeout at 180s");
});

// ── spawnRunner (stall watchdog) ──────────────────────────────────────────

// spawnRunner launches through a shell (`shell: true`), so the child program is
// passed as a real script file rather than `-e <code>` — the shell would split an
// inline code string on its spaces. The script path itself has no spaces under
// $TMPDIR, matching the production run.mjs path.
function writeChildScript(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

test("spawnRunner: kills a child that outlives stallCeilMs without producing the watch file", async () => {
  const dir = tmpDir();
  const watchPath = path.join(dir, "AI.md");
  const sleepScript = writeChildScript(dir, "sleep.mjs", "setTimeout(() => {}, 2000);\n");
  // A child that never writes AI.md must be killed by the watchdog — this is the
  // "singleton-lock heartbeat would keep every later day refused" case the kill
  // exists for. It exits on its own at 2s, so the test neither orphans nor hangs.
  const result = await spawnRunner(
    process.execPath,
    sleepScript,
    [],
    path.join(dir, "out.log"),
    path.join(dir, "err.log"),
    { watchPath, stallCeilMs: 300 },
  );
  assert.equal(result.stalled, true, "the watchdog must flag the stall");
  assert.notEqual(result.code, 0, "a killed child settles non-zero");
  assert.match(result.stderr, /\[stall\]/, "stderr records the stall line");
  assert.equal(fs.existsSync(watchPath), false, "the child never produced the product");
});

test("spawnRunner: a child that produces the watch file is NOT stalled", async () => {
  const dir = tmpDir();
  const watchPath = path.join(dir, "AI.md");
  const script = writeChildScript(
    dir,
    "write.mjs",
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(watchPath)}, "ok");\n`,
  );
  // The child writes the product immediately, then exits. Even with a tiny stall
  // ceiling the watchdog must not fire (it checks product existence, not elapsed
  // time), so a legitimately fast run is never killed.
  const result = await spawnRunner(
    process.execPath,
    script,
    [],
    path.join(dir, "out.log"),
    path.join(dir, "err.log"),
    { watchPath, stallCeilMs: 1000 },
  );
  assert.equal(result.code, 0, "the child exited cleanly");
  assert.equal(result.stalled, false, "production of the watch file clears the stall flag");
  assert.equal(fs.readFileSync(watchPath, "utf-8"), "ok");
});

test("spawnRunner: a child that hangs AFTER producing the watch file is killed at the 2× hard cap", async () => {
  // 2026-10-30 P2: the old one-shot watchdog returned on "produced" and never
  // looked again — a hang in the poster/enrichment phase (after AI.md) ran
  // forever while its lock heartbeat refused every later day. Progress must
  // re-arm once; the hard cap then kills even a productive hang.
  const dir = tmpDir();
  const watchPath = path.join(dir, "AI.md");
  const script = writeChildScript(
    dir,
    "write-then-hang.mjs",
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(watchPath)}, "ok");\nsetTimeout(() => {}, 30000);\n`,
  );
  const result = await spawnRunner(
    process.execPath,
    script,
    [],
    path.join(dir, "out.log"),
    path.join(dir, "err.log"),
    { watchPath, stallCeilMs: 200 },
  );
  assert.equal(result.stalled, true, "the hard cap must flag the stall");
  assert.notEqual(result.code, 0, "a productive hang still settles non-zero");
  assert.match(result.stderr, /hard cap/, "stderr records the hard-cap line");
  assert.equal(fs.existsSync(watchPath), true, "the produced product survives the kill");
});

// ── probeNetworkConnectivity ─────────────────────────────────────────────

test("probeNetworkConnectivity: all healthy when endpoints respond ok", async () => {
  const result = await withFetch(
    async () => ({ ok: true, status: 200 }),
    () => probeNetworkConnectivity(100),
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "all_healthy");
});

test("probeNetworkConnectivity: detects foreign endpoint block", async () => {
  const result = await withFetch(
    async (url) => {
      if (url.includes("github.com")) throw new Error("connection timeout");
      return { ok: true, status: 200 };
    },
    () => probeNetworkConnectivity(100),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "foreign_blocked");
  assert.match(result.warning, /境外/);
});

test("probeNetworkConnectivity: detects total network down", async () => {
  const result = await withFetch(
    async () => {
      throw new Error("ENETUNREACH");
    },
    () => probeNetworkConnectivity(100),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "network_down");
  assert.match(result.warning, /完全不可达/);
});