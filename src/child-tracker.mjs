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

// Register a child for reaping. Defensive: ignores non-child objects (test stubs
// may lack .kill/.once). The child is dropped from the set when it exits or errors
// on its own, so the set only holds genuinely in-flight processes.
export function trackChild(child) {
  if (!child || typeof child.kill !== "function" || typeof child.once !== "function") {
    return child;
  }
  children.add(child);
  const drop = () => children.delete(child);
  child.once("exit", drop);
  child.once("error", drop);
  return child;
}

// Synchronous, best-effort reap of every tracked child. Safe to call from
// process.on('exit') and from SIGINT/SIGTERM handlers.
export function killAllChildren() {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  children.clear();
}