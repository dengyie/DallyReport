import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFetch } from "../src/grok-cli.mjs";

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
