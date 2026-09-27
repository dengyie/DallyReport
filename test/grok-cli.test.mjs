import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runFetch,
  redactSecrets,
  MAX_STDOUT_BYTES,
  truncateRawForParseError,
  balancedJsonObjects,
} from "../src/grok-cli.mjs";

async function fixtureSearchDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-"));
  const scripts = path.join(root, "scripts");
  await fs.mkdir(scripts, { recursive: true });
  await fs.writeFile(
    path.join(scripts, "fetch.js"),
    'process.stdout.write(JSON.stringify({content:{text:"live body"},diagnostics:{provider:"direct"}}));',
    "utf8",
  );
  return root;
}

test("runFetch: cache hit reports cache provider, file, and fromCache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-cache-"));
  const cacheFile = path.join(root, "page.txt");
  await fs.writeFile(cacheFile, "cached body", "utf8");

  const result = await runFetch(
    "https://example.com",
    { grokSearchDir: path.join(root, "missing") },
    { cacheFile },
  );

  assert.deepEqual(result, {
    text: "cached body",
    fromCache: true,
    provider: "cache",
    cacheFile,
  });
});

test("runFetch: live fetch remains successful when cache write fails", async () => {
  const grokSearchDir = await fixtureSearchDir();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-write-"));
  const cacheFile = path.join(root, "cache-is-a-directory");
  await fs.mkdir(cacheFile);

  const result = await runFetch(
    "https://example.com",
    { grokSearchDir },
    { cacheFile, provider: "direct" },
  );

  assert.equal(result.text, "live body");
  assert.equal(result.provider, "direct");
  assert.equal(result.fromCache, false);
  assert.equal(result.cacheFile, cacheFile);
  assert.equal(result.cacheWriteError?.code, "EISDIR");
  assert.match(result.cacheWriteError?.message || "", /directory/i);
});

// A fetch fixture whose body is a Cloudflare/gateway HTML error page instead of the
// real content — non-empty, so without a content gate it would be written to cache and
// replayed as a "successful" empty page on every rerun that day.
async function fixtureSearchDirBody(bodyText) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-"));
  const scripts = path.join(root, "scripts");
  await fs.mkdir(scripts, { recursive: true });
  await fs.writeFile(
    path.join(scripts, "fetch.js"),
    `process.stdout.write(JSON.stringify({content:{text:${JSON.stringify(bodyText)}},diagnostics:{provider:"direct"}}));`,
    "utf8",
  );
  return root;
}

test("runFetch: invalid body (cachePredicate false) is NOT written to cache and flags cacheSkipped", async () => {
  const grokSearchDir = await fixtureSearchDirBody("<html>error 533 from Cloudflare</html>");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-poison-"));
  const cacheFile = path.join(root, "page.txt");
  // No prior cache.
  const result = await runFetch(
    "https://example.com",
    { grokSearchDir },
    { cacheFile, provider: "direct", cachePredicate: (t) => /<trending>/.test(t) },
  );
  assert.equal(result.cacheSkipped, true, "cache write must be skipped for an invalid body");
  assert.equal(result.fromCache, false);
  // Cache file was NOT created.
  await assert.rejects(() => fs.readFile(cacheFile, "utf8"));
});

// --- stdout cap + bounded __parse_error.raw ---

test("truncateRawForParseError: small raw passes through; huge raw keeps head+tail 4KB with the marker", () => {
  assert.equal(truncateRawForParseError("short garbage"), "short garbage");
  // At the 2*4KB threshold the raw is kept whole (behavior identical under the cap).
  const edge = "y".repeat(8192);
  assert.equal(truncateRawForParseError(edge), edge);
  const big = "A".repeat(5000) + "MIDDLE" + "B".repeat(5000);
  const out = truncateRawForParseError(big);
  assert.equal(out.length, 4096 + "\n...[truncated]...\n".length + 4096);
  assert.ok(out.startsWith("A".repeat(4096)), "head 4KB kept");
  assert.ok(out.endsWith("B".repeat(4096)), "tail 4KB kept");
  assert.match(out, /\n\.\.\.\[truncated\]\.\.\.\n/);
});

