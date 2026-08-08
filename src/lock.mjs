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

// Age ceiling for a lock — a lock older than this is judged stale even if its PID
// still resolves, guarding against PID reuse after a crash/reboot (the OS may hand
// the dead run's PID to an unrelated process that process.kill(pid,0) reports as
// "alive"). The default 30min must exceed the WHOLE run (image-gen + enrichment +
// a slow-search day can together exceed 10min), not just any single step: a lock
// younger than this with a live PID is genuinely in-flight and must be refused.
// Override via LOCK_MAX_AGE_MS.
const MAX_LOCK_AGE_MS = (() => {
  const raw = process.env.LOCK_MAX_AGE_MS;
  if (raw == null || raw === "") return 30 * 60 * 1000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
})();

// Acquire an exclusive lock at lockPath. Returns { release } on success, or
// { error } when another *live* instance holds it. isAlive is injectable so tests
// can simulate a dead holder without a real PID.
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
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return { release };
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
    let heldAt = null;
    try {
      const raw = String(fs.readFileSync(lockPath, "utf8"));
      observed = raw;
      const [p, ts] = raw.split("\n");
      heldBy = Number(p);
      if (ts) {
        const t = new Date(ts).getTime();
        if (Number.isFinite(t)) heldAt = t;
      }
    } catch {
      /* unreadable lock counts as stale (observed stays null -> guarded below) */
    }
    const tooOld = heldAt != null && Date.now() - heldAt > MAX_LOCK_AGE_MS;
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
      } catch {
        /* raced again — loop back */
      }
    }
    // loop back to retry the acquire with the stale lock removed
  }
}