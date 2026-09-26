import fs from "node:fs";
import path from "node:path";

// ---- single-instance lock ----
// Guards the report run so a second launcher (a double-fired cron, a manual run
// while the scheduled one is mid-image-generation) refuses to start instead of
// spawning a second, heavier process alongside the first. The lock is a file
// holding the holder's PID + start time, created atomically (O_EXCL) so two
// concurrent launchers can't both win. A lock whose PID is dead belongs to a
// crashed run and is stale — the next launcher takes it over.

// Cross-platform liveness probe: process.kill(pid, 0) sends no signal but throws
// if the pid has no process. EPERM means a process exists but we lack permission
// to signal it — still "alive" for our purpose.
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

export { defaultIsAlive as isPidAlive };

// Silence ceiling for a lock — how long since the holder's last heartbeat (or,
// for legacy 2-line files, since acquisition) before the lock is judged stale
// even if its PID still resolves. The holder refreshes the file every
// HEARTBEAT_INTERVAL_MS, so a LIVE run is always refused no matter how long the
// whole run legitimately takes (serial poster retries + synthesis + enrichment
// can reach ~38min); a crashed run's heart stops and its lock goes stale after
// this window, which also covers the PID-reuse trap after a crash/reboot (the
// OS may hand the dead run's PID to an unrelated process that
// process.kill(pid,0) reports as "alive").
// 2026-09-25 review root fix: the previous pure wall-age rule (30min, required
// to exceed the whole run) could steal the lock from a live run whenever the
// run outlasted the ceiling — two processes then wrote the same date dir.
// Override via LOCK_MAX_AGE_MS.
// Per-acquire so tests can shorten it via LOCK_HEARTBEAT_INTERVAL_MS without
// module-load-order games (env is read at call time, not import time).
function heartbeatIntervalMs() {
  const raw = process.env.LOCK_HEARTBEAT_INTERVAL_MS;
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 30 * 1000;
}
const MAX_LOCK_AGE_MS = (() => {
  const raw = process.env.LOCK_MAX_AGE_MS;
  if (raw == null || raw === "") return 5 * 60 * 1000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
})();

// Acquire an exclusive lock at lockPath. Returns { release } on success, or
// { error } when another *live* instance holds it. isAlive is injectable so tests
// can simulate a dead holder without a real PID.
// Keep the lock file's heartbeat line fresh while we hold the lock. Ownership is
// re-checked before every write, so once another launcher has taken the lock
// over, the interval stops instead of rewriting. Residual TOCTOU, accepted and
// bounded: a stealer completing unlink+recreate inside the read→write window
// (μs, and it needs our beat to have been silent >5min first) gets clobbered —
// but a THIRD launcher still sees a live PID + fresh beat and refuses, the
// stealer's release() read-compare won't delete foreign content, and we remain
// the eventual cleaner. Closing it fully would need flock-level atomicity —
// not worth it for this window.
function startHeartbeat(lockPath, release) {
  const timer = setInterval(() => {
    try {
      const raw = String(fs.readFileSync(lockPath, "utf8"));
      const lines = raw.split("\n");
      if (lines[0] !== String(process.pid)) {
        clearInterval(timer);
        return;
      }
      fs.writeFileSync(lockPath, `${lines[0]}\n${lines[1]}\n${new Date().toISOString()}\n`);
    } catch {
      /* transient fs hiccup (iCloud/AV scan): next tick retries */
    }
  }, heartbeatIntervalMs());
  timer.unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    release();
  };
}

// A stale lock we cannot remove (unreadable file, permissions, run.lock created
// as a directory) must NOT spin forever. The whole acquire loop is synchronous, so
// nothing yields the event loop: an unbounded retry here pegs a core at 100% and
// hangs the 09:00 launchd run with no log line and no release(). Bound the
// no-progress retries and surface a real error that run.mjs can report instead.
// A few attempts also absorb the legit races (a competing launcher's unlink, an
// iCloud placeholder materialising) without treating them as failures.
const MAX_UNRESOLVABLE_STALE_RETRIES = 5;

