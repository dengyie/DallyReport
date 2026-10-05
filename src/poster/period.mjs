// The reporting-period vocabulary, in one place, for both renderers.
//
// This module exists because the two poster renderers had drifted, and the
// drift was invisible until the pixels were read back. The shipped 2026-09-25
// weekly labelled seven-day star totals 今日 on all ten GitHub rows and
// footered a single date, because the words were hardcoded to the daily. A
// second, quieter copy of the same numbers then appeared: the GitHub row cap
// was written out as `10` in src/image-gen.mjs (for the image prompt) and again
// as `10` in src/poster/github.mjs (for the layout). They agreed, by luck.
//
// So the rule here is narrow and deliberate: the words, the caps and the
// filenames that both renderers must agree on live here, once. Anything a
// single renderer decides for itself (a CSS column gap, a translation model)
// stays with that renderer.

/** How many GitHub rows the poster shows. The image prompt says the same number. */
export const GITHUB_POSTER_MAX_ROWS = 10;

/**
 * AI story caps, per mode.
 *
 * These are set by what FITS at a readable size in the deterministic poster's
 * 1600x900 frame, not by how much was collected. The legacy diffusion cap is
 * separate and larger (see image-gen.mjs), because a diffusion renderer is
 * inventing a layout and cannot be held to a measured one.
 */
export const AI_POSTER_MAX_STORIES = 8;
export const AI_WEEKLY_POSTER_MAX_STORIES = 10;

/**
 * How many stories a poster shows, given the period and any explicit override.
 *
 * This lived as the same three-line ternary in aiPosterHtml, buildStories,
 * buildStoriesFromBody and the renderer's log line. The cap CONSTANTS were
 * shared, but the decision about which one applied was not — and a fourth copy
 * of the decision is how a log ends up reporting "3/10 条" for a poster that
 * rendered twelve. One function, so the cap a poster DRAWS, the cap the story
 * builders STOP at and the cap the log REPORTS cannot drift apart.
 */
export function resolveStoryCap(period, maxStories) {
  if (Number.isInteger(maxStories) && maxStories > 0) return maxStories;
  return period?.weekly ? AI_WEEKLY_POSTER_MAX_STORIES : AI_POSTER_MAX_STORIES;
}

/**
 * The legacy diffusion path's caps, kept here for the same reason and named for
 * what they are. A diffusion renderer is inventing a layout and cannot be held
 * to a measured one, so it is allowed a larger number — it is simply a
 * different question from "does this fit in 900px".
 */
export const AI_IMAGE_MAX_HEADLINES = 8;
export const AI_IMAGE_WEEKLY_MAX_HEADLINES = 12;

/**
 * Everything the GitHub poster needs to know about the reporting period, in one
 * value. The same shape `aiPosterPeriod` returns, for the same reason: a period
 * word that disagrees with the numbers behind it is the most visible defect in
 * the whole pipeline, and there is no error message when a diffusion renderer
 * paints 今日 over a week's numbers.
 */
export function githubPosterPeriod(config) {
  const weekly = config?.reportMode === "weekly";
  return {
    weekly,
    // windowLabel is derived in config.mjs; a hand-built config may not carry
    // it, and "undefined" rendered into an image is not a recoverable failure.
    label: weekly ? config?.windowLabel || config?.date : config?.date,
    starWord: weekly ? "本周新增" : "今日 Star",
    sortNote: weekly ? "按本周新增 Star 排序" : "按今日新增 Star 排序",
    sourceNote: weekly ? "GitHub Trending Weekly" : "GitHub Trending Daily",
    maxRows: GITHUB_POSTER_MAX_ROWS,
  };
}

/** The same, for the AI poster. */
export function aiPosterPeriod(config) {
  const weekly = config?.reportMode === "weekly";
  return {
    weekly,
    label: weekly ? config?.windowLabel || config?.date : config?.date,
    headlineWord: weekly ? "本周" : "本日",
    maxHeadlines: weekly ? AI_IMAGE_WEEKLY_MAX_HEADLINES : AI_IMAGE_MAX_HEADLINES,
  };
}

/**
 * Re-derive a GitHub period from its one flag.
 *
 * A caller may hand in a partial period (tests do; a future caller holding only
 * a mode flag will too). Every field is therefore re-derived from `weekly`
 * rather than read off the object. Trusting a caller's half-filled object put
 * the literal string "undefined" into the sort note — and that prompt is
 * rendered into pixels, where a missing word is not a recoverable failure.
 * One flag in, one consistent set of words out.
 */
export function normalizeGithubPeriod(period, { date } = {}) {
  const weekly = period?.weekly === true;
  // The date is passed in rather than read off `period`, because `period` is
  // the untrusted half here. Rebuilding the canonical vocabulary from a config
  // that carries no date yields label === undefined, and undefined is what put
  // the literal string "undefined" into the sort note the first time. The
  // caller always knows the date — buildContextualPrompt has it in hand.
  const canonical = githubPosterPeriod({ reportMode: weekly ? "weekly" : "daily", date });
  return {
    weekly,
    label: period?.label || period?.date || canonical.label,
    starWord: canonical.starWord,
    sortNote: canonical.sortNote,
    sourceNote: canonical.sourceNote,
    maxRows: Number.isInteger(period?.maxRows) && period.maxRows > 0 ? period.maxRows : canonical.maxRows,
  };
}

// Both artifacts land in the same dated folder. A rerun or a manual backfill
// must not have one silently overwrite the other.
export function aiPosterFileName(config) {
  // 10-06 ai-daily 共目录覆盖口：ai-daily 与本系统日报同落 Note/AI/DallyReport/<date>/，
  // 海报必须异名（ai-daily.png）防互覆——主系统不传 posterFile 时行为逐字节不变。
  if (config?.posterFile) return config.posterFile;
  return config?.reportMode === "weekly" ? "AI-周报.png" : "AI.png";
}

// Same reasoning for the GitHub poster: on a forced weekly for a date that
// already shipped a daily, "GitHub.png" would have replaced the daily's image
// while its note kept pointing at the same filename.
export function githubPosterFileName(config) {
  return config?.reportMode === "weekly" ? "GitHub-周报.png" : "GitHub.png";
}
