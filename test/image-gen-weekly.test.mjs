// 2026-09-28 weekly: the AI poster renders a day. Fed a week of headlines it
// would print the Friday's date as "本日" and a "本日 AI 要闻" block over seven
// days of news — the one artefact in the pipeline where a wrong period is
// impossible to miss, because it is rendered as pixels into the vault.
//
// Three period-sensitive things: the {date} substitution, the block heading, and
// the headline cap. The cap matters — 8 is what fits a daily poster, but a
// weekly at 8 would drop four of the twelve stories the week was collected for.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAiContextualPrompt,
  aiPosterPeriod,
  aiPosterFileName,
} from "../src/image-gen.mjs";

const WEEKLY_CONFIG = {
  reportMode: "weekly",
  date: "2026-10-02",
  windowLabel: "2026-09-26 ~ 2026-10-02",
};
const DAILY_CONFIG = { reportMode: "daily", date: "2026-09-28" };

const srcs = (n) => Array.from({ length: n }, (_, i) => ({ title: `AI 标题 ${i + 1}` }));

test("the daily poster prompt is unchanged by the weekly parameterization", () => {
  // The daily poster ships today; the {date} substitution and the 本日 block
  // heading are what a reader sees every morning, so neither may drift.
  const out = buildAiContextualPrompt("base {date}", { date: "2026-09-28", sources: srcs(3) });
  assert.match(out, /本日 AI 要闻/);
  assert.match(out, /海报标题日期用 2026-09-28/);
  assert.ok(!out.includes("{date}"));
  assert.doesNotMatch(out, /~/, "a daily poster must not carry a date range");
});

test("the weekly poster names the span it actually covers", () => {
  const out = buildAiContextualPrompt("base {date}", {
    date: "2026-10-02",
    period: aiPosterPeriod(WEEKLY_CONFIG),
    sources: srcs(3),
  });
  assert.match(out, /本周 AI 要闻/);
  assert.match(out, /2026-09-26 ~ 2026-10-02/);
  assert.doesNotMatch(out, /本日/);
  assert.ok(!out.includes("{date}"));
});

test("a weekly poster carries twelve headlines, a daily still carries eight", () => {
  // 8 is a page-fit for a day. A weekly has proportionally more news, and
  // capping it at the daily number would silently drop the tail of the week.
  const weekly = buildAiContextualPrompt("base {date}", {
    date: "2026-10-02",
    period: aiPosterPeriod(WEEKLY_CONFIG),
    sources: srcs(20),
  });
  assert.match(weekly, /12\. AI 标题 12/);
  assert.doesNotMatch(weekly, /13\. AI 标题 13/);

  const daily = buildAiContextualPrompt("base {date}", { date: "2026-09-28", sources: srcs(20) });
  assert.match(daily, /8\. AI 标题 8/);
  assert.doesNotMatch(daily, /9\. AI 标题 9/);
});

test("the poster file name distinguishes the weekly from the daily", () => {
  // Both land in the same dated folder. On a Friday the daily is not produced,
  // but a rerun of an earlier day, or a manual backfill, must not have one
  // artifact silently overwrite the other.
  assert.equal(aiPosterFileName(DAILY_CONFIG), "AI.png");
  assert.equal(aiPosterFileName(WEEKLY_CONFIG), "AI-周报.png");
  assert.equal(aiPosterFileName({ date: "2026-09-28" }), "AI.png");
});

test("a weekly config missing windowLabel still renders rather than throwing", () => {
  // windowLabel is derived in config.mjs; a hand-built config (tests, ad-hoc
  // calls) may not carry it. The poster must fall back to the report date
  // rather than print "undefined" into a rendered image.
  const p = aiPosterPeriod({ reportMode: "weekly", date: "2026-10-02" });
  assert.equal(p.label, "2026-10-02");
});
