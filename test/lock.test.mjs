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

test("acquireSingletonLock: live PID + fresh heartbeat -> refused (never steal from a live run)", () => {
  // 2026-09-25 review root fix: the old pure wall-age rule let a second launcher
  // take over a LIVE run once the run outlasted the ceiling. A fresh heartbeat
  // proves the holder is alive and working — refusal is unconditional while the
  // beat is fresh, regardless of how long the run has been going.
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  const now = new Date().toISOString();
  fs.writeFileSync(lp, `424242\n${now}\n${now}\n`);
  const lock = acquireSingletonLock(lp, { isAlive: () => true });
  assert.ok(lock.error, "fresh heartbeat + live PID must be refused");
  assert.equal(fs.existsSync(lp), true, "lock preserved on refusal");
});

test("acquireSingletonLock: live PID + stale heartbeat -> taken over (crashed run, PID reused)", () => {
  // The heartbeat is the freshest evidence the holder lived. 10 minutes of
  // silence (> the 5min default ceiling) means the holder's heart stopped —
  // a crash leftover whose PID may now belong to an unrelated process.
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  fs.writeFileSync(
    lp,
    `424242\n${new Date(Date.now() - 11 * 60 * 1000).toISOString()}\n${new Date(Date.now() - 10 * 60 * 1000).toISOString()}\n`,
  );
  const lock = acquireSingletonLock(lp, { isAlive: () => true });
  assert.equal(lock.error, undefined, "stale heartbeat is a crash leftover even with a live PID");
  lock.release();
});

test("acquireSingletonLock: heartbeat refreshes the lock file while held", async () => {
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  const prev = process.env.LOCK_HEARTBEAT_INTERVAL_MS;
  process.env.LOCK_HEARTBEAT_INTERVAL_MS = "20";
  try {
    const lock = acquireSingletonLock(lp);
    assert.equal(lock.error, undefined);
    const first = fs.readFileSync(lp, "utf8");
    await new Promise((r) => setTimeout(r, 90)); // ~4 beats at 20ms
    const refreshed = fs.readFileSync(lp, "utf8");
    assert.notEqual(refreshed, first, "heartbeat rewrote the lock file");
    assert.equal(refreshed.split("\n")[0], String(process.pid), "still our lock");
    lock.release();
  } finally {
    if (prev == null) delete process.env.LOCK_HEARTBEAT_INTERVAL_MS;
    else process.env.LOCK_HEARTBEAT_INTERVAL_MS = prev;
  }
});

test("acquireSingletonLock: heartbeat stops itself once the lock no longer holds our PID", async () => {
  // After another launcher takes the lock over, our interval must not clobber
  // THEIR lock file with our PID — the ownership re-check stops the interval.
  const dir = tmpDir();
  const lp = path.join(dir, "run.lock");
  const prev = process.env.LOCK_HEARTBEAT_INTERVAL_MS;
  process.env.LOCK_HEARTBEAT_INTERVAL_MS = "20";
  try {
    const lock = acquireSingletonLock(lp);
    assert.equal(lock.error, undefined);
    // Simulate an age/heartbeat takeover by another process.
    const theirs = `999999\n${new Date().toISOString()}\n${new Date().toISOString()}\n`;
    fs.writeFileSync(lp, theirs);
    await new Promise((r) => setTimeout(r, 80)); // ~4 ticks at 20ms
    assert.equal(fs.readFileSync(lp, "utf8"), theirs, "another holder's lock was not clobbered");
    lock.release();
    lock.release(); // idempotent — must not throw or delete their lock
    assert.equal(fs.readFileSync(lp, "utf8"), theirs, "release did not remove the new holder's lock");
  } finally {
    if (prev == null) delete process.env.LOCK_HEARTBEAT_INTERVAL_MS;
    else process.env.LOCK_HEARTBEAT_INTERVAL_MS = prev;
  }
});

test("isPidAlive: returns true for our own process", () => {
  assert.ok(isPidAlive(process.pid), "our PID is alive");
});

test("isPidAlive: returns false for a nonexistent PID", () => {
  // 999999 is almost certainly unused on any real system.
  assert.equal(isPidAlive(999999), false, "nonexistent PID is not alive");
});