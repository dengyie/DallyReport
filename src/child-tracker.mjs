// ---- in-flight child registry ----
// Child processes spawned by the report (grok-search scripts, sips) are normally
// awaited and reaped by their caller. But if the *main* process is killed while a
// child is mid-flight (SIGINT/SIGTERM, or a forced exit), macOS does not propagate
// the signal — the child would keep running as an orphan. This registry tracks
// every spawned child so run.mjs can reap them from its exit/signal handlers.
//
// Reaping uses SIGKILL deliberately: at exit-handler time we cannot wait for a
// graceful shutdown, and for short-lived probe children (search/fetch/sips) an
// immediate kill is the reliable way to guarantee no orphan survives us.

const children = new Set();
// pids of tracked children that were spawned `detached`, i.e. into their own
// process group. Only these may be signalled by group (-pid); see trackChild.
const detachedChildren = new Set();

// Register a child for reaping. Defensive: ignores non-child objects (test stubs
// may lack .kill/.once). The child is dropped from the set when it exits or errors
// on its own, so the set only holds genuinely in-flight processes.
//
// `detached` records whether the caller spawned the child into its OWN process
// group. It gates the group kill in killAllChildren: `process.kill(-pid)` on a
// child that shares OUR group would kill the report itself, so a non-detached
// child must only ever be signalled by its single pid.
export function trackChild(child, { detached = false } = {}) {
  if (!child || typeof child.kill !== "function" || typeof child.once !== "function") {
    return child;
  }
  children.add(child);
  // Prune BOTH registries on exit/error. 2026-09-27 review A5: the detached pid
  // used to survive the drop, so the set grew once per search all run, and — far
  // worse — a later unrelated child that the OS assigned the same recycled pid
  // was then signalled with `process.kill(-pid)`. A group kill aimed at a stale
  // pid is the one signal that can take down the report itself.
  const pid = typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
  const drop = () => {
    children.delete(child);
    if (pid != null) detachedChildren.delete(pid);
  };
  child.once("exit", drop);
  child.once("error", drop);
  if (detached && pid != null) {
    detachedChildren.add(pid);
  }
  return child;
}

// Synchronous, best-effort reap of every tracked child. Safe to call from
// process.on('exit') and from SIGINT/SIGTERM handlers.
export function killAllChildren() {
  for (const child of children) {
    const pid = child.pid;
    const group = typeof pid === "number" && detachedChildren.has(pid);
    let done = false;
    if (group) {
      try {
        process.kill(-pid, "SIGKILL");
        done = true;
      } catch {
        /* group already gone — fall back to the single pid */
      }
    }
    if (done) {
      detachedChildren.delete(pid);
      continue;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  children.clear();
  detachedChildren.clear();
}