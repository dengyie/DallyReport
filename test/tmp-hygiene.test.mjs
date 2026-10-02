import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

// ---------------------------------------------------------------------------
// 2026-09-28 wrap-up: the test suite leaked a temp dir per mkdtemp call.
//
// test/ had 50 mkdtemp call sites and cleaned up in 3 places, so every
// `node --test test/` run left ~46 directories in $TMPDIR permanently. Measured:
// 5,747 dally-*-XXXXXX directories and 14 MB between 2026-09-14 and
// 2026-09-28. Nothing reads $TMPDIR, so there was no symptom to notice, and
// macOS's own purge of /var/folders hid the growth rate. src/ was never
// affected (5 mkdtemp, 6 rm) — the leak was in the tests, not the product.
// ---------------------------------------------------------------------------

const helperUrl = new URL("./helpers/tmp.mjs", import.meta.url);
const selfFile = fileURLToPath(import.meta.url);
const helperFile = fileURLToPath(helperUrl);

test("the helper removes the directories it created, on process exit", () => {
  // A real child process, not an in-process assertion: the cleanup runs from an
  // 'exit' listener, which by definition cannot be observed from inside the
  // process that installs it.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { tmpDirSync, tmpDir } from ${JSON.stringify(helperUrl.href)};
       process.stdout.write(tmpDirSync("dally-tmphyg-") + "\\n" + (await tmpDir("dally-tmphyg-")));`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, `helper child failed: ${child.stderr}`);

  const [syncDir, asyncDir] = child.stdout.trim().split("\n");
  assert.ok(syncDir && asyncDir, "child reported both directories");
  for (const dir of [syncDir, asyncDir]) {
    assert.ok(dir.includes("dally-tmphyg-"), `unexpected dir name: ${dir}`);
    assert.equal(existsSync(dir), false, `helper left ${dir} behind after exit`);
  }
});

test("no test file calls fs.mkdtemp directly — scratch dirs go through the helper", async () => {
  // Source-level for the same reason as the child-tracker scan: a leaked temp
  // dir is invisible from the outside, so the only place to catch it is the
  // code that creates it. Scans the whole test/ tree so the NEXT file that
  // reaches for mkdtemp is caught too.
  //
  // Skips this file and the helper itself: both name mkdtemp, and this regex
  // is textual, so they would otherwise flag their own source.
  const root = fileURLToPath(new URL(".", import.meta.url));
  const skip = new Set([selfFile, helperFile]);

  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (skip.has(full)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".mjs")) {
        const src = await readFile(full, "utf8");
        // Strip line comments and strings so a test that merely mentions
        // mkdtemp in prose or asserts on the pattern is not a false positive.
        const code = src.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
        if (/mkdtemp(?:Sync)?\s*\(/.test(code)) offenders.push(path.relative(root, full));
      }
    }
  }
  await walk(root);

  assert.deepEqual(
    offenders,
    [],
    `these create a temp dir that is never removed; use tmpDir/tmpDirSync from ./helpers/tmp.mjs: ${offenders.join(", ")}`,
  );
});
