// The one place a report's material window is defined.
//
// Until 2026-09-28 every collector recomputed `beijingMidnightMs(config.date)`
// on its own — six sites across sources-daily.mjs, snippet-hygiene.mjs and
// linuxdo.mjs — and each used it as the LOWER bound of a one-day window. A
// weekly report cannot be expressed in that shape: "give me seven days" would
// mean editing six independent comparisons and hoping they stay in agreement.
//
// So the window is computed once, here, and threaded through config as
// `windowStartMs` / `windowEndMs`. Nothing downstream recomputes a date.
//
// Two properties are load-bearing:
//
//   1. The window is CLOSED on both ends. The historical gates were lower-bound
//      only, so a card with a future timestamp passed every filter. A 7-day
//      window makes that materially more likely (clock skew, a feed that stamps
//      ahead, a pubDate mangled through the wrong timezone), and the failure is
//      silent — the card just looks like very fresh news.
//
//   2. `windowRange(date, "daily")` is byte-identical to the old computation.
//      Every existing daily regression test encodes the one-day behavior; if
//      daily drifted, all of them would be testing the wrong thing.
//
// Pure module: no I/O, no config access, no clock. Everything is a function of
// (dateStr, mode) so the whole surface is directly unit-testable.

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const REPORT_MODES = Object.freeze(["auto", "daily", "weekly"]);

/** Days of material a mode spans. Weekly is a trailing 7 calendar days, daily is 3 calendar days. */
export function materialWindowDays(mode) {
  return mode === "weekly" ? 7 : 3;
}

/**
 * Decide which report shape a run should produce.
 *
 * `auto` (the default) picks weekly on a Beijing Friday and daily otherwise, so
 * launchd keeps its single 09:00 job and the Friday branch lives in code where
 * it is testable. An explicit "daily"/"weekly" always wins — a manual backfill of
 * a Friday's daily must not silently become a weekly, and a weekly on a Tuesday
 * must not require touching the clock.
 */
export function resolveMode(dateStr, override) {
  // Trim first, then treat blank as "not set". config.val() already collapses
  // `REPORT_MODE=` in .env to null, so a blank here can only come from
  // `--mode "  "` on the CLI — which means the same thing: the operator did not
  // express a preference, so the weekday decides.
  const raw = override == null ? "auto" : String(override).trim() || "auto";
  if (!REPORT_MODES.includes(raw)) {
    throw new Error(
      `REPORT_MODE 只能是 ${REPORT_MODES.join(" / ")}，收到 "${override}"`,
    );
  }
  if (raw !== "auto") return raw;
  return beijingWeekday(dateStr) === 5 ? "weekly" : "daily";
}

/** Parse a strict, calendar-valid "YYYY-MM-DD" Beijing date to its epoch ms. */
function beijingMidnightMs(dateStr) {
  if (typeof dateStr !== "string") {
    throw new Error(`无效日期: ${dateStr}（应为合法的 YYYY-MM-DD）`);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`无效日期: ${dateStr}（应为合法的 YYYY-MM-DD）`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Round-trip through the calendar so 2026-02-30 and 2026-13-01 are rejected.
  // A NaN windowStart would silently disable every recency gate downstream:
  // `ts >= NaN` is false for every card, so the run would collect nothing and
  // report it as a quiet day.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new Error(`无效日期: ${dateStr}（应为合法的 YYYY-MM-DD）`);
  }
  return Date.UTC(y, mo - 1, d, 0, 0, 0, 0) - BEIJING_OFFSET_MS;
}

/** Epoch ms → "YYYY-MM-DD" in the Beijing calendar. */
function beijingDateFromMs(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** 1=Monday … 7=Sunday, in Beijing time. */
function beijingWeekday(dateStr) {
  return new Date(beijingMidnightMs(dateStr) + BEIJING_OFFSET_MS).getUTCDay() || 7;
}

/**
 * The closed material window for a run.
 *
 * daily  → [Beijing midnight of dateStr, next Beijing midnight)
 * weekly → [Beijing midnight of (dateStr - 6 days), next Beijing midnight of dateStr)
 *
 * The trailing 7 days are counted as 7 CALENDAR days ending on the report date,
 * so a Friday weekly covers Mon..Fri of the current week plus the previous
 * weekend. The end bound is the END of the report day rather than "now": the
 * weekly runs at 09:00, and a deterministic bound keeps the note identical
 * whether it was generated at 09:00 or backfilled at 23:00. The hours after the
 * run simply contain no cards.
 */
export function windowRange(dateStr, mode) {
  const days = materialWindowDays(mode);
  const endMs = beijingMidnightMs(dateStr) + DAY_MS;
  const startMs = beijingMidnightMs(dateStr) - (days - 1) * DAY_MS;
  return {
    mode: mode === "weekly" ? "weekly" : "daily",
    days,
    startMs,
    endMs,
    startDate: beijingDateFromMs(startMs),
    endDate: beijingDateFromMs(endMs - DAY_MS),
    label: windowLabel(mode, dateStr),
  };
}

/**
 * A per-mode cache key prefix.
 *
 * Every collector memoizes its raw fetch body under a `${date}-...` filename.
 * Without the mode in that name, a weekly backfill on a day the daily already
 * ran reads the DAILY's RSS body and renders a week of "news" from one day's
 * feed — with no error, because the fetch succeeded and the cache hit.
 *
 * The mode is always present rather than only for weekly, so there is no
 * special case to get wrong later; the cost is one cold cache on upgrade.
 */
export function cacheKeyFor(config) {
  const mode = config?.reportMode === "weekly" ? "weekly" : "daily";
  return `${config?.date}-${mode}`;
}

/**
 * The material window for a config object, tolerating a partial one.
 *
 * Production always goes through loadConfig, which sets windowStartMs/windowEndMs
 * for whichever mode it resolved. But most existing tests call a fetcher with a
 * bare `{ date, cacheDir }`, and those must keep behaving exactly as before — so
 * when the window fields are absent we derive a DAILY window from the date.
 *
 * Note it defaults to "daily" rather than consulting the weekday: a bare config
 * has expressed no mode preference, and inferring one from the date would make a
 * test written for a Friday silently collect a week of material. The weekly path
 * only ever arrives through loadConfig, which sets the fields explicitly.
 */
export function materialWindow(config) {
  const startMs = Number(config?.windowStartMs);
  const endMs = Number(config?.windowEndMs);
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    return {
      mode: config.reportMode === "weekly" ? "weekly" : "daily",
      days: Number(config.materialWindowDays) > 0 ? Number(config.materialWindowDays) : 3,
      startMs,
      endMs,
      startDate: config.windowStartDate,
      endDate: config.windowEndDate,
    };
  }
  return windowRange(config?.date, "daily");
}

/**
 * Human-facing span, used in H1, the stdout header and poster captions.
 *
 * Computed from beijingMidnightMs directly rather than by calling windowRange:
 * windowRange calls this to fill its own `label`, so delegating back would
 * recurse. `endDate` is re-derived through the calendar so an unnormalised
 * input cannot leak through into a rendered title.
 */
export function windowLabel(mode, dateStr) {
  if (mode !== "weekly") return dateStr;
  const days = materialWindowDays("weekly");
  const startDate = beijingDateFromMs(beijingMidnightMs(dateStr) - (days - 1) * DAY_MS);
  const endDate = beijingDateFromMs(beijingMidnightMs(dateStr));
  return `${startDate} ~ ${endDate}`;
}
