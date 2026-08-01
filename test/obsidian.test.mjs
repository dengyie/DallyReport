import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeSection, rescueMarkdown } from "../src/obsidian.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dally-obsidian-"));
}

async function tempFiles(dir) {
  return (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));
}

test("writeSection: atomically overwrites an existing report", async () => {
  const root = await tempDir();
  const config = { obsidianDir: root, date: "2026-07-31" };

  const first = await writeSection(config, "AI", "old report");
  const second = await writeSection(config, "AI", "new report");

  assert.equal(first.error, null);
  assert.equal(second.error, null);
  assert.equal(await fs.readFile(second.file, "utf8"), "new report");
  assert.deepEqual(await tempFiles(path.dirname(second.file)), []);
});

test("writeSection: rename failure preserves the old file and cleans temp", async () => {
  const root = await tempDir();
  const config = { obsidianDir: root, date: "2026-07-31" };
  const initial = await writeSection(config, "AI", "complete old report");
  const fsImpl = {
    ...fs,
    rename: async () => {
      throw new Error("simulated rename failure");
    },
  };

  const result = await writeSection(config, "AI", "partial new report", { fsImpl });

  assert.match(result.error?.message || "", /simulated rename failure/);
  assert.equal(await fs.readFile(initial.file, "utf8"), "complete old report");
  assert.deepEqual(await tempFiles(path.dirname(initial.file)), []);
});

test("rescueMarkdown: uses the same atomic write and cleans temp on failure", async () => {
  const root = await tempDir();
  const fsImpl = {
    ...fs,
    rename: async () => {
      throw new Error("simulated rename failure");
    },
  };

  const result = await rescueMarkdown(
    { cacheDir: root, date: "2026-07-31" },
    "AI",
    "fallback report",
    { fsImpl },
  );

  assert.equal(result, null);
  assert.deepEqual(await tempFiles(root), []);
});
