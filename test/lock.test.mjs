import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireSingletonLock, isPidAlive } from "../src/lock.mjs";

// Helper: a temp directory for lock files.
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dally-lock-"));
}

test("acquireSingletonLock: free path -> success, lock file exists, release removes it", () => {
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  const lock = acquireSingletonLock(lp);
  assert.equal(lock.error, undefined, "no error on free acquire");
  assert.ok(typeof lock.release === "function", "lock has release()");
  // Lock file was written with our PID.
  const content = fs.readFileSync(lp, "utf8");
  const pid = Number(content.split("\n")[0]);
  assert.equal(pid, process.pid, "lock file records our PID");
  // Release removes the file.
  lock.release();
  assert.equal(fs.existsSync(lp), false, "lock file removed after release");
});

test("acquireSingletonLock: release does NOT remove a lock another PID now owns", () => {
  // After an age-based takeover the file holds a different PID. Our release must
  // leave that lock alone (its holder is still running); deleting it would let a
  // third process in.
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  const lock = acquireSingletonLock(lp);
  assert.equal(lock.error, undefined);
  // Simulate a takeover: overwrite the lock with another process's PID.
  fs.writeFileSync(lp, `424242\n${new Date().toISOString()}\n`);
  lock.release();
  assert.equal(fs.existsSync(lp), true, "another PID's lock is preserved on our release");
});

test("acquireSingletonLock: held by another live PID -> error", () => {
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  // Write a lock file holding a PID that is NOT our own, and inject isAlive that
  // confirms it lives. (Writing our own PID would be treated as "us" and taken
  // over — that's the separate self-PID test below.) The timestamp must be recent:
  // a hardcoded past date would age past the staleness window and flip this into
  // a take-over regardless of the live PID.
  fs.writeFileSync(lp, `424242\n${new Date(Date.now() - 1000).toISOString()}\n`);
  const lock = acquireSingletonLock(lp, { isAlive: () => true });
  assert.ok(lock.error, "should refuse when lock is held by a live PID");
  assert.match(lock.error, /实例/, "error message in Chinese");
  // Lock file preserved (not removed on refusal).
  assert.equal(fs.existsSync(lp), true, "lock file not removed on refusal");
});

test("acquireSingletonLock: stale lock (dead PID) -> taken over", () => {
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  // Write a lock with a nonexistent PID (999999 is unrealistically high).
  fs.writeFileSync(lp, "999999\n2026-08-09T00:00:00.000Z\n");
  const lock = acquireSingletonLock(lp, { isAlive: () => false });
  assert.equal(lock.error, undefined, "stale lock is taken over, not refused");
  // Lock file now holds our PID.
  const content = fs.readFileSync(lp, "utf8");
  const pid = Number(content.split("\n")[0]);
  assert.equal(pid, process.pid, "lock file updated to our PID");
  lock.release();
});

test("acquireSingletonLock: our own PID in the lock file -> taken over (no crash)", () => {
  // Edge case: if the lock file from a previous run still exists and holds
  // our PID (e.g., was already here when we started), we should take over
  // rather than refuse ourselves.
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  fs.writeFileSync(lp, `${process.pid}\n2026-08-09T00:00:00.000Z\n`);
  const lock = acquireSingletonLock(lp, { isAlive: () => true });
  // isAlive returns true, but pid === process.pid, so we take over.
  assert.equal(lock.error, undefined, "our own PID is treated as stale");
  lock.release();
});

test("acquireSingletonLock: very old lock with a live PID -> taken over (age-based)", () => {
  // The PID-reuse trap: after a reboot an old lock's PID may resolve to an unrelated
  // live process. isAlive says the holder lives, but the lock is older than
  // MAX_LOCK_AGE_MS — a crash leftover — so the age wins and we take over.
  // 24h ago gives huge margin over the default 30min ceiling. (A timestamp exactly
  // on the boundary is flaky: if write and check land in the same millisecond, age
  // == MAX and the strict `>` fails — a near-boundary fixture, not a staleness case.)
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  fs.writeFileSync(lp, `424242\n${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}\n`);
  const lock = acquireSingletonLock(lp, { isAlive: () => true });
  assert.equal(lock.error, undefined, "an old lock is taken over even with a live PID");
  const content = fs.readFileSync(lp, "utf8");
  assert.equal(Number(content.split("\n")[0]), process.pid, "lock updated to our PID");
  lock.release();
});

test("acquireSingletonLock: empty lock file (no PID written) -> taken over", () => {
  // If the holder died between the O_EXCL create and writing the PID, the lock file
  // is empty. Number('') is 0, and process.kill(0, 0) probes the process GROUP
  // (which always exists) — so a 0 PID must be handled as stale, never as a live
  // holder. Uses the real isAlive to prove the guard beats process.kill(0, 0).
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  fs.writeFileSync(lp, "");
  const lock = acquireSingletonLock(lp);
  assert.equal(lock.error, undefined, "empty lock file is taken over");
  const content = fs.readFileSync(lp, "utf8");
  assert.equal(Number(content.split("\n")[0]), process.pid, "lock updated to our PID");
  lock.release();
});

test("acquireSingletonLock: no timestamp + live PID -> refused (conservative)", () => {
  // A lock with no readable timestamp (old/corrupt format) can't be age-bounded, so
  // we fall back to the PID probe: a live holder refuses, a dead one is taken over.
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  fs.writeFileSync(lp, "424242\n\n");
  const lock = acquireSingletonLock(lp, { isAlive: () => true });
  assert.ok(lock.error, "pid-only lock with a live holder is refused");
  assert.equal(fs.existsSync(lp), true, "lock preserved on refusal");
});

test("isPidAlive: returns true for our own process", () => {
  assert.ok(isPidAlive(process.pid), "our PID is alive");
});

test("isPidAlive: returns false for a nonexistent PID", () => {
  // 999999 is almost certainly unused on any real system.
  assert.equal(isPidAlive(999999), false, "nonexistent PID is not alive");
});