import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceCard } from "../src/markdown.mjs";

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
