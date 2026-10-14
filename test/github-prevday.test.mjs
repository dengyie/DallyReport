// 2026-10-07 P1: the GitHub section used to read ONLY the same-date cache on a
// fetch failure. On the FIRST run of a day that file does not exist, so a
// transient fetch failure (CF interstitial, gateway 200+HTML, network blip)
// shipped an EMPTY GitHub section. The catch now falls back to the previous
// date's cache file (same period mode) before giving up.
//
// The date arithmetic and mode-key naming are the load-bearing part — the
// fallback is invisible unless they point at the right file — so they are
// tested here as a pure function, no network involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { prevDayTrendingCacheFile, isTransientFetchError } from "../src/sections/github-trending.mjs";

test("prevDayTrendingCacheFile: a daily report points at yesterday's daily cache", () => {
  const config = { date: "2026-10-07", reportMode: "daily", cacheDir: "/c" };
  assert.equal(
    prevDayTrendingCacheFile(config),
    path.join("/c", "2026-10-06-daily-github-trending.txt"),
  );
});

test("prevDayTrendingCacheFile: a weekly report keeps the weekly period key", () => {
  const config = { date: "2026-10-09", reportMode: "weekly", cacheDir: "/c" };
  assert.equal(
    prevDayTrendingCacheFile(config),
    path.join("/c", "2026-10-08-weekly-github-trending.txt"),
  );
});

test("prevDayTrendingCacheFile: crosses the Beijing month boundary", () => {
  // 2026-10-01 minus one day is 2026-09-30, not 2026-10-00.
  const config = { date: "2026-10-01", reportMode: "daily", cacheDir: "/c" };
  assert.equal(
    prevDayTrendingCacheFile(config),
    path.join("/c", "2026-09-30-daily-github-trending.txt"),
  );
});

test("prevDayTrendingCacheFile: crosses the Beijing year boundary", () => {
  const config = { date: "2026-01-01", reportMode: "daily", cacheDir: "/c" };
  assert.equal(
    prevDayTrendingCacheFile(config),
    path.join("/c", "2025-12-31-daily-github-trending.txt"),
  );
});

test("prevDayTrendingCacheFile: the date is parsed as Beijing (UTC+8), not host-local", () => {
  // A host in UTC-6 parsing "2026-10-07" as local midnight would read a DIFFERENT
  // instant than a host in UTC+8, and the derived prev-date could differ on the
  // boundary. The +08:00 suffix pins the instant to Beijing regardless of host.
  const config = { date: "2026-10-07", reportMode: "daily", cacheDir: "/c" };
  const prev = prevDayTrendingCacheFile(config);
  assert.match(prev, /2026-10-06-daily/, "host timezone must not move the prev-date");
});

test("prevDayTrendingCacheFile: leap year handles February 29 correctly in UTC", () => {
  const config = { date: "2024-03-01", reportMode: "daily", cacheDir: "/c" };
  assert.equal(
    prevDayTrendingCacheFile(config),
    path.join("/c", "2024-02-29-daily-github-trending.txt"),
  );
});

// --- isTransientFetchError (2026-10-07 live-test) ---
// On hosts behind GFW, github.com:443 connect timeouts are intermittent: 2 of 3
// probes succeeded a minute apart. A retry on a transient transport error would
// catch each of those; the helper is the gate — if it misses a transient class,
// that class will not be retried and the section will fall back to prev-day cache
// on what could have been a recoverable blip.

test("isTransientFetchError: connect timeout message → true", () => {
  const err = new Error("grok-search fetch.js 退出码 1：fetch failed: Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)");
  assert.equal(isTransientFetchError(err), true);
});

test("isTransientFetchError: child timed out (our watchdog) → true", () => {
  const err = new Error("grok-search fetch.js 超时（120000ms 无响应）");
  err.timedOut = true;
  assert.equal(isTransientFetchError(err), true);
});

test("isTransientFetchError: generic fetch failed → true", () => {
  const err = new Error("grok-search fetch.js 退出码 1：fetch failed: some upstream error");
  assert.equal(isTransientFetchError(err), true);
});

test("isTransientFetchError: ECONNRESET → true", () => {
  const err = new Error("grok-search fetch.js 退出码 1：ECONNRESET at github.com:443");
  assert.equal(isTransientFetchError(err), true);
});

test("isTransientFetchError: a non-network error (parse miss) → false", () => {
  const err = new Error("grok-search fetch.js 退出码 1：Cannot parse response");
  assert.equal(isTransientFetchError(err), false);
});

test("isTransientFetchError: null / undefined → false", () => {
  assert.equal(isTransientFetchError(null), false);
  assert.equal(isTransientFetchError(undefined), false);
});
