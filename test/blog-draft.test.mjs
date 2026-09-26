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
