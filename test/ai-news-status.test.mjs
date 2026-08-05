import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAiNewsStatus, shouldSynthesize } from "../src/sections/ai-news.mjs";

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
