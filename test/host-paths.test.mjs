import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { hostPaths, HOST_DEFAULTS } from "../src/host-paths.mjs";

// The three platform branches are exercised explicitly with a fixed home, so the
// suite covers darwin/win32/linux regardless of the host it runs on. A test that
// only read process.platform could only ever reach one of them.

// `exists: () => false` pins the "nothing probed on disk" case so the assertions
// below test the platform CONVENTION, not whatever vaults happen to exist on the
// machine running the suite (an unconfigured clone must still get a sane default).
const NEVER = () => false;

test("hostPaths(darwin): uses the macOS iCloud / Mobile Documents nest", () => {
  const p = hostPaths({ platform: "darwin", home: "/Users/tester", exists: NEVER });
  assert.equal(p.grokSearchDir, path.join("/Users/tester", ".claude", "skills", "grok-search"));
  assert.equal(
    p.obsidianDir,
    path.join(
      "/Users/tester",
      "Library",
      "Mobile Documents",
      "iCloud~md~obsidian",
      "Documents",
      "obsidian-note",
      "Note",
      "AI",
      "DallyReport",
    ),
  );
  assert.match(p.imagePromptFile, /Note[\\/]AI[\\/]AI 提示词[\\/]图片生成提示词[\\/]GitHub 日报海报提示词\.md$/);
  assert.match(p.aiImagePromptFile, /AI 日报海报提示词\.md$/);
  assert.match(p.imageRefImage, /OneNode[\\/]assersts[\\/]Pasted image 20260804185819\.png$/);
});

test("hostPaths(win32): mirrors the vault under the Windows iCloud Drive root", () => {
  const p = hostPaths({ platform: "win32", home: "C:\\Users\\tester", exists: NEVER });
  assert.equal(
    p.obsidianDir,
    path.join("C:\\Users\\tester", "iCloudDrive", "iCloud~md~obsidian", "Documents", "obsidian-note", "Note", "AI", "DallyReport"),
  );
  // Same vault tail as macOS — the note tree identity is preserved across hosts.
  assert.match(p.obsidianDir, /obsidian-note[\\/]Note[\\/]AI[\\/]DallyReport$/);
  assert.ok(!p.obsidianDir.includes("Library"), "must not reuse the macOS Library path on Windows");
});

test("hostPaths(linux): falls back to a plain ~/obsidian-note vault", () => {
  const p = hostPaths({ platform: "linux", home: "/home/tester", exists: NEVER });
  assert.equal(p.obsidianDir, path.join("/home/tester", "obsidian-note", "Note", "AI", "DallyReport"));
});

test("HOST_DEFAULTS is resolved from the current host and is internally consistent", () => {
  const current = hostPaths();
  assert.deepEqual(HOST_DEFAULTS, current);
  // Prompt files and the reference image live inside the same vault tree.
  const vaultTail = path.join("obsidian-note");
  assert.ok(HOST_DEFAULTS.imagePromptFile.includes(vaultTail));
  assert.ok(HOST_DEFAULTS.aiImagePromptFile.includes(vaultTail));
  assert.ok(HOST_DEFAULTS.imageRefImage.includes(vaultTail));
  assert.ok(HOST_DEFAULTS.obsidianDir.includes(vaultTail));
});

// ── vault probing ──────────────────────────────────────────────────────────

test("hostPaths(win32): picks the plain home vault when iCloudDrive is missing", () => {
  const plainRoot = path.join("C:\\Users\\tester", "obsidian-note");
  const p = hostPaths({
    platform: "win32",
    home: "C:\\Users\\tester",
    exists: (root) => root === plainRoot,
  });
  assert.equal(
    p.obsidianDir,
    path.join(plainRoot, "Note", "AI", "DallyReport"),
    "must resolve inside the existing plain vault, not the missing iCloudDrive mirror",
  );
});

test("hostPaths(darwin): relies on probing when the iCloud nest does not exist", () => {
  const plainRoot = path.join("/Users/tester", "obsidian-note");
  const p = hostPaths({
    platform: "darwin",
    home: "/Users/tester",
    exists: (root) => root === plainRoot,
  });
  assert.equal(
    p.obsidianDir,
    path.join(plainRoot, "Note", "AI", "DallyReport"),
    "must resolve inside the existing plain vault, not the missing iCloud nest",
  );
});