import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Integration tests that actually execute src/run.mjs as a child process, so the
// entry file's own wiring is exercised — not just the units it imports.
//
// Why this file exists: commit 8d35db1 wired the singleton lock with
// `path.join(config.cacheDir, "run.lock")` in run.mjs but never imported `path`,
// so every non-`--help` run died with `ReferenceError: path is not defined` at
// that line before any section ran. lock.test.mjs could not catch it: it imports
// `node:path` itself and only unit-tests acquireSingletonLock, so a missing
// top-of-file import in run.mjs is structurally invisible to it. These tests
// spawn the real entry and assert on its exit path, so a missing import (or any
// other break between argv parsing and the lock) fails loudly.
//
// They are cheap and side-effect-free: the `--section <bogus>` gate sits AFTER
// the lock acquisition (run.mjs), so the child exits at the gate — no network,
// no synthesis, no vault writes, no posters. The lock is created and released
// within the child's own exit handler.

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ENTRY = path.join(PROJECT_ROOT, "src", "run.mjs");
const LOCK_PATH = path.join(PROJECT_ROOT, "reports-cache", "run.lock");

function runCli(args) {
  return spawnSync(process.execPath, [RUN_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("run.mjs: reaches the singleton lock and the section gate (missing `import path` would die here)", () => {
  // The unknown-section gate (exit 2) sits after the lock acquisition at
  // run.mjs:118. If `import path` were missing, the child would throw
  // ReferenceError at `path.join(config.cacheDir, "run.lock")` and exit(1) with
  // "运行失败: path is not defined" — never reaching the gate. So exit 2 + the
  // gate message proves the lock line executed.
  const r = runCli(["--section", "__no_such_section__"]);
  assert.equal(r.status, 2, `expected exit 2 (unknown section), got ${r.status}`);
  assert.match(r.stderr, /未知 section/, "stderr names the unknown section");
  assert.doesNotMatch(r.stderr, /path is not defined/, "no ReferenceError from the lock line");
});

test("run.mjs: a live lock held by another PID is refused (exit 0, 已有实例在运行)", () => {
  // Simulate another in-flight run: a fresh lock file holding OUR (test) PID.
  // The child sees a live, fresh holder that is not itself and must refuse with
  // exit 0 — the singleton guard actually firing through the real entry file.
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.writeFileSync(LOCK_PATH, `${process.pid}\n${new Date().toISOString()}\n`);
  try {
    const r = runCli(["--section", "ai"]);
    assert.equal(r.status, 0, `expected exit 0 (refused), got ${r.status}`);
    assert.match(r.stderr, /已有实例在运行/, "stderr reports the singleton refusal");
  } finally {
    fs.rmSync(LOCK_PATH, { force: true });
  }
});
