import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAiNewsStatus,
  shouldSynthesize,
  formatDailySourceDiagnostics,
} from "../src/sections/ai-news.mjs";

test("computeAiNewsStatus: zero-citation output with sources remains usable", () => {
  const status = computeAiNewsStatus({
    searchOk: true,
    synthesized: false,
    synthAttemptedAndFailed: false,
    zeroCitation: true,
    sourceCount: 2,
    hasUsableDegradedDump: false,
  });
  assert.equal(status.ok, true);
  assert.equal(status.summary, "Grok 零回引（已标注降级）");
});

test("computeAiNewsStatus: zero-citation zero-source output is not success", () => {
  const status = computeAiNewsStatus({
    searchOk: true,
    synthesized: false,
    synthAttemptedAndFailed: false,
    zeroCitation: true,
    sourceCount: 0,
    hasUsableDegradedDump: false,
  });
  assert.equal(status.ok, false);
  assert.match(status.summary, /零来源零回引/);
});

test("computeAiNewsStatus: usable degraded dump remains successful", () => {
  const status = computeAiNewsStatus({
    searchOk: true,
    synthesized: false,
    synthAttemptedAndFailed: false,
    zeroCitation: true,
    sourceCount: 0,
    hasUsableDegradedDump: true,
  });
  assert.equal(status.ok, true);
  assert.match(status.summary, /降级原始摘要/);
});

test("computeAiNewsStatus: failed synthesis is not success", () => {
  const status = computeAiNewsStatus({
    searchOk: true,
    synthesized: false,
    synthAttemptedAndFailed: true,
    zeroCitation: true,
    sourceCount: 1,
    hasUsableDegradedDump: false,
    synthError: { code: "SYNTH_FETCH_FAILED" },
  });
  assert.equal(status.ok, false);
  assert.match(status.summary, /综合失败/);
});

test("computeAiNewsStatus: normal cited search is successful", () => {
  const status = computeAiNewsStatus({
    searchOk: true,
    synthesized: false,
    synthAttemptedAndFailed: false,
    zeroCitation: false,
    sourceCount: 3,
    hasUsableDegradedDump: false,
  });
  assert.equal(status.ok, true);
  assert.equal(status.summary, "success");
});

test("computeAiNewsStatus: linuxdo presence does not leak into the summary", () => {
  // De-pollution guard: even when linux.do sources are included, the delivered
  // summary must not advertise "linux.do N" (the user wants the linux.do signal
  // kept out of the report surface).
  const status = computeAiNewsStatus({
    searchOk: true,
    synthesized: true,
    synthAttemptedAndFailed: false,
    zeroCitation: true,
    sourceCount: 5,
    linuxdoCount: 3,
    hasUsableDegradedDump: false,
  });
  assert.equal(status.ok, true);
  assert.doesNotMatch(status.summary, /linux\.do|linuxdo/);
});

// --- shouldSynthesize (pure decision; exported from ai-news.mjs) ---

test("shouldSynthesize: zero-citation with real sources -> true", () => {
  assert.equal(
    shouldSynthesize({
      haveSources: true,
      searchOkForSynth: true,
      zeroCitation: true,
      communityCount: 0,
      hasUsableDegradedDump: false,
    }),
    true,
  );
});

test("shouldSynthesize: search failed but community sources exist -> true", () => {
  // (b) creds missing / search down, yet a forum (linux.do/nodeseek/v2ex) produced
  // usable same-day signal -> re-synthesize from the cleaned community sources.
  assert.equal(
    shouldSynthesize({
      haveSources: true,
      searchOkForSynth: false,
      zeroCitation: false,
      communityCount: 3,
      hasUsableDegradedDump: false,
    }),
    true,
  );
});

test("shouldSynthesize: degraded dump + community sources -> true (re-synthesize)", () => {
  // (c) grok-search went degraded (injection-noisy raw dump as answer) and we have
  // community signal to rebuild from -> re-synthesize beats reusing the dump.
  assert.equal(
    shouldSynthesize({
      haveSources: true,
      searchOkForSynth: true,
      zeroCitation: false,
      communityCount: 2,
      hasUsableDegradedDump: true,
    }),
    true,
  );
});

test("shouldSynthesize: degraded dump with NO community sources -> false (reuse dump)", () => {
  // Reusing the already-grounded degraded dump avoids a second paid round on top of
  // an existing body; no community signal to justify the re-synthesis.
  assert.equal(
    shouldSynthesize({
      haveSources: true,
      searchOkForSynth: true,
      zeroCitation: false,
      communityCount: 0,
      hasUsableDegradedDump: true,
    }),
    false,
  );
});

test("shouldSynthesize: no sources at all -> false", () => {
  assert.equal(
    shouldSynthesize({
      haveSources: false,
      searchOkForSynth: true,
      zeroCitation: true,
      communityCount: 0,
      hasUsableDegradedDump: false,
    }),
    false,
  );
});

test("shouldSynthesize: search ok + cited (no degraded/zero) -> false", () => {
  assert.equal(
    shouldSynthesize({
      haveSources: true,
      searchOkForSynth: true,
      zeroCitation: false,
      communityCount: 2,
      hasUsableDegradedDump: false,
    }),
    false,
  );
});

test("computeAiNewsStatus: fallback synthesis succeeds and is annotated", () => {
  const status = computeAiNewsStatus({
    searchOk: true,
    synthesized: true,
    synthAttemptedAndFailed: false,
    zeroCitation: true,
    sourceCount: 5,
    hasUsableDegradedDump: false,
    synthModel: "grok-4.5",
    synthFellBack: true,
    synthFallbackFrom: "gpt-5.6-luna",
  });
  assert.equal(status.ok, true);
  assert.match(status.summary, /grok-4\.5/);
  assert.match(status.summary, /gpt-5\.6-luna 失败，已回退 grok-4\.5/);
});

test("computeAiNewsStatus: fallback with identical model is not annotated", () => {
  // No primary→fallback note when they are the same model (fallback would be degenerate).
  const status = computeAiNewsStatus({
    searchOk: true,
    synthesized: true,
    synthAttemptedAndFailed: false,
    zeroCitation: false,
    sourceCount: 2,
    hasUsableDegradedDump: false,
    synthModel: "grok-4.5",
    synthFellBack: false,
    synthFallbackFrom: null,
  });
  assert.equal(status.ok, true);
  assert.equal(status.summary, "综合成功（grok-4.5，2 来源）");
});

// ---- 2026-09-26 review P1: the shipped reference list ran unvalidated ----
// markdown.mjs already owned `sanitizeUrl` (rejects any non-http(s) scheme) and
// its own `sourceCard` used it — but `sourceCard` has ZERO production callers
// (`grep -rn "sourceCard" src/` returns only its definition), so the two tests
// guarding it in markdown.test.mjs protected code that never shipped. The real
// renderer, ai-news `refLines`, emitted `s.url` verbatim: a scraped post's url is
// attacker-authored, so `javascript:` became a live clickable link in the vault.

test("sanitizeUrl: non-http(s) schemes are rejected", async () => {
  const { sanitizeUrl } = await import("../src/markdown.mjs");
  assert.equal(sanitizeUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeUrl("data:text/html,<script>x</script>"), "");
  assert.equal(sanitizeUrl("file:///etc/passwd"), "");
  assert.equal(sanitizeUrl("vbscript:msgbox"), "");
  assert.equal(sanitizeUrl(""), "");
  assert.equal(sanitizeUrl(null), "");
  assert.equal(sanitizeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(sanitizeUrl("http://example.com/a"), "http://example.com/a");
});

test("sanitizeUrl: whitespace/control-character smuggling is rejected", async () => {
  const { sanitizeUrl } = await import("../src/markdown.mjs");
  assert.equal(sanitizeUrl("java\nscript:alert(1)"), "");
  assert.equal(sanitizeUrl(" javascript:alert(1)"), "");
  assert.equal(sanitizeUrl("https://exa mple.com"), "");
});


// ---------------------------------------------------------------------------
// 2026-09-28 H1: a starved hard source must not be reported as a collection
// failure. It fetched fine; the recency window emptied it. "采集失败" points the
// reader at the network when the publishing calendar is the real cause — and on
// 2026-09-28 all five vendor blogs were starved, so the summary would have
// blamed five healthy feeds for a quiet week.
// ---------------------------------------------------------------------------

test("H1: a source starved by the recency window is named 当日无新内容", () => {
  const labels = formatDailySourceDiagnostics(
    { openai: { count: 1, sample: [{ reason: "no-fresh-items-in-window", parsed: 1230 }] } },
    "当日硬源",
  );
  assert.deepEqual(labels, ["当日硬源/openai（当日无新内容）"]);
  assert.doesNotMatch(labels.join(), /采集失败/, "starvation is not a collection failure");
});

test("H1: a source that actually failed still says 采集失败", () => {
  const labels = formatDailySourceDiagnostics(
    { arxiv: { count: 2, sample: [{ reason: "ECONNRESET" }] } },
    "当日硬源",
  );
  assert.deepEqual(labels, ["当日硬源/arxiv（2 项采集失败）"]);
});

test("H1: both kinds coexist and neither is mislabelled", () => {
  const labels = formatDailySourceDiagnostics(
    {
      openai: { count: 1, sample: [{ reason: "no-fresh-items-in-window" }] },
      hf: { count: 3, sample: [{ reason: "ECONNRESET" }] },
    },
    "当日硬源",
  );
  assert.equal(labels.length, 2);
  assert.match(labels[0], /openai（当日无新内容）/);
  assert.match(labels[1], /hf（3 项采集失败）/);
});

test("H1: a healthy run produces no labels at all", () => {
  assert.deepEqual(formatDailySourceDiagnostics(undefined), []);
  assert.deepEqual(formatDailySourceDiagnostics(null), []);
  assert.deepEqual(formatDailySourceDiagnostics({}), []);
  assert.deepEqual(formatDailySourceDiagnostics({ openai: { count: 0 } }), []);
});