export function acquireSingletonLock(lockPath, { isAlive = defaultIsAlive } = {}) {
  // Remove the lock only if it still belongs to US. If another process age-took
  // over our lock while we were still running (a slow run past MAX_LOCK_AGE_MS),
  // the file now holds ITS pid — deleting it would strip the new holder's lock and
  // let a third process in. Read-and-compare keeps release from nuking someone
  // else's lock; the tiny window between read and unlink only matters in the same
  // age-takeover scenario and is accepted (documented on the acquire-side guard).
  const release = () => {
    try {
      const held = String(fs.readFileSync(lockPath, "utf8")).split("\n")[0];
      if (held === String(process.pid)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      /* not present or not ours */
    }
  };

  let madeDir = false; // only auto-create the lock's parent once
  let unresolvedStale = 0; // consecutive iterations that neither acquired nor cleared a stale lock
  for (;;) {
    try {
      const now = new Date().toISOString();
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, `${process.pid}\n${now}\n${now}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return { release: startHeartbeat(lockPath, release) };
    } catch (e) {
      if (e && e.code === "ENOENT" && !madeDir) {
        // Parent dir missing (cache dir was deleted). Create it once, then retry —
        // the concurrent-creation race is handled below by the EEXIST path.
        madeDir = true;
        try {
          fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        } catch {
          throw e; // still can't create the lock's parent — surface the original error
        }
        continue;
      }
      if (e && e.code !== "EEXIST") throw e;
    }
    // Lock exists: a live + fresh holder refuses; anything else (dead PID, our own
    // leftover PID, or a lock so old it must be a crash leftover) is stale — unlink
    // and retry the O_EXCL acquire above. Keep the RAW bytes read below: the unlink
    // is gated on the file still matching them, so we never delete a lock that
    // another launcher installed between our read and our unlink.
    let observed = null;
    let heldBy = NaN;
    let lastKnownAliveAt = null;
    try {
      const raw = String(fs.readFileSync(lockPath, "utf8"));
      observed = raw;
      const [p, ts, beat] = raw.split("\n");
      heldBy = Number(p);
      // The heartbeat line is fresher evidence that the holder lived, so it wins
      // over the acquisition timestamp; legacy 2-line files fall back to ts.
      for (const cand of [beat, ts]) {
        if (cand) {
          const t = new Date(cand).getTime();
          if (Number.isFinite(t)) {
            lastKnownAliveAt = t;
            break;
          }
        }
      }
    } catch {
      /* unreadable lock counts as stale (observed stays null -> guarded below) */
    }
    const tooOld =
      lastKnownAliveAt != null && Date.now() - lastKnownAliveAt > MAX_LOCK_AGE_MS;
    const isStale =
      !Number.isInteger(heldBy) ||
      heldBy <= 0 || // empty/garbage lock file -> no real holder; NB Number('')===0
      // and process.kill(0,0) probes the process GROUP (always present), so a 0 PID
      // must be treated as stale, never as a live holder.
      heldBy === process.pid || // our own leftover lock
      tooOld || // crash leftover regardless of whether the pid resolves
      !isAlive(heldBy); // pid is dead
    if (!isStale) {
      return { error: `另一实例正在运行（PID ${heldBy}）` };
    }
    // Delete the stale lock ONLY if it still holds exactly the bytes we judged
    // stale. Between our read and this point another process may have taken the
    // lock over (read stale, unlinked, re-acquired); deleting now would remove a
    // live holder's lock and let us both run. Re-read and compare: if the content
    // changed or the file vanished, loop back and re-evaluate instead of deleting.
    // (A microseconds-wide TOCTOU between this read and the unlink is unavoidable
    // without an atomic compare-and-unlink; every other interleaving now resolves
    // to a single winner.)
    let stillStale = false;
    try {
      stillStale = String(fs.readFileSync(lockPath, "utf8")) === observed;
    } catch {
      /* file's gone — loop back to a competing acquire */
    }
    if (stillStale) {
      try {
        fs.unlinkSync(lockPath);
        unresolvedStale = 0; // cleared it — real progress
        continue;
      } catch {
        /* raced again — or the lock is unremovable (see below) */
      }
    } else if (observed !== null) {
      // The bytes changed under us: another launcher is actively churning the
      // lock, so the next iteration competes normally. Not a stuck state.
      unresolvedStale = 0;
    }
    // No progress: either the lock is unreadable (read throws, so the guarded
    // unlink can never match) or it is readable and stale but unlink is denied.
    // Retrying forever would spin the synchronous loop at 100% CPU.
    unresolvedStale += 1;
    if (unresolvedStale >= MAX_UNRESOLVABLE_STALE_RETRIES) {
      throw new Error(
        `无法获取锁 ${lockPath}：连续 ${unresolvedStale} 次判定为陈旧但无法读取或删除` +
          `（可能是权限不足、run.lock 被创建成目录，或文件被同步程序占用）`,
      );
    }
    // loop back to retry the acquire with the stale lock removed
  }
}