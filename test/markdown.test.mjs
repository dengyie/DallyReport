import { test } from "node:test";
import assert from "node:assert/strict";
import { frontMatter, sourceCard, stripMarkdown } from "../src/markdown.mjs";

test("frontMatter: array items with YAML flow-significant chars round-trip safely", () => {
  // Tags containing [ ] , " must stay inside the flow sequence: each item is
  // JSON-quoted, so none of them can terminate the sequence early or inject
  // extra items when the front-matter is re-parsed.
  const tags = ['bracket[open', 'bracket]close', 'comma,sep', 'quote"inside'];
  const rendered = frontMatter({ tags });
  assert.match(rendered, /^tags: \[.*\]$/m);
  // Parse the flow sequence back out of the rendered front-matter and compare.
  const line = rendered.split("\n").find((l) => l.startsWith("tags: ["));
  const parsed = JSON.parse(`[${line.slice("tags: [".length, -1)}]`);
  assert.deepEqual(parsed, tags);
});

test("sourceCard: escapes external markdown and rejects unsafe URLs", () => {
  const rendered = sourceCard({
    title: "][Injected](https://evil.example)\n# heading",
    url: "javascript:alert(1)",
    snippet: "ok\n\n# injected\n[link](https://evil.example)",
  });

  assert.ok(
    rendered.startsWith("- \\]\\[Injected\\]\\(https://evil\\.example\\) \\# heading\n  > ok"),
  );
  assert.doesNotMatch(rendered, /javascript:/i);
  assert.doesNotMatch(rendered, /^# injected/m);
  assert.doesNotMatch(rendered, /\[link\]\(/);
  assert.match(rendered, /\\# injected/);
  assert.ok(rendered.includes("\\[link\\]\\(https://evil\\.example\\)"));
});

test("sourceCard: uses an angle-bracket destination for safe HTTP URLs", () => {
  const rendered = sourceCard({
    title: "Example",
    url: "https://example.com/a_(b)?q=1",
    snippet: "safe",
  });
  assert.equal(rendered, "- [Example](<https://example.com/a_(b)?q=1>)\n  > safe");
});

test("stripMarkdown: removes inline links, orphan tails, and emphasis", () => {
  assert.equal(
    stripMarkdown("3 分钟用完 Codex 5 小时额度](/t/1242585#reply21) **[CyanHaze](/member/CyanHaze)** • 34 mins ago"),
    "3 分钟用完 Codex 5 小时额度 CyanHaze • 34 mins ago",
  );
  assert.equal(stripMarkdown("[纯文本标题](/t/123)"), "纯文本标题");
  assert.equal(stripMarkdown("__加粗__ 与 **重点**"), "加粗 与 重点");
  assert.equal(stripMarkdown("普通标题，无格式"), "普通标题，无格式");
  assert.equal(stripMarkdown(""), "");
  assert.equal(stripMarkdown(null), "");
});