// A fetch fixture whose child dumps `bytes` bytes of non-JSON garbage on stdout —
// exercises the runScript accumulation cap end-to-end (single repeat(), fast).
async function fixtureSearchDirBigStdout(bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-big-"));
  const scripts = path.join(root, "scripts");
  await fs.mkdir(scripts, { recursive: true });
  await fs.writeFile(
    path.join(scripts, "fetch.js"),
    `process.stdout.write("x".repeat(${bytes}));`,
    "utf8",
  );
  return root;
}

test("runFetch: oversized child stdout is capped at MAX_STDOUT_BYTES, flagged truncated, and parse-error raw keeps head+tail only", async () => {
  const grokSearchDir = await fixtureSearchDirBigStdout(MAX_STDOUT_BYTES + 1024 * 1024);
  await assert.rejects(
    () => runFetch("https://example.com", { grokSearchDir }, { provider: "direct" }),
    (err) => {
      assert.equal(err.truncated, true, "truncated flag set once the cap is crossed");
      assert.equal(err.stdout.length, MAX_STDOUT_BYTES, "accumulated stdout capped at 8MB");
      assert.equal(err.parseError?.__parse_error, true, "parse error surfaced on the thrown error");
      assert.equal(err.parseError.truncated, true);
      assert.ok(err.parseError.raw.length < 10 * 1024, "raw bounded to head+tail, not 8MB");
      assert.match(err.parseError.raw, /\.\.\.\[truncated\]\.\.\./);
      return true;
    },
  );
});

// ---- 2026-09-26 review: the timeout path had NO test at all ----
// The suite covered cache hits, cache-write failure, the poison-cache gate, the
// stdout cap and truncation — but never set GROK_CHILD_TIMEOUT_MS, so neither the
// `timedOut` message branch nor the SIGTERM→SIGKILL escalation was ever exercised.
// The P1 below (a grandchild holding the stdout pipe kept the promise pending
// FOREVER) would have shipped green.

async function fixtureScript(root, name, body) {
  const scripts = path.join(root, "scripts");
  await fs.mkdir(scripts, { recursive: true });
  await fs.writeFile(path.join(scripts, name), body, "utf8");
  return root;
}

test("runFetch: a hung child is killed at the timeout and the call returns", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-timeout-"));
  // Ignores SIGTERM, so only the SIGKILL backstop stops it.
  await fixtureScript(
    root,
    "fetch.js",
    'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);',
  );
  const prev = process.env.GROK_CHILD_TIMEOUT_MS;
  process.env.GROK_CHILD_TIMEOUT_MS = "400";
  try {
    const t0 = Date.now();
    let message = "";
    let timedOut = false;
    try {
      await runFetch("https://example.com", { grokSearchDir: root });
    } catch (e) {
      message = e.message;
      timedOut = e.timedOut === true;
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 8000, `不能挂死，实际 ${elapsed}ms`);
    assert.equal(timedOut, true, "标记为超时");
    assert.match(message, /超时/, "调用方被告知是超时");
  } finally {
    if (prev == null) delete process.env.GROK_CHILD_TIMEOUT_MS;
    else process.env.GROK_CHILD_TIMEOUT_MS = prev;
  }
});

test("runFetch: a grandchild holding stdout cannot keep the call pending forever", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-orphan-"));
  // The child exits immediately but leaves a detached grandchild holding the
  // inherited stdout pipe open. Node emits `close` only when every stdio pipe is
  // closed, so a promise settled solely on `close` would never resolve.
  await fixtureScript(
    root,
    "fetch.js",
    'const {spawn}=require("child_process");' +
      'spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:["ignore",1,2]});' +
      'process.exit(0);',
  );
  const prev = process.env.GROK_CHILD_TIMEOUT_MS;
  process.env.GROK_CHILD_TIMEOUT_MS = "500";
  try {
    const t0 = Date.now();
    // Either outcome is fine — the point is that it settles at all. Before the
    // fix the promise stayed pending indefinitely, so the race returned HUNG.
    const settled = await Promise.race([
      runFetch("https://example.com", { grokSearchDir: root }).then(
        () => "settled",
        () => "settled",
      ),
      new Promise((r) => setTimeout(() => r("HUNG"), 8000)),
    ]);
    const elapsed = Date.now() - t0;
    assert.equal(settled, "settled", `the call must settle, not hang (took ${elapsed}ms)`);
  } finally {
    if (prev == null) delete process.env.GROK_CHILD_TIMEOUT_MS;
    else process.env.GROK_CHILD_TIMEOUT_MS = prev;
  }
});

