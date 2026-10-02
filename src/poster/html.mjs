// The shared visual system and the HTML shell both posters are built from.
//
// Every function here is PURE: it takes data and returns a string. That is what
// makes the posters testable at all. The previous pipeline asked a diffusion
// model to produce a PNG, so the only available check was a human squinting at
// the image — and the defects that shipped (invented Fork counts, a duplicated
// panel, a truncated list presented as complete) are all invisible to a glance
// and obvious to an assertion on the markup.
//
// DESIGN INTENT — 优雅简洁直抒胸臆, taken literally:
//
//   优雅  Restraint as the ornament. Exactly one accent colour in the whole
//         design system, spent on the numbers that matter and nothing else —
//         in practice the GitHub poster spends it on the star-delta column and
//         the first row's rank, and the AI poster on nothing. Hairline rules
//         instead of cards, shadows and glass. No gradients, no icons, no
//         decoration that does not carry information.
//   简洁  Four type sizes and no more, held constant down the whole list. The
//         old GitHub poster shrank from ~30px to ~15px halfway down its ten
//         rows because the template asked for "big cards for 1–5, compact list
//         for 6–10"; here every row is identical, and when a list is too long
//         for the space, rows are DROPPED and the footer says so.
//   直抒胸臆  A label states its period ("本周新增", not "今日 Star") and never
//         dresses a number it does not have. If a metric was not collected, it
//         is absent — the old prompt printed an em-dash, which the image model
//         helpfully filled with a plausible integer.

/** The one escape hatch between third-party text and the markup. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 1600x900 at 2x. Wide enough for a two-column story grid, short enough that a
// ten-row ranking never has to shrink its type to fit.
export const POSTER_WIDTH = 1600;
export const POSTER_HEIGHT = 900;

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${POSTER_WIDTH}px; height: ${POSTER_HEIGHT}px; }
  body {
    background: #ffffff;
    color: #111418;
    font-family: -apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB",
                 "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    /* Every number in a poster is a measured quantity lined up against another
       measured quantity. Proportional digits make those columns ragged. */
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" 1;
    display: flex;
    flex-direction: column;
    padding: 64px 72px;
  }
  .eyebrow {
    font-size: 19px; font-weight: 600; letter-spacing: .16em;
    color: #8b95a1; text-transform: uppercase;
  }
  .title { font-size: 58px; font-weight: 700; letter-spacing: -.01em; line-height: 1.1; }
  .lede { font-size: 20px; color: #5b6572; line-height: 1.5; }
  .meta { font-size: 18px; color: #9aa4b0; }
  .rule { height: 1px; background: #e8ecf1; }
  .footer { font-size: 17px; color: #9aa4b0; }
`;

/**
 * Wrap a poster body in the document shell.
 *
 * `title` goes into <title> and the accessible name, and is escaped like
 * everything else: for the GitHub poster it contains a repo description.
 *
 * `extraCss` is a TRUST boundary, not an escape hatch like the others: it is
 * concatenated raw into the <style> element, so it must be a module constant
 * and never text derived from a source, a title or a description. No escaping
 * is applied to it, deliberately — `>` and `&` are both legal CSS, and
 * sanitising them would break the stylesheet rather than secure it. The
 * contract is therefore stated here rather than enforced, because the only
 * enforcement that would not be theatre is a rule no call site can violate.
 */
export function posterShell({ title, bodyHtml, extraCss = "" }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}${extraCss}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * The header every poster shares: what this is, over which period, from where.
 *
 * `period` is a single object so the three can never disagree — the exact class
 * of bug that shipped a weekly whose title, column header and footer each named
 * a different span of time.
 *
 * There is deliberately no accent span here. The design system carries one
 * accent colour and it is spent on the GitHub star-delta column, not on
 * decorating a title; a `titleAccent` parameter existed and both callers passed
 * "", so the span and its CSS rule were removed rather than left for a caller
 * that never came.
 */
export function posterHeader({ eyebrow, title, lede, meta }) {
  return `
  <header>
    <div class="eyebrow">${escapeHtml(eyebrow)}</div>
    <div class="title">${escapeHtml(title)}</div>
    ${lede ? `<div class="lede" style="margin-top:14px">${escapeHtml(lede)}</div>` : ""}
  </header>
  <div class="rule" style="margin:32px 0 0"></div>
  ${meta ? `<div class="meta" style="margin-top:18px">${escapeHtml(meta)}</div>` : ""}
  `;
}
