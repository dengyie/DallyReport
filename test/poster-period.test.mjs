import { test } from "node:test";
import assert from "node:assert/strict";

import * as period from "../src/poster/period.mjs";
import * as imageGen from "../src/image-gen.mjs";
import { GITHUB_POSTER_MAX_ROWS } from "../src/poster/github.mjs";
import { aiPosterHtml, buildStories, buildStoriesFromBody, AI_POSTER_MAX_STORIES, AI_WEEKLY_POSTER_MAX_STORIES } from "../src/poster/ai.mjs";

// This module is the fix for a specific, observed failure: the shipped
// 2026-09-25 weekly labelled seven-day star totals 今日 on all ten rows, and
// the GitHub row cap existed as a literal `10` in two files at once. These
// tests are the guard against that coming back, and they are written as
// identity checks on purpose — asserting the same function object cannot be
// satisfied by two copies that happen to agree today.

const DAILY = { date: "2026-09-28", reportMode: "daily" };
const WEEKLY = { date: "2026-10-02", reportMode: "weekly", windowLabel: "2026-09-26 ~ 2026-10-02" };

test("the image path and the layout path read one period policy", () => {
  // If these ever stop being the same function, a second copy of the
  // vocabulary exists and the two renderers can drift again.
  for (const name of ["githubPosterPeriod", "aiPosterPeriod", "aiPosterFileName", "githubPosterFileName"]) {
    assert.equal(imageGen[name], period[name], `${name} must be one function, not two copies`);
  }
});

test("the GitHub row cap is the same number in the prompt and on the poster", () => {
  assert.equal(GITHUB_POSTER_MAX_ROWS, period.GITHUB_POSTER_MAX_ROWS);
  assert.equal(period.githubPosterPeriod(DAILY).maxRows, GITHUB_POSTER_MAX_ROWS);
  assert.equal(period.githubPosterPeriod(WEEKLY).maxRows, GITHUB_POSTER_MAX_ROWS);
});

test("the period label falls back to the date rather than rendering undefined", () => {
  // A hand-built config with no windowLabel must not put the literal string
  // "undefined" into an image.
  assert.equal(period.githubPosterPeriod({ reportMode: "weekly", date: "2026-10-02" }).label, "2026-10-02");
  assert.equal(period.aiPosterPeriod({ reportMode: "weekly", date: "2026-10-02" }).label, "2026-10-02");
  assert.equal(period.githubPosterPeriod(WEEKLY).label, "2026-09-26 ~ 2026-10-02");
});

test("a weekly says 本周 everywhere and 今日 nowhere", () => {
  const g = period.githubPosterPeriod(WEEKLY);
  assert.equal(g.starWord, "本周新增");
  assert.equal(g.sortNote, "按本周新增 Star 排序");
  assert.equal(g.sourceNote, "GitHub Trending Weekly");
  for (const v of [g.starWord, g.sortNote, g.sourceNote, g.label]) {
    assert.doesNotMatch(v, /今日/, `a weekly must not say 今日: ${v}`);
  }
  const d = period.githubPosterPeriod(DAILY);
  assert.equal(d.starWord, "今日 Star");
  assert.equal(period.aiPosterPeriod(WEEKLY).headlineWord, "本周");
  assert.equal(period.aiPosterPeriod(DAILY).headlineWord, "本日");
});

test("normalizeGithubPeriod re-derives every word from the one flag", () => {
  // The bug: a partial period reached the prompt and put "undefined" into the
  // sort note, which is rendered into pixels.
  const n = period.normalizeGithubPeriod({ weekly: true }, { date: "2026-10-02" });
  assert.equal(n.starWord, "本周新增");
  assert.equal(n.sortNote, "按本周新增 Star 排序");
  assert.equal(n.sourceNote, "GitHub Trending Weekly");
  for (const v of Object.values(n)) {
    assert.notEqual(v, undefined, "no field may be undefined");
    assert.doesNotMatch(String(v), /undefined/, `no field may read "undefined": ${v}`);
  }
  assert.equal(n.label, "2026-10-02", "the caller's date is used, not undefined");
  // A missing flag is the daily, not a crash.
  assert.equal(period.normalizeGithubPeriod(undefined, { date: "2026-09-28" }).starWord, "今日 Star");
  assert.equal(period.normalizeGithubPeriod(undefined, { date: "2026-09-28" }).label, "2026-09-28");
});

test("the AI story caps and the legacy image caps are distinct and both declared here", () => {
  // They differ on purpose: the deterministic poster is sized to fit 900px,
  // and a diffusion renderer cannot be held to a measured layout.
  assert.equal(AI_POSTER_MAX_STORIES, period.AI_POSTER_MAX_STORIES);
  assert.equal(AI_WEEKLY_POSTER_MAX_STORIES, period.AI_WEEKLY_POSTER_MAX_STORIES);
  assert.equal(period.aiPosterPeriod(DAILY).maxHeadlines, period.AI_IMAGE_MAX_HEADLINES);
  assert.equal(period.aiPosterPeriod(WEEKLY).maxHeadlines, period.AI_IMAGE_WEEKLY_MAX_HEADLINES);
  assert.ok(
    period.AI_IMAGE_WEEKLY_MAX_HEADLINES > AI_WEEKLY_POSTER_MAX_STORIES,
    "the legacy cap is the looser one; they are not meant to converge by accident"
  );
});

test("the story cap is decided by one function, not by four copies of the rule", () => {
  // The same three-line ternary used to sit in aiPosterHtml, buildStories,
  // buildStoriesFromBody and the renderer's log line. The cap CONSTANTS are
  // shared, but the DECISION about which one applies was not — and a fourth
  // place recomputing it is how the log ends up claiming "3/10" for a poster
  // that rendered twelve.
  assert.equal(period.resolveStoryCap(undefined, undefined), AI_POSTER_MAX_STORIES);
  assert.equal(period.resolveStoryCap({ weekly: false }, undefined), AI_POSTER_MAX_STORIES);
  assert.equal(period.resolveStoryCap({ weekly: true }, undefined), AI_WEEKLY_POSTER_MAX_STORIES);
  assert.equal(period.resolveStoryCap({ weekly: true }, 3), 3, "an explicit override wins");
  assert.equal(period.resolveStoryCap({ weekly: true }, 0), AI_WEEKLY_POSTER_MAX_STORIES, "0 is not an override");
  assert.equal(period.resolveStoryCap({ weekly: true }, -1), AI_WEEKLY_POSTER_MAX_STORIES, "nor is a negative");
  assert.equal(period.resolveStoryCap({ weekly: true }, 2.5), AI_WEEKLY_POSTER_MAX_STORIES, "nor a fraction");
});

test("every AI poster cap consumer resolves it the same way", () => {
  // Behavioural rather than identity: what matters is that the cap the poster
  // DRAWS, the cap the two story builders STOP at and the cap the log REPORTS
  // cannot drift apart.
  for (const weekly of [true, false]) {
    const p = { weekly };
    const expected = weekly ? AI_WEEKLY_POSTER_MAX_STORIES : AI_POSTER_MAX_STORIES;
    const stories = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}` }));
    const drawn = (aiPosterHtml({ stories, period: p }).match(/class="story"/g) || []).length;
    const fromBody = buildStoriesFromBody(
      Array.from({ length: 20 }, (_, i) => `* **标题${i}**：正文 ${i} [${i + 1}]。`).join("\n"),
      { period: p },
    ).length;
    const fromCards = buildStories(Array.from({ length: 20 }, (_, i) => ({ title: `T${i}` })), { period: p }).length;
    assert.equal(drawn, expected, "the cap the poster draws");
    assert.equal(fromBody, expected, "the cap the body builder stops at");
    assert.equal(fromCards, expected, "the cap the fallback builder stops at");
  }
});

test("filenames keep a forced weekly from overwriting that date's daily image", () => {
  assert.equal(period.githubPosterFileName(DAILY), "GitHub.png");
  assert.equal(period.githubPosterFileName(WEEKLY), "GitHub-周报.png");
  assert.equal(period.aiPosterFileName(DAILY), "AI.png");
  assert.equal(period.aiPosterFileName(WEEKLY), "AI-周报.png");
});
