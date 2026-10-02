import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { trackChild, killAllChildren } from "../src/child-tracker.mjs";

// A minimal fake ChildProcess: EventEmitter with a kill spy.
function fakeChild() {
  const c = new EventEmitter();
  c.signals = [];
  c.kill = (sig) => c.signals.push(sig);
  return c;
}

test("trackChild + killAllChildren: kills every tracked child with SIGKILL", () => {
  const a = fakeChild();
  const b = fakeChild();
  trackChild(a);
  trackChild(b);
  killAllChildren();
  const sig = process.platform === "win32" ? undefined : "SIGKILL";
  assert.deepEqual(a.signals, [sig]);
  assert.deepEqual(b.signals, [sig]);
  // killAllChildren clears the registry, so a second call sends nothing new.
  a.signals.length = 0;
  killAllChildren();
  assert.deepEqual(a.signals, [], "registry cleared after first reap");
});

test("trackChild: drops a child that exits on its own (no re-kill on reap)", () => {
  const c = fakeChild();
  trackChild(c);
  c.emit("exit", 0); // child finished normally
  killAllChildren();
  assert.deepEqual(c.signals, [], "exited child is not reaped");
});

test("trackChild: drops a child that errors on its own", () => {
  const c = fakeChild();
  trackChild(c);
  c.emit("error", new Error("spawn failed"));
  killAllChildren();
  assert.deepEqual(c.signals, [], "errored child is not reaped");
});

test("trackChild: ignores objects without kill/once (defensive)", () => {
  assert.doesNotThrow(() => {
    trackChild(null);
    trackChild({});
    trackChild({ kill() {} }); // no .once
  });
  // Nothing tracked -> killAllChildren is a no-op.
  assert.doesNotThrow(() => killAllChildren());
});

// ---------------------------------------------------------------------------
// 2026-09-27 review (round 5) A5: `detachedChildren` was never pruned.
//
// The drop handler removed the child object from `children` but left its pid in
// `detachedChildren` forever. Two consequences:
//   1. the set grew once per search for the whole run — an unbounded leak on a
//      day with many searches;
//   2. more seriously, a later unrelated child that the OS happened to assign
//      the SAME recycled pid was then treated as detached and signalled with
//      `process.kill(-pid)`. On a 09:00 launchd run the report itself is the most
//      likely victim of a group kill aimed at a recycled pid.
// ---------------------------------------------------------------------------

test("trackChild: a detached child's pid is pruned when it exits, never reused as a group target", () => {
  const original = process.kill;
  const groupSignals = [];
  process.kill = (pid, sig) => {
    groupSignals.push({ pid, sig });
  };
  try {
    const first = fakeChild();
    first.pid = 424242;
    trackChild(first, { detached: true });
    first.emit("exit", 0);

    // The OS now hands the same pid to a NEW, non-detached child.
    const second = fakeChild();
    second.pid = 424242;
    trackChild(second);

    killAllChildren();

    assert.deepEqual(
      groupSignals,
      [],
      "a recycled pid must never receive a group kill — it could hit the report itself",
    );
    assert.deepEqual(second.signals, [process.platform === "win32" ? undefined : "SIGKILL"], "the new child is still reaped by its single pid");
  } finally {
    process.kill = original;
  }
});

test("trackChild: a detached child's pid is pruned on 'error' as well", () => {
  const original = process.kill;
  const groupSignals = [];
  process.kill = (pid, sig) => {
    groupSignals.push({ pid, sig });
  };
  try {
    const first = fakeChild();
    first.pid = 515151;
    trackChild(first, { detached: true });
    first.emit("error", new Error("spawn failed"));

    const second = fakeChild();
    second.pid = 515151;
    trackChild(second);
    killAllChildren();

    assert.deepEqual(groupSignals, [], "error path must prune the detached pid too");
    assert.deepEqual(second.signals, [process.platform === "win32" ? undefined : "SIGKILL"]);
  } finally {
    process.kill = original;
  }
});

test("trackChild: a still-live detached child IS group-killed (the original behaviour)", () => {
  const original = process.kill;
  const groupSignals = [];
  process.kill = (pid, sig) => {
    groupSignals.push({ pid, sig });
  };
  try {
    const c = fakeChild();
    c.pid = 313131;
    trackChild(c, { detached: true });
    killAllChildren();
    if (process.platform === "win32") {
      // process.on("exit") cannot spawn taskkill, and there is no process group.
      assert.deepEqual(groupSignals, [], "win32 does not signal a negative pid");
      assert.deepEqual(c.signals, [undefined], "falls back to a single-pid kill");
    } else {
      assert.deepEqual(groupSignals, [{ pid: -313131, sig: "SIGKILL" }], "grandchildren are reaped");
      assert.deepEqual(c.signals, [], "no redundant single-pid kill when the group kill worked");
    }
  } finally {
    process.kill = original;
  }
});

test("every module that can spawn a child registers it for reaping", async () => {
  // The invariant child-tracker.mjs exists to hold: macOS does not propagate a
  // signal to children, so a spawn that skips trackChild leaves an orphan when
  // the 09:00 job is interrupted. The shot.mjs Chrome launch was the one that
  // did — a headless browser held a profile lock and left its temp dir behind,
  // because the `finally` that cleans it never runs inside a signal handler.
  //
  // This is a source-level scan on purpose: the failure mode has no runtime
  // symptom until a signal arrives, so there is nothing to assert against from
  // outside. A directory scan (rather than a check on one file) also catches
  // the NEXT module that adds a spawn.
  //
  // The trigger is the IMPORT, not a call-site regex. An earlier version
  // matched /\bspawn(Sync)?\(/, which was quietly narrower than the test's name:
  // execFile, exec, execSync and fork produce children that macOS will not
  // signal either, and a module using one would have passed. Widening the regex
  // is not the fix — `re.exec(text)` in linuxdo.mjs and eight other modules
  // matches any plausible \bexec\(, because a dot before `e` is still a word
  // boundary. Importing node:child_process is the honest precondition: every
  // such module here is a spawning module, and none of them imports it for
  // anything else.
  const { readdir, readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  // fileURLToPath, not `.pathname`: a percent-encoded pathname breaks on any
  // checkout path containing a space.
  const root = fileURLToPath(new URL("../src/", import.meta.url));

  const spawning = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".mjs")) {
        const src = await readFile(full, "utf8");
        if (/from\s+["']node:child_process["']/.test(src)) spawning.push({ file: path.relative(root, full), src });
      }
    }
  }
  await walk(root);

  assert.ok(spawning.length > 0, "the scan found nothing; it is not looking at the right tree");
  const untracked = spawning.filter((m) => !/trackChild\s*\(/.test(m.src)).map((m) => m.file);
  assert.deepEqual(untracked, [], `these modules can spawn a child they never register: ${untracked.join(", ")}`);
});
