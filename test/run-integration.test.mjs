import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDirSync } from "./helpers/tmp.mjs";

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

// Isolation (2026-09-25 review root fix): the child previously used the PRODUCTION
// reports-cache/run.lock — the fake-lock test's `rmSync` could delete a live
// scheduled run's lock (admitting a second concurrent writer), and a live 09:00
// run holding the lock made these tests fail the other way. config.mjs honors
// CACHE_DIR, so point the child at a per-file temp cache dir instead.
const CACHE_DIR = tmpDirSync("dally-integration-cache-");
after(() => fs.rmSync(CACHE_DIR, { recursive: true, force: true }));
const LOCK_PATH = path.join(CACHE_DIR, "run.lock");

function runCli(args) {
  return spawnSync(process.execPath, [RUN_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CACHE_DIR },
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

// ---------------------------------------------------------------------------
// 2026-09-28 weekly: --mode selects the report period. The validation gate must
// sit BEFORE the lock and before any section, exactly like --section: an
// operator typo (`--mode weekley`) must cost a message and exit 2, never a
// half-run that burns LLM calls or writes a wrong-dated note into the vault.
// ---------------------------------------------------------------------------

test("run.mjs: --mode rejects an unknown value with exit 2 before any work", () => {
  // `--section` is deliberately bogus. The mode gate must fire BEFORE the
  // section gate, so the mode error is the one that surfaces — and naming a
  // real section here would make a missing mode gate start a genuine run
  // (network, LLM, vault write) inside the test, which is exactly what this
  // file exists to avoid. First written with `--section ai`, it started one.
  const r = runCli(["--mode", "weekley", "--section", "__no_such_section__"]);
  assert.equal(r.status, 2, `expected exit 2 (unknown mode), got ${r.status}`);
  assert.match(r.stderr, /未知 mode/, "stderr names the unknown mode");
  assert.match(r.stderr, /daily/, "stderr lists the valid modes");
  assert.doesNotMatch(r.stderr, /未知 section/, "the mode gate fires before the section gate");
  assert.doesNotMatch(r.stderr, /已有实例在运行/, "must fail before the lock, not after");
});

test("run.mjs: --mode accepts daily and weekly and still reaches the section gate", () => {
  // Reaching the known section's gate means argv parsing, the mode validation,
  // config loading and the lock all ran without throwing. `--section` stays
  // bogus on purpose so the child exits 2 there rather than starting a real run.
  for (const mode of ["daily", "weekly", "auto"]) {
    const r = runCli(["--mode", mode, "--section", "__no_such_section__"]);
    assert.equal(r.status, 2, `--mode ${mode}: expected exit 2 at the section gate, got ${r.status}`);
    assert.match(r.stderr, /未知 section/, `--mode ${mode}: reached the section gate`);
    assert.doesNotMatch(r.stderr, /未知 mode/, `--mode ${mode}: mode itself validated`);
  }
});

test("run.mjs: --help documents --mode", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--mode/);
});
