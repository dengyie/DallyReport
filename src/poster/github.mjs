// The GitHub trending poster, laid out rather than painted.
//
// What this replaces, and why it had to be replaced: the previous poster was
// produced by gpt-image-2 from a 6.5KB hand-written template that asked for
// "Top 10" rows with a crown on row 1, "big cards for 1–5, compact list for
// 6–10", a 今日 Star / 总 Star / Fork card on EVERY row, and a 日榜简报 title.
// On a WEEKLY run, OCR of the delivered PNG reads back:
//
//   "2026-09-25 GitHub 日榜简报"      <- a single day, on seven-day numbers
//   "今日 Star"  x10                  <- ten repeated column headers
//   "榜单按今日新增 Star 排序"         <- the same, in the footer
//   教据源 / 记亿系统 / 框织 / 网里巴巴规下   <- corrupted glyphs, identical at
//                                           2x and 4x OCR, so genuinely wrong
//   numerals 30px on rows 1–5, 15px on rows 6–10
//
// The data underneath was correct all along — every repo and every star count
// matched the scrape. What was wrong was the typesetting, and typesetting is
// the one thing a renderer should never delegate to a sampler.

import { escapeHtml, posterShell, posterHeader, POSTER_WIDTH, POSTER_HEIGHT } from "./html.mjs";

// One definition, shared with the image prompt in image-gen.mjs: a prompt that
// describes 15 rows next to a poster that draws 10 is a lie in pixels.
export { GITHUB_POSTER_MAX_ROWS } from "./period.mjs";
import { GITHUB_POSTER_MAX_ROWS } from "./period.mjs";

const CSS = `
  /* Two rules share this template, and the middle track is minmax(0, 1fr) in
     both. A bare 1fr is minmax(auto, 1fr), whose auto minimum is the content's
     min-content WIDTH — so a long owner/repo widens that track and pushes both
     numeric columns past the row's right edge, where the overflow:hidden below
     eats them without a word.

     Measured, 90-character repo name, real Chrome, same page before and after:
     the row box ends at x=1528 (1600 - 72px padding). Before, the total-star
     column ran 1499..1649 — 121 of its 150px outside the box, so four fifths
     of the number was gone while the run still reported success. After,
     1378..1528. A track that may reach zero is also the only thing that gives
     .repo's ellipsis something to clip against. */
  .rank-head {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) 150px 150px;
    gap: 24px;
    padding: 22px 0 14px;
    border-bottom: 1px solid #e8ecf1;
    font-size: 16px; font-weight: 600; letter-spacing: .06em; color: #9aa4b0;
  }
  .rank-head .num { text-align: right; }
  .rows { flex: 1; display: flex; flex-direction: column; }
  .row {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) 150px 150px;
    gap: 24px;
    align-items: center;
    /* One height for every row. Uniformity here is the whole point: the old
       template's two-tier card scheme is what produced the type collapse.
       Sized so ten rows plus header, column head and footer land inside the
       900px frame — the cap above is derived from this, not chosen to match
       the note's row count. */
    height: 50px;
    border-bottom: 1px solid #f2f5f8;
    overflow: hidden;
  }
  .row:last-child { border-bottom: none; }
  .rank { font-size: 21px; font-weight: 600; color: #c3ccd6; }
  .row:first-child .rank { color: #1f6feb; }
  /* The repo name is the only cell that can grow, so it is the only cell that
     needs a clip of its own. One line, marked when it does not fit — a hard
     slice at the row edge reads as a complete name. */
  .repo {
    font-size: 24px; font-weight: 600; letter-spacing: -.005em; line-height: 1.18;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .desc {
    font-size: 15.5px; color: #5b6572; line-height: 1.3; margin-top: 2px;
    /* One line, clipped. A wrapped second line would push this row's height
       and break the uniform rhythm the grid depends on. */
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .delta { text-align: right; font-size: 25px; font-weight: 600; color: #1f6feb; }
  .total { text-align: right; font-size: 18px; color: #9aa4b0; }
  .empty { font-size: 20px; color: #9aa4b0; padding: 40px 0; }
`;

/** Thousands separators. The scrape stores numbers; the poster shows quantities. */
export function formatCount(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Number(n).toLocaleString("en-US");
}

// `starWord` is not a parameter here: the period word is a COLUMN HEADER,
// printed once, above the list. A per-row copy of it is the exact defect the
// old template shipped — "今日 Star" ten times over.
function rankRow(repo, index) {
  const delta = formatCount(repo.starsToday);
  const total = formatCount(repo.starsTotal);
  return `      <div class="row">
        <div class="rank">${index + 1}</div>
        <div>
          <div class="repo">${escapeHtml(repo.repo)}</div>
          ${repo.description ? `<div class="desc">${escapeHtml(repo.description)}</div>` : ""}
        </div>
        <div class="delta">${delta == null ? "" : `+${delta}`}</div>
        <div class="total">${total == null ? "" : escapeHtml(total)}</div>
      </div>`;
}

/**
 * Build the GitHub poster document.
 *
 * `period` is the SAME object shape `githubPosterPeriod` produces in
 * image-gen.mjs, so the diffusion path and this path cannot drift into
 * disagreeing about what day or week they are describing.
 */
export function githubPosterHtml({ repos, period, maxRows = GITHUB_POSTER_MAX_ROWS }) {
  const list = (repos || []).filter(Boolean);
  const shown = list.slice(0, maxRows);
  const dropped = list.length - shown.length;
  const starWord = period?.starWord || "今日 Star";

  // A column header is stated ONCE. The old template asked for a data card per
  // row, and the model duly printed "今日 Star / 总 Star / Fork" ten times.
  const head = `      <div class="rank-head">
        <div>排名</div>
        <div>项目</div>
        <div class="num">${escapeHtml(starWord)}</div>
        <div class="num">总 Star</div>
      </div>`;

  const body = shown.length
    ? `      <div class="rows">\n${shown.map((r, i) => rankRow(r, i)).join("\n")}\n      </div>`
    : `      <div class="empty">本期没有可渲染的仓库数据</div>`;

  // Only mention a cut when there is one. "显示前 4 名" on a list of four is
  // noise that reads as an apology for something that did not happen.
  const footerScope =
    dropped > 0 ? `共 ${list.length} 个项目，显示前 ${shown.length} 名，另有 ${dropped} 个见笔记` : `共 ${list.length} 个项目`;

  return posterShell({
    title: `${period?.weekly ? "本周热门仓库" : "今日热门仓库"} · ${period?.label || ""}`,
    extraCss: CSS,
    bodyHtml: `${posterHeader({
      eyebrow: "GitHub Trending",
      title: period?.weekly ? "本周热门仓库" : "今日热门仓库",
      lede: period?.label || "",
    })}
${head}
${body}
      <div class="rule" style="margin-top:6px"></div>
      <div class="footer" style="margin-top:10px">${escapeHtml(footerScope)} · 数据源 ${escapeHtml(period?.sourceNote || "GitHub Trending")}</div>`,
  });
}

export const GITHUB_POSTER_SIZE = { width: POSTER_WIDTH, height: POSTER_HEIGHT };
