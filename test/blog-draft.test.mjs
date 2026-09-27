import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanObsidianMarkdown, convertReportToBlogDraft, exportBlogDraft } from "../src/blog-draft.mjs";

test("blog draft conversion removes Obsidian-only syntax and marks review", () => {
  const draft = convertReportToBlogDraft(
    `---\ndate: 2026-08-13\ndays_dropped: 5\n---\n\n# AI 热点 · 2026-08-13\n\n![[AI.png]]\n\n> ⚠️ **低素材提示**：请核验。\n\n参见 [[DallyReport 运维|运维文档]]。`,
    { date: "2026-08-13", sourceFile: "/vault/AI.md" },
  );
  assert.match(draft, /draft: true/);
  assert.match(draft, /publish_review: pending/);
  assert.match(draft, /assets\/AI\.png/);
  assert.match(draft, /运维文档/);
  assert.doesNotMatch(draft, /!\[\[/);
  assert.match(draft, /已过滤 5 条/);
  assert.match(draft, /当日硬源不足/);
});

test("cleanObsidianMarkdown preserves ordinary markdown", () => {
  assert.equal(cleanObsidianMarkdown("# Title\n\n[link](https://example.com)\n"), "# Title\n\n[link](https://example.com)\n");
});

test("exportBlogDraft copies poster and writes a dated draft", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dally-blog-draft-"));
  const obsidianDir = path.join(root, "vault");
  const outputDir = path.join(root, "output");
  await fs.mkdir(path.join(obsidianDir, "2026-08-13"), { recursive: true });
  await fs.writeFile(path.join(obsidianDir, "2026-08-13", "AI.md"), "---\ndate: 2026-08-13\n---\n\n# AI 热点 · 2026-08-13\n\n![[AI.png]]\n");
  await fs.writeFile(path.join(obsidianDir, "2026-08-13", "AI.png"), "fake-png");
  const result = await exportBlogDraft({ obsidianDir, outputDir, date: "2026-08-13" });
  assert.equal(await fs.readFile(path.join(outputDir, "2026-08-13", "AI.md"), "utf8").then((s) => s.includes("draft: true")), true);
  assert.equal(await fs.readFile(path.join(outputDir, "2026-08-13", "assets", "AI.png"), "utf8"), "fake-png");
  assert.equal(result.outputFile, path.join(outputDir, "2026-08-13", "AI.md"));
});

// ---------------------------------------------------------------------------
// 2026-09-27 review D1/D2: the publishable draft carried the local vault path
// and blanked its own warnings on the one day they mattered most.
//
// D1: `source:` was the absolute iCloud path of the machine that generated the
// draft, inside front-matter that is meant to be public. It exposes the user's
// home directory and username, and is meaningless to a reader.
//
// D2: the body carries a "⚠️ 综合失败" banner exactly when synthesis failed and
// the text is the model's raw memory answer — the day a human must not publish
// without checking. The warning detector looked for 低素材/时效 markers instead,
// so `review_warnings` came out `[]` and `publish_review: pending` stood alone.
// ---------------------------------------------------------------------------

test("blog draft: front-matter never leaks the local vault path", () => {
  const md =
    "---\ndate: 2026-09-27\ndays_dropped: 0\n---\n\n# AI 热点 · 2026-09-27\n\n正文\n";
  const out = convertReportToBlogDraft(md, {
    date: "2026-09-27",
    sourceFile: "/Users/mango/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian-note/Note/AI/2026-09-27/AI.md",
  });
  const front = out.slice(0, out.indexOf("\n---", 4));
  assert.doesNotMatch(front, /\/Users\//, "no absolute home path in publishable front-matter");
  assert.doesNotMatch(front, /iCloud~md~obsidian/, "no vault layout in publishable front-matter");
  // The provenance is still recorded — as a date, which is what a reader needs.
  assert.match(front, /source_date: "2026-09-27"/);
});

test("blog draft: a 综合失败 body raises a publish-blocking warning", () => {
  const md =
    "---\ndate: 2026-09-27\ndays_dropped: 0\n---\n\n# AI 热点 · 2026-09-27\n\n" +
    "> ⚠️ **综合失败（SYNTH_TIMEOUT）**：以下为未经来源核实的模型原始回答，可能与当日事实不符，请谨慎阅读。\n\n" +
    "## 今日动态\n\n某模型发布。\n";
  const out = convertReportToBlogDraft(md, { date: "2026-09-27" });
  assert.doesNotMatch(out, /review_warnings:\n {2}\[\]/, "warnings must not be empty on a failed-synthesis day");
  assert.match(out, /综合失败/, "the warning names the actual problem");
  assert.match(out, /未经来源核实/);
});

test("blog draft: a clean body still has no warnings (contrast direction)", () => {
  const md = "---\ndate: 2026-09-27\ndays_dropped: 0\n---\n\n# AI 热点 · 2026-09-27\n\n## 今日动态\n\n某模型发布。\n";
  const out = convertReportToBlogDraft(md, { date: "2026-09-27" });
  assert.match(out, /review_warnings:\n {2}\[\]/);
});
