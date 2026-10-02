// 2026-09-28 weekly: `?since=weekly` is a DIFFERENT page, not a relabelled one.
// GitHub renders its star delta as "2,633 stars this week" where the daily page
// says "2,633 stars today", and the language label list gains "this month" on
// `?since=monthly`.
//
// The shipped STARS_TODAY_RE anchored on the literal word "today", so against
// the weekly page EVERY row came back with starsToday === null — and line 195's
// `rows.filter(o => o.starsToday != null)` then dropped all 25 repositories,
// producing ok:false with an empty section. Verified against the live page
// before writing this test, not inferred.
//
// The parse is the load-bearing part; the URL and the wording are asserted
// separately so a future refactor cannot pass a URL test while the regex
// silently stops matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrending, trendingUrlFor, starDeltaLabel } from "../src/sections/github-trending.mjs";

// A trimmed but structurally faithful slice of the weekly page: repo block,
// language, description, and the weekly star line.
const WEEKLY_PAGE = [
  "Trending",
  "",
  "Weekly",
  "",
  "1",
  "",
  "owner-a /",
  "repo-a",
  "",
  "TypeScript",
  "",
  "A weekly-windowed description line",
  "",
  "2,633 stars this week",
  "",
  "2",
  "",
  "owner-b /",
  "repo-b",
  "",
  "",
  "2,046 stars this week",
  "",
  "Built by",
].join("\n");

test("the weekly trending page parses: '2,633 stars this week' is a star delta", () => {
  const rows = parseTrending(WEEKLY_PAGE);
  assert.equal(rows.length, 2, "no row may be dropped for lacking a star delta");
  const a = rows.find((r) => r.name === "repo-a");
  assert.equal(a.starsToday, 2633);
});

test("a daily page still parses byte-identically", () => {
  const daily = WEEKLY_PAGE.replace(/stars this week/g, "stars today");
  const rows = parseTrending(daily);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.name === "repo-a").starsToday, 2633);
});

test("'this month' is accepted too, so a future since=monthly is not a silent zero", () => {
  const monthly = WEEKLY_PAGE.replace(/stars this week/g, "stars this month");
  assert.equal(parseTrending(monthly).length, 2);
});

test("a non-star line is still not a star delta", () => {
  // Widening the period token must not turn the description slot into a count.
  const bad = WEEKLY_PAGE.replace("2,633 stars this week", "2633 stars next year");
  const rows = parseTrending(bad);
  assert.equal(rows.find((r) => r.name === "repo-a"), undefined);
});

test("trendingUrlFor points at the requested period", () => {
  assert.match(trendingUrlFor("daily"), /\?since=daily$/);
  assert.match(trendingUrlFor("weekly"), /\?since=weekly$/);
  // Undefined mode is a daily report.
  assert.match(trendingUrlFor(undefined), /\?since=daily$/);
});

test("the table header names the period the numbers actually cover", () => {
  // "今日新增" over a 7-day delta is a factual misstatement in the delivered
  // note, and it is the column the reader sorts by.
  assert.equal(starDeltaLabel("daily"), "今日新增");
  assert.equal(starDeltaLabel("weekly"), "本周新增");
});

// 2026-09-28: running --mode weekly for a date that ALREADY has a daily in the
// vault. The weekly AI note is named AI-周报.md, but the GitHub note was still
// "GitHub" — so a forced weekly for 2026-09-25 would have overwritten that
// Friday's shipped GitHub.md. Both artifacts must carry the period in their
// name or the run is destructive.
import { githubNoteName } from "../src/sections/github-trending.mjs";
import { githubPosterFileName } from "../src/image-gen.mjs";
import { altChannelNoteName } from "../src/config.mjs";

test("the GitHub note name carries the period", () => {
  assert.equal(githubNoteName({ reportMode: "daily" }), "GitHub");
  assert.equal(githubNoteName({ reportMode: "weekly" }), "GitHub-周报");
  assert.equal(githubNoteName({ date: "2026-09-25" }), "GitHub");
});

test("the GitHub poster file name carries the period", () => {
  assert.equal(githubPosterFileName({ reportMode: "daily" }), "GitHub.png");
  assert.equal(githubPosterFileName({ reportMode: "weekly" }), "GitHub-周报.png");
});

test("the alt AI channel name carries the period", () => {
  // resolveAltChannel builds "AI-Gemini" from the model slug; a weekly run for a
  // date that already shipped AI-Gemini.md would clobber it.
  assert.equal(altChannelNoteName({ aiAltFile: "AI-Gemini", reportMode: "daily" }), "AI-Gemini");
  assert.equal(altChannelNoteName({ aiAltFile: "AI-Gemini", reportMode: "weekly" }), "AI-Gemini-周报");
  assert.equal(altChannelNoteName({ aiAltFile: null, reportMode: "weekly" }), "AI-周报-<slug>");
  assert.equal(altChannelNoteName({ aiAltFile: "AI-Gemini.md", reportMode: "weekly" }), "AI-Gemini-周报");
});
