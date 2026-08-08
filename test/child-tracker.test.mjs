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
  assert.deepEqual(a.signals, ["SIGKILL"]);
  assert.deepEqual(b.signals, ["SIGKILL"]);
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