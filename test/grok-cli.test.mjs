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