test("runFetch: noisy stdout around the JSON payload is tolerated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-noisy-"));
  await fixtureScript(
    root,
    "fetch.js",
    'console.log("Fetching https://example.com ...");' +
      'console.log("done in 2.3s");' +
      'process.stdout.write(JSON.stringify({content:{text:"REAL BODY"}}));',
  );
  const res = await runFetch("https://example.com", { grokSearchDir: root });
  assert.equal(res.text, "REAL BODY", "真实的 JSON 载荷仍被解析出来");
});

test("runFetch: a child error message does not carry a secret through", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-secret-"));
  await fixtureScript(
    root,
    "fetch.js",
    'process.stderr.write("auth failed api_key=sk-live-LEAKME-12345678\\n");process.exit(1);',
  );
  let message = "";
  try {
    await runFetch("https://example.com", { grokSearchDir: root });
  } catch (e) {
    message = e.message;
  }
  assert.doesNotMatch(message, /sk-live-LEAKME/, "the secret must be redacted");
  assert.match(message, /已脱敏/, "the message says it was redacted");
});

// ---------------------------------------------------------------------------
// 2026-09-27 四轮复审 P0：脱敏白名单陈旧 + 裸 Bearer 未拦。
//
// round-3 用的是**手写 5 个变量名**的白名单。白名单第一天就是陈旧的：IMAGE_API_KEY
// 是本项目一等必填 key（config.mjs 的 imageApiKey() 会回落到 GROK_API_KEY），却根本
// 不在名单里；.env 里其它任何 key 同样漏网——名单只覆盖「有人想起来加」的变量。
// 通用正则也救不了：它要求 key=/token= 前缀，而子进程回显**裸凭证**时没有前缀。
// ---------------------------------------------------------------------------

test("redactSecrets: consults the ENVIRONMENT, not a hand-kept variable list", () => {
  // The regression that mattered: a secret the list never named. If the redactor
  // only reads a fixed set of names, adding a new key to .env silently leaks.
  const env = {
    PATH: "/usr/bin",
    HOME: "/Users/mango",
    GROK_API_KEY: "sk-grok-AAAABBBBCCCCDDDD",
    IMAGE_API_KEY: "sk-image-EEEFFFFFGGGGHHHH",
    SOME_BRAND_NEW_TOKEN_I_ADDED_LATER: "tok-1111222233334444",
    ANTHROPIC_API_KEY: "sk-antro-ZZZZYYYYXXXXWWWW",
  };
  const out = redactSecrets(
    "upstream rejected credential sk-image-EEEFFFFFGGGGHHHH and tok-1111222233334444",
    env,
  );
  assert.ok(!out.includes("EEEFFFFFGGGGHHHH"), "IMAGE_API_KEY must be redacted");
  assert.ok(!out.includes("1111222233334444"), "an unknown future token must be redacted");
  assert.match(out, /\[IMAGE_API_KEY 已脱敏\]/);
  assert.match(out, /\[SOME_BRAND_NEW_TOKEN_I_ADDED_LATER 已脱敏\]/);
});

test("redactSecrets: a bare Bearer credential is redacted (no separator)", () => {
  // Round-3's regex required [=:] AFTER the label, so `bearer`/`authorization`
  // were in the alternation but unreachable — and "Bearer <tok>" is the single
  // most likely shape for an auth failure to print into stderr.
  const out = redactSecrets("Authorization: Bearer ghs_16C7e42F292c6912E7660c839347Ae", {});
  assert.ok(!out.includes("ghs_16C7e42F292c6912E7660c839347Ae"), out);
  for (const raw of [
    "Bearer ghs_16C7e42F292c6912E7660c839347Ae",
    "authorization: Basic dXNlcjpwYXNzd29yZDEyMw==",
    "X-Grok-Key: xai-9f2b7c1d4e6a8b0c2d4e6f8a0b2c4d6e",
    "apiKey sk-live-LEAK-12345678",
    "cookie: _t_uid=abc123def456ghi789",
  ]) {
    const r = redactSecrets(raw, {});
    assert.ok(!/ghs_16C7e42|xai-9f2b7c1d|sk-live-LEAK|abc123def456ghi789/.test(r), `LEAKED: ${r}`);
  }
});

test("redactSecrets: does not destroy useful diagnostics", () => {
  // Over-redaction would be its own outage: an operator staring at
  // "检索失败：Error" learns nothing. Keep the human-useful parts.
  for (const raw of [
    "token count=12345 exceeded the context window",
    "usage: prompt tokens 1234567, completion 89012",
    "grok-search fetch.js 退出码 1：no stdout",
    "getaddrinfo ENOTFOUND api.example.com",
    "HTTP 524 upstream timeout after 20000ms",
  ]) {
    assert.equal(redactSecrets(raw, {}), raw, `diagnostic was mangled: ${raw}`);
  }
});

test("runFetch: a secret echoed to stderr does not reach the thrown Error", async () => {
  // End-to-end, through the real child: the property that actually matters is
  // not "redactSecrets works" but "no secret reaches the error a caller holds".
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-secret-"));
  const key = "sk-image-E2ELEAK99887766554433";
  await fixtureScript(
    root,
    "fetch.js",
    `process.stderr.write("upstream rejected credential ${key}\\n");process.exit(3);`,
  );
  const prev = process.env.IMAGE_API_KEY;
  process.env.IMAGE_API_KEY = key;
  try {
    let caught = null;
    try {
      await runFetch("https://example.com", { grokSearchDir: root });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "the failing fetch must throw");
    const text = `${caught.message}\n${caught.stderr || ""}`;
    assert.ok(!text.includes(key), `secret leaked into the error: ${text}`);
  } finally {
    if (prev == null) delete process.env.IMAGE_API_KEY;
    else process.env.IMAGE_API_KEY = prev;
  }
});

// ---------------------------------------------------------------------------
// 2026-09-27 review (round 4) P1-3: process containment.
//
// runScript kills only the DIRECT child. Verified: a grandchild that inherits
// stdio survives the parent's SIGTERM as a live orphan (grandchild pid alive,
// parent dead). `child.kill(sig)` signals one pid; it is not a group kill. On
// the timeout path that orphan keeps running for the rest of the day, and on
// the normal path any long-lived grandchild a grok-search dependency spawns
// outlives the report entirely.
//
// `killAllChildren` (child-tracker.mjs) has the same one-pid limitation, so
// reaping on interrupt does not cover it either.
// ---------------------------------------------------------------------------

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function readPid(file) {
  return Number((await fs.readFile(file, "utf8")).trim());
}

test("runFetch: the timeout kills the whole process group, not just the direct child", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-group-"));
  const gcPidFile = path.join(root, "gc.pid");
  // The child records ITS OWN pid from inside a grandchild, so what we check is
  // genuinely a grandchild of the node process under test.
  await fixtureScript(
    root,
    "fetch.js",
    `const{spawn}=require("child_process");
     spawn(process.execPath,["-e",\`require("fs").writeFileSync(${JSON.stringify(gcPidFile)},String(process.pid));setTimeout(()=>{},120000)\`],{stdio:"ignore"});
     process.on("SIGTERM",()=>{}); // force the group-kill path to do the work
     setInterval(()=>{},1000);`,
  );
  const prev = process.env.GROK_CHILD_TIMEOUT_MS;
  process.env.GROK_CHILD_TIMEOUT_MS = "600";
  let gcPid = null;
  try {
    await runFetch("https://example.com", { grokSearchDir: root }).catch(() => {});
    // The grandchild writes its pid asynchronously; give it a moment.
    for (let i = 0; i < 40 && gcPid === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        gcPid = await readPid(gcPidFile);
      } catch {
        /* not written yet */
      }
    }
    assert.ok(gcPid, "the grandchild never started, so this test proves nothing");
    // Let the group kill land.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      isAlive(gcPid),
      false,
      `grandchild ${gcPid} survived the timeout as an orphan — only the direct child was signalled`,
    );
  } finally {
    if (gcPid && isAlive(gcPid)) {
      try {
        process.kill(gcPid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    if (prev == null) delete process.env.GROK_CHILD_TIMEOUT_MS;
    else process.env.GROK_CHILD_TIMEOUT_MS = prev;
  }
});

test("runFetch: child stderr is capped like stdout", async () => {
  // Verified: an uncapped stderr listener accumulated 50 MiB from a single child,
  // against MAX_STDOUT_BYTES = 8 MiB for stdout. stdout is capped precisely
  // because "a child can print without bound"; stderr was exempt for no reason
  // that survives a child that loops on a warning.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-errcap-"));
  await fixtureScript(
    root,
    "fetch.js",
    `const chunk="X".repeat(64*1024);let n=0;
     const t=setInterval(()=>{n+=chunk.length;process.stderr.write(chunk);
       if(n>=${20 * 1024 * 1024}){clearInterval(t);process.exit(1);}},0);`,
  );
  const prev = process.env.GROK_CHILD_TIMEOUT_MS;
  process.env.GROK_CHILD_TIMEOUT_MS = "20000";
  let err = null;
  try {
    await runFetch("https://example.com", { grokSearchDir: root }).catch((e) => {
      err = e;
    });
    assert.ok(err, "the failing child must throw");
    assert.ok(
      err.stderr.length <= MAX_STDOUT_BYTES,
      `stderr grew unbounded: ${err.stderr.length} bytes (stdout cap is ${MAX_STDOUT_BYTES})`,
    );
  } finally {
    if (prev == null) delete process.env.GROK_CHILD_TIMEOUT_MS;
    else process.env.GROK_CHILD_TIMEOUT_MS = prev;
  }
});

// ---------------------------------------------------------------------------
// 2026-09-27 review (round 4) P2-6: the JSON extractor picked the WRONG object.
//
// extractLastJsonObject started from `lastIndexOf("}")` and returned the single
// balanced object ending there. A trailing debug line carrying its own braces
// therefore beat the real payload:
//
//   {content:{text:"REAL PAYLOAD"},...}\nDEBUG {level: info, ts: 1}
//   -> picked {level: info, ts: 1}
//
// The whole fetch then reported an error on an otherwise-successful child. The
// old comment claimed this function existed to make noise HARMLESS; it was noise
// in one direction only. Note the debug object is unquoted JS, so it does not
// even parse as JSON — the original code never noticed, because it never tried.
// ---------------------------------------------------------------------------

test("runFetch: a trailing debug line with braces does not hijack the payload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-json-"));
  await fixtureScript(
    root,
    "fetch.js",
    `process.stdout.write(JSON.stringify({content:{text:"REAL PAYLOAD"},diagnostics:{provider:"direct"}}));
     process.stdout.write("\\nDEBUG {level: info, ts: 1}");`,
  );
  const r = await runFetch("https://example.com", { grokSearchDir: root });
  assert.equal(r.text, "REAL PAYLOAD", "the real payload must win over a trailing noise object");
});

test("runFetch: a leading debug line with braces does not hijack the payload", async () => {
  // The direction the original function was written for — both must hold.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-grok-json2-"));
  await fixtureScript(
    root,
    "fetch.js",
    `process.stdout.write("DEBUG {level: info, ts: 1}\\n");
     process.stdout.write(JSON.stringify({content:{text:"REAL PAYLOAD"},diagnostics:{provider:"direct"}}));`,
  );
  const r = await runFetch("https://example.com", { grokSearchDir: root });
  assert.equal(r.text, "REAL PAYLOAD");
});

test("balancedJsonObjects: yields each top-level object exactly once, noise excluded", async () => {
  const { balancedJsonObjects } = await import("../src/grok-cli.mjs");
  const objs = [...balancedJsonObjects('{"a":1} junk {"b":"} not a brace {"} {"c":3}')];
  assert.deepEqual(objs, ['{"a":1}', '{"b":"} not a brace {"}', '{"c":3}']);
  // A stray close brace in noise must not produce a candidate.
  assert.deepEqual([...balancedJsonObjects("} } }")], []);
  assert.deepEqual([...balancedJsonObjects("no braces here")], []);
});
