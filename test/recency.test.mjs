// Recency gate tests: filterByRecency must drop stale dated sources, keep
// same-day ones, and pass through timestamp-less sources (tavily/firecrawl).
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterByRecency } from "../src/snippet-hygiene.mjs";

// Beijing date 2026-08-10. Beijing midnight = 2026-08-09T16:00:00Z.
// epoch ms = Date.UTC(2026, 7, 9, 16, 0, 0)
const TODAY = "2026-08-10";
const TODAY_START_MS = Date.UTC(2026, 7, 9, 16, 0, 0);
const BEIJING_2026_08_10_1000 = Date.UTC(2026, 7, 10, 2, 0, 0); // 08-10 10:00 北京
const BEIJING_2026_08_09_2300 = Date.UTC(2026, 7, 9, 15, 0, 0); // 08-09 23:00 北京
const BEIJING_2026_08_08_1000 = Date.UTC(2026, 7, 8, 2, 0, 0); // 08-08 10:00 北京

test("filterByRecency: keeps same-day publishedAt sources", () => {
  const src = [{ url: "a", publishedAt: BEIJING_2026_08_10_1000 }];
  const { sources, dropped } = filterByRecency(src, TODAY);
  assert.equal(sources.length, 1);
  assert.equal(dropped, 0);
});

test("filterByRecency: drops yesterday's publishedAt sources", () => {
  const src = [{ url: "a", publishedAt: BEIJING_2026_08_08_1000 }];
  const { sources, dropped } = filterByRecency(src, TODAY);
  assert.equal(sources.length, 0);
  assert.equal(dropped, 1);
});

test("filterByRecency: closed boundary — source at exactly midnight passes", () => {
  const src = [{ url: "a", publishedAt: TODAY_START_MS }];
  const { sources, dropped } = filterByRecency(src, TODAY);
  assert.equal(sources.length, 1);
  assert.equal(dropped, 0);
});

test("filterByRecency: linux.do style created_at ISO string is honored", () => {
  // 2026-08-09T23:00:00Z = 08-10 07:00 北京 → same day, kept.
  const same = [{ url: "a", created_at: "2026-08-09T15:00:00Z" }];
  // wait, 15:00Z = 23:00 北京 on 08-09 → before midnight → dropped? No:
  // 23:00 Beijing on 08-09 < 08-10 midnight → dropped.
  const { sources: s2 } = filterByRecency(same, TODAY);
  assert.equal(s2.length, 0);
  // 2026-08-10T01:00:00Z = 08-10 09:00 北京 → same day, kept.
  const todayIso = [{ url: "b", created_at: "2026-08-10T01:00:00Z" }];
  const { sources, dropped } = filterByRecency(todayIso, TODAY);
  assert.equal(sources.length, 1);
  assert.equal(dropped, 0);
});

test("filterByRecency: timestamp-less sources pass through", () => {
  const src = [{ url: "a" }, { url: "b", title: "t" }];
  const { sources, dropped } = filterByRecency(src, TODAY);
  assert.equal(sources.length, 2);
  assert.equal(dropped, 0);
});

test("filterByRecency: mixed batch — only stale dated dropped, count correct", () => {
  const src = [
    { url: "same-day", publishedAt: BEIJING_2026_08_10_1000 },
    { url: "yesterday", publishedAt: BEIJING_2026_08_08_1000 },
    { url: "linuxdo-stale", created_at: "2026-08-08T00:00:00Z" },
    { url: "no-ts" },
  ];
  const { sources, dropped } = filterByRecency(src, TODAY);
  assert.equal(dropped, 2);
  assert.deepEqual(
    sources.map((s) => s.url),
    ["same-day", "no-ts"],
  );
});

test("filterByRecency: empty / null input is safe", () => {
  assert.deepEqual(filterByRecency([], TODAY), { sources: [], dropped: 0 });
  assert.deepEqual(filterByRecency(null, TODAY), { sources: [], dropped: 0 });
  assert.deepEqual(filterByRecency(undefined, TODAY), { sources: [], dropped: 0 });
});

test("filterByRecency: invalid date string falls back to pass-through (no crash)", () => {
  const src = [{ url: "a", publishedAt: Date.UTC(2026, 7, 8) }];
  const { sources, dropped } = filterByRecency(src, "not-a-date");
  // NaN todayStart → all comparisons false → all pass through, nothing dropped.
  assert.equal(dropped, 0);
  assert.equal(sources.length, 1);
});