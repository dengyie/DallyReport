// Test scratch directories. Every one made through here is removed when the
// test process exits, so `node --test test/` does not permanently litter $TMPDIR.
//
// The 50 call sites this replaced called fs.mkdtemp directly and cleaned up in
// three places total, so every run leaked ~46 directories. That accumulated to
// 4,900+ dirs / 14 MB of dally-* scratch between 2026-09-14 and 2026-09-28.
// Nothing reads $TMPDIR, so the leak was silent; macOS's own periodic purge of
// /var/folders hid the growth rate.
//
// The exit hook is sync on purpose: 'exit' only runs synchronous listeners, so
// cleanup has to use rmSync. A SIGKILL still leaks one directory, which is the
// same guarantee the untracked call sites had — strictly better, not perfect.
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const created = [];
let armed = false;

function arm() {
  if (armed) return;
  armed = true;
  process.on("exit", () => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** Create a scratch dir under $TMPDIR, removed at process exit. */
export function tmpDirSync(prefix) {
  arm();
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Async form of {@link tmpDirSync}. */
export async function tmpDir(prefix) {
  arm();
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
