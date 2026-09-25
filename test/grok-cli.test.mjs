import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFetch, MAX_STDOUT_BYTES, truncateRawForParseError } from "../src/grok-cli.mjs";

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
