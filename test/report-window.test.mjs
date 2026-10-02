import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMode,
  materialWindowDays,
  windowRange,
  windowLabel,
} from "../src/report-window.mjs";

// ---------------------------------------------------------------------------
// 2026-09-28 weekly report. Before this there was exactly one report shape: a
// single Beijing calendar day. `beijingMidnightMs(config.date)` was recomputed in
// six places and every one of them used it as the LOWER bound of a one-day
// window — so "give me a week of data" could not be expressed anywhere in the
// pipeline without touching all six independently.
//
// This module is the single seam. Everything downstream reads
// `config.windowStartMs` / `config.windowEndMs` and never recomputes a date.
//
// Two properties matter more than the arithmetic:
//   1. The window has an UPPER bound. The old gates were lower-bound-only, so a
//      card with a future timestamp passed. A 7-day window makes that far more
//      likely (clock skew, timezone-mangled pubDate, a feed that posts ahead).
//   2. `windowRange(date, "daily")` must be byte-identical to what the old code
//      computed, or every existing daily regression test becomes meaningless.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const BJ = (s) => Date.parse(`${s}T00:00:00+08:00`);

// 2026-09-28 is a Monday; 2026-10-02 is the Friday that first triggers weekly.
const MONDAY = "2026-09-28";
const FRIDAY = "2026-10-02";
const SATURDAY = "2026-10-03";

test("resolveMode: a Friday resolves to weekly, every other day to daily", () => {
  assert.equal(resolveMode(FRIDAY), "weekly");
  assert.equal(resolveMode(MONDAY), "daily");
  assert.equal(resolveMode(SATURDAY), "daily");
  // Thu 2026-10-01 and Sun 2026-10-04 bracket the Friday.
  assert.equal(resolveMode("2026-10-01"), "daily");
  assert.equal(resolveMode("2026-10-04"), "daily");
});

test("resolveMode: an explicit override beats the weekday", () => {
  // A manual backfill of a Friday's DAILY must not silently become a weekly,
  // and a manual weekly on a Tuesday must be possible without editing the clock.
  assert.equal(resolveMode(FRIDAY, "daily"), "daily");
  assert.equal(resolveMode(MONDAY, "weekly"), "weekly");
  assert.equal(resolveMode(FRIDAY, "auto"), "weekly", "auto is not an override");
});

test("resolveMode: an unknown override is rejected, never guessed", () => {
  // Silently falling back to the weekday would ship a daily note on the one day
  // a weekly was intended, with no error anywhere. run.mjs validates the flag
  // first, but this is the primitive everything else trusts, so it refuses too.
  assert.throws(() => resolveMode(FRIDAY, "weekley"), /REPORT_MODE/);
  assert.throws(() => resolveMode(FRIDAY, "WEEKLY"), /REPORT_MODE/, "case is not normalized");
});

test("resolveMode: an empty override means 'not set', not an error", () => {
  // config.val() already collapses `REPORT_MODE=` in .env to null before this is
  // ever called, so the empty case can only arrive from `--mode ""`. Treating it
  // as auto matches every other env var in the codebase and avoids failing a run
  // over a harmless blank line. The distinction that matters — a non-empty typo
  // throws — is covered by the test above.
  assert.equal(resolveMode(FRIDAY, ""), "weekly");
  assert.equal(resolveMode(FRIDAY, "   "), "weekly");
  assert.equal(resolveMode(FRIDAY, null), "weekly");
  assert.equal(resolveMode(FRIDAY, undefined), "weekly");
});

test("materialWindowDays: weekly spans 7 days, daily spans 1", () => {
  assert.equal(materialWindowDays("weekly"), 7);
  assert.equal(materialWindowDays("daily"), 1);
});

test("windowRange: the daily window is exactly the old one-day computation", () => {
  const w = windowRange(MONDAY, "daily");
  assert.equal(w.startMs, BJ(MONDAY), "start is Beijing midnight of the report date");
  assert.equal(w.endMs, BJ(MONDAY) + DAY, "end is the next Beijing midnight");
  assert.equal(w.startDate, MONDAY);
  assert.equal(w.endDate, MONDAY);
});

test("windowRange: the weekly window covers the previous 6 days plus the report day", () => {
  const w = windowRange(FRIDAY, "weekly");
  assert.equal(w.startDate, "2026-09-26", "6 days before the Friday, inclusive");
  assert.equal(w.endDate, FRIDAY);
  assert.equal(w.startMs, BJ("2026-09-26"));
  assert.equal(w.endMs, BJ(FRIDAY) + DAY);
  assert.equal(w.days, 7);
  // The whole point: a post from 6 days ago survives, one from 7 does not.
  assert.ok(w.startMs <= BJ("2026-09-27"), "day -6 is inside the window");
  assert.ok(w.startMs > BJ("2026-09-25"), "day -7 is outside the window");
});

test("windowRange: a malformed date throws instead of yielding NaN bounds", () => {
  // A NaN windowStart silently disables every recency gate downstream: `ts >= NaN`
  // is false for every card, so the report would collect nothing and look calm.
  assert.throws(() => windowRange("2026-13-99", "daily"), /日期|date/);
  assert.throws(() => windowRange("not-a-date", "daily"), /日期|date/);
  assert.throws(() => windowRange("", "daily"), /日期|date/);
});

test("windowRange: crosses a month boundary correctly", () => {
  // 2026-10-02 minus 6 days lands in September; a naive string slice or
  // month-index subtraction that ignores the borrow would produce 2026-09-26
  // as "2026-10-26" or NaN.
  const w = windowRange("2026-10-02", "weekly");
  assert.equal(w.startDate, "2026-09-26");
  assert.equal(w.startMs, BJ("2026-09-26"));
});

test("windowRange: crosses a year boundary correctly", () => {
  const w = windowRange("2027-01-01", "weekly");
  assert.equal(w.startDate, "2026-12-26");
  assert.equal(w.startMs, BJ("2026-12-26"));
});

test("windowLabel: daily and weekly read differently to a human", () => {
  assert.equal(windowLabel("daily", MONDAY), MONDAY);
  assert.match(windowLabel("weekly", FRIDAY), /2026-09-26\s*~\s*2026-10-02/);
});
