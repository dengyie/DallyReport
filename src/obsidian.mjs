import fs from "node:fs/promises";
import path from "node:path";

// Writes one section as `OBSIDIAN_DIR/YYYY-MM-DD/<Section>.md`, overwriting on rerun
// (daily report semantics: same day rerun should refresh, not duplicate).
//
// Returns { file, error }. On a write failure (e.g. the iCloud vault path is
// mid-sync, disk full, vault moved) it does NOT throw - it returns the error and
// the caller (run.mjs) rescues the already-built markdown to a fallback cache file
// so the expensive search/fetch/synthesis work isn't lost.

async function atomicWriteFile(file, contents, fsImpl = fs) {
  const tmp = `${file}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsImpl.writeFile(tmp, contents, "utf8");
    await fsImpl.rename(tmp, file);
  } catch (error) {
    try {
      await fsImpl.rm(tmp, { force: true });
    } catch {
      /* best effort cleanup */
    }
    throw error;
  }
}

export async function writeSection(config, sectionName, markdown, { fsImpl = fs } = {}) {
  const dir = path.join(config.obsidianDir, config.date);
  const file = path.join(dir, `${sectionName}.md`);
  try {
    await fsImpl.mkdir(dir, { recursive: true });
    await atomicWriteFile(file, markdown, fsImpl);
    return { file, error: null };
  } catch (e) {
    return { file, error: e };
  }
}

// Last-resort rescue: when the vault write failed, dump the built markdown into the
// project's reports-cache so the work isn't lost. Always resolves (never throws) -
// if even this fails we log and move on.
export async function rescueMarkdown(config, sectionName, markdown, { fsImpl = fs } = {}) {
  try {
    const dir = config.cacheDir;
    await fsImpl.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${config.date}-${sectionName}-fallback.md`);
    await atomicWriteFile(file, markdown, fsImpl);
    return file;
  } catch {
    return null;
  }
}
