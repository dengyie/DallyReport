// 2026-09-28 weekly: the report's material-window header, its low-material
// threshold and its hard-source label are all daily-worded. A weekly that
// printed "当日素材 40 条" while actually covering seven days misdescribes its
// own evidence, and — worse — the 低素材 threshold of 8 is a *daily* budget:
// a well-stocked week carries ~7x the material, so the weekly would sit BELOW
// the threshold far less often and silently lose the warning that a real
// starvation would deserve. The threshold therefore scales with the window.
//
// These are pure-formatter tests, matching how the file already exposes
// computeAiNewsStatus / formatDailySourceDiagnostics / buildReferenceLines:
// driving aiNewsSection itself would need live collectors plus an LLM.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMaterialWindowHeader,
  lowMaterialThresholdFor,
  reportPeriodWords,
  countDailySources,
} from "../src/sections/ai-news.mjs";
import { systemPromptFor, SYSTEM_PROMPT } from "../src/llm-synthesize.mjs";

test("daily mode keeps the shipped daily wording byte-for-byte", () => {
  const header = buildMaterialWindowHeader({
    dailyCount: 12,
    genericCount: 3,
    recencyDropped: 0,
    mode: "daily",
  });
  assert.match(header, /\*\*素材窗口\*\*：当日素材 12 条；近几日来源 3 条。/);
  assert.doesNotMatch(header, /低素材/);
});

test("weekly mode reports a week, not a day", () => {
  const header = buildMaterialWindowHeader({
    dailyCount: 40,
    genericCount: 9,
    recencyDropped: 4,
    mode: "weekly",
  });
  assert.match(header, /\*\*素材窗口\*\*：本周素材 40 条；近 7 日来源 9 条；过期已过滤 4 条。/);
  // The dropped counter is mode-neutral: same key, same meaning.
  assert.match(header, /过期已过滤 4 条/);
});

test("low-material threshold scales with the window", () => {
  // The daily number must not drift: it is asserted by shipped-note behaviour.
  assert.equal(lowMaterialThresholdFor("daily"), 8);
  assert.equal(lowMaterialThresholdFor(undefined), 8);
  assert.equal(lowMaterialThresholdFor("weekly"), 20);
});

test("a well-stocked weekly does NOT get downgraded to the low-material warning", () => {
  // The threshold that is actually consulted must be the WEEKLY one, not the
  // daily 8. A week carrying 20 hard-source cards is healthy; 19 is a genuinely
  // thin week. If the scaled threshold were ignored and 8 reused, both would
  // pass silently and the starvation warning would never reach a weekly note.
  const healthy = buildMaterialWindowHeader({
    dailyCount: 20,
    genericCount: 0,
    recencyDropped: 0,
    mode: "weekly",
  });
  assert.doesNotMatch(healthy, /低素材/);

  const thin = buildMaterialWindowHeader({
    dailyCount: 19,
    genericCount: 0,
    recencyDropped: 0,
    mode: "weekly",
  });
  assert.match(thin, /低素材提示/);
  assert.match(thin, /本周硬源不足 20 条/);
});

test("a daily with 8 hard sources must not get the warning either", () => {
  const header = buildMaterialWindowHeader({
    dailyCount: 8,
    genericCount: 0,
    recencyDropped: 0,
    mode: "daily",
  });
  assert.doesNotMatch(header, /低素材/);
});

test("period words drive the degraded hard-source label", () => {
  assert.equal(reportPeriodWords("daily").hard, "当日硬源");
  assert.equal(reportPeriodWords("weekly").hard, "本周硬源");
  // Undefined mode is a daily report: bare {date} test configs reach here.
  assert.equal(reportPeriodWords(undefined).hard, "当日硬源");
  // A weekly starved feed must not say "当日无新内容" — nothing in it is
  // "当日".
  assert.equal(reportPeriodWords("weekly").starved, "本周无新内容");
  assert.equal(reportPeriodWords("daily").starved, "当日无新内容");
});

test("countDailySources honours the weekly window: 6 days old still counts", () => {
  // 2026-10-02 Friday, weekly window 2026-09-26 .. 2026-10-02.
  // publishedAt is epoch MS (sourceEpochMs takes Number(src.publishedAt) as-is,
  // matching the existing countDailySources fixtures).
  const inWindow = { title: "a", url: "https://x/1", publishedAt: Date.parse("2026-09-26T10:00:00+08:00") };
  const tooOld = { title: "b", url: "https://x/2", publishedAt: Date.parse("2026-09-25T10:00:00+08:00") };
  const window = {
    mode: "weekly",
    days: 7,
    startMs: Date.parse("2026-09-26T00:00:00+08:00"),
    endMs: Date.parse("2026-10-03T00:00:00+08:00"),
  };
  assert.equal(countDailySources([inWindow, tooOld], "2026-10-02", window), 1);
  // Under the daily reading the same 6-day-old card would have been excluded,
  // which is exactly the undercount the weekly must not ship.
  assert.equal(countDailySources([inWindow, tooOld], "2026-10-02"), 0);
});

// ---------------------------------------------------------------------------
// The synthesis prompt is what makes the model write a DAY. Fed a week's
// sources under instructions to summarise "当日", it produces seven days of
// material collapsed into "today's" framing and invents an 当日 public-channel
// disclaimer that contradicts the report's own date_range. The weekly variant
// has to be complete, not partly reworded — hence the "no daily token may
// survive" assertion rather than a spot check on the heading.
// ---------------------------------------------------------------------------

test("the daily system prompt is unchanged by the weekly parameterization", () => {
  // The daily prompt ships today; parameterizing it must not perturb a byte of
  // it, or every shipped-note regression in behaviour moves silently.
  assert.equal(SYSTEM_PROMPT, systemPromptFor("daily"));
  assert.equal(SYSTEM_PROMPT, systemPromptFor(undefined));
  assert.match(SYSTEM_PROMPT, /当日/);
  assert.match(SYSTEM_PROMPT, /## 今日焦点/);
  assert.match(SYSTEM_PROMPT, /来源 ≥ 8 条/);
});

test("the weekly system prompt leaks no daily-only wording", () => {
  const p = systemPromptFor("weekly");
  for (const token of ["当日", "今日", "日报"]) {
    assert.ok(!p.includes(token), `weekly prompt must not contain ${token}`);
  }
  assert.match(p, /本周焦点/);
  assert.match(p, /周报/);
  // A placeholder that never got substituted would reach the model verbatim.
  assert.ok(!/\{[a-zA-Z]+\}/.test(p), "no unsubstituted {placeholder} may survive");
});

test("the weekly prompt scales the 栏目 threshold to a week's material", () => {
  // 8 sources is a normal day. A weekly body fed 40 sources and told to
  // "退化为扁平分点列表" under 8 would never trigger that branch, but the
  // converse matters: a week that DID land under 8 is genuinely starved and
  // the prompt must not tell the model the day threshold is met.
  assert.match(systemPromptFor("weekly"), /来源 ≥ 20 条/);
  assert.match(systemPromptFor("weekly"), /（< 20 条）/);
});
