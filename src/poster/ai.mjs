// The AI news poster, laid out rather than painted.
//
// The delivered 2026-09-25 weekly AI poster is the worst artefact this project
// has ever shipped, and OCR of it (at 2x and again at 4x) is the reason:
//
//   "Al Trending Daily" / "DAILY 2026-09-19~2026-09-25"   <- daily branding on a weekly
//   "AI 日报•每日追踪…"                                     <- ditto, in the footer
//   "opencode官方布永久延毁对DeepSeekv4.1f的60葵元"        <- 宣布→布, 延误→延毁, 美元→葵元
//   "总决赛暨颌奖盛典在抗州举行"                            <- 颁奖→颌奖, 杭州→抗州
//   "Evolving programming languages in the Al era （score: 125）"  <- OUR field, painted
//   no occurrence of Copilot / 微软 / WSO2                   <- two briefed stories, gone
//   panels titled 定价与性价比动态 and 知识库更新记录        <- invented; no such stories
//
// None of that is the model's taste. It is a sampler asked to typeset, and the
// two stories it dropped are the two it had no room for after re-printing the
// others. So: two columns, one story per slot, no invented section headings —
// if a category has no stories, the poster has no such heading, because the
// headings are not written by anything, they are simply absent.

import { escapeHtml, posterShell, posterHeader, POSTER_WIDTH, POSTER_HEIGHT } from "./html.mjs";
import { sanitizeSnippet } from "../snippet-hygiene.mjs";
import { stripMarkdown } from "../markdown.mjs";
import { posterBullets, splitOverMergedBullets } from "../prose-tighten.mjs";
import { resolveStoryCap } from "./period.mjs";

// Ten stories, not twelve. The cap is set by what FITS at a readable size in a
// 1600x900 frame, not by how many we collected: at two columns that is five
// rows of title + two lines of summary. The 12-story figure the diffusion
// poster carried was unreachable — which is precisely how the delivered
// 2026-09-25 poster ended up reprinting some stories and dropping others
// (Copilot and WSO2 were simply absent from it).
export { AI_POSTER_MAX_STORIES, AI_WEEKLY_POSTER_MAX_STORIES } from "./period.mjs";

const CSS = `
  .grid {
    flex: 1;
    display: grid;
    /* A bare 1fr here, unlike github.mjs's, and the difference is not an
       oversight. Two reasons make this layout safe with an auto minimum:
       a CJK glyph's min-content width is one glyph (the text breaks anywhere),
       and nothing FOLLOWS these two tracks — the worst a blowout can do is
       clip prose inside a column, never push a number out of the frame, which
       is exactly the failure the GitHub row had. If a poster ever puts a
       measured quantity to the right of a flexible track, this becomes
       minmax(0, 1fr) and so does every track after it. */
    grid-template-columns: 1fr 1fr;
    column-gap: 56px;
    align-content: start;
    margin-top: 4px;
    /* The canvas is a fixed frame, not a scroll region. Anything that would
       overflow is clipped by the browser, silently, which is how a footer
       disappears without a trace. Clipping here is at least visible in the
       markup, and the story cap above is sized so it never triggers. */
    overflow: hidden;
  }
  .story { padding: 15px 0 14px; border-bottom: 1px solid #f2f5f8; }
  .story-title { font-size: 22px; font-weight: 600; line-height: 1.3; letter-spacing: -.003em; }
  .story-sum {
    font-size: 16.5px; color: #5b6572; line-height: 1.42; margin-top: 5px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .empty { font-size: 20px; color: #9aa4b0; padding: 40px 0; }
`;

// No per-story source line. Ten rows each captioned "Hacker News" is the same
// repeated-label defect this change removes from the GitHub poster's ten
// "今日 Star" cards, and the note's reference list already carries attribution.
function storyBlock(story) {
  return `      <div class="story">
        <div class="story-title">${escapeHtml(story.title)}</div>
        ${story.summary ? `<div class="story-sum">${escapeHtml(story.summary)}</div>` : ""}
      </div>`;
}

/**
 * Build the AI news poster document.
 *
 * Stories flow into a two-column grid, filled left column first. Column-first
 * rather than row-first so the reading order down the left column is the
 * ranked order a reader expects from a list.
 */
export function aiPosterHtml({ stories, period, maxStories }) {
  const all = (stories || []).filter((s) => s && s.title);
  const cap = resolveStoryCap(period, maxStories);
  const shown = all.slice(0, cap);
  const dropped = all.length - shown.length;

  // Fill column by column so the first half of the ranked list is the left
  // column, not the top row.
  const half = Math.ceil(shown.length / 2);
  const columns = [shown.slice(0, half), shown.slice(half)];

  const body = shown.length
    ? `      <div class="grid">
${columns
  .filter((c) => c.length)
  .map((c) => `        <div class="col">\n${c.map(storyBlock).join("\n")}\n        </div>`)
  .join("\n")}
      </div>`
    : `      <div class="empty">本期没有可渲染的新闻</div>`;

  const lead = period?.weekly ? "本周 AI 要闻" : "今日 AI 要闻";
  const footNote = dropped > 0 ? `，另有 ${dropped} 条见笔记` : "";

  return posterShell({
    title: lead,
    extraCss: CSS,
    bodyHtml: `${posterHeader({
      eyebrow: "DallyReport",
      title: lead,
      lede: period?.label || "",
    })}
${body}
      <div class="rule" style="margin-top:10px"></div>
      <div class="footer" style="margin-top:12px">共 ${all.length} 条，显示 ${shown.length} 条${escapeHtml(footNote)} · 完整正文见笔记</div>`,
  });
}

export const AI_POSTER_SIZE = { width: POSTER_WIDTH, height: POSTER_HEIGHT };

// --- source cards -> poster stories ---------------------------------------

/** Up to and including the first terminator; no terminator means keep it all. */
export function firstSentence(s) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  const m = t.match(/^[^.!?。！？]*[.!?。！？]/);
  return m ? m[0].trim() : t;
}

/**
 * Turn the section's source cards into poster stories.
 *
 * The hygiene here is not optional. A card's title and snippet are third-party
 * text that lands in a document; the diffusion path ran it through
 * sanitizeSnippet(stripMarkdown(...)) for exactly that reason, and dropping the
 * step would be a regression even though the sink changed from a model prompt
 * to an HTML text node.
 *
 * `summary` is the snippet ONLY when the snippet says something the title does
 * not. An HN link post has no snippet at all now (see hnSummary in
 * sources-daily.mjs); a card whose snippet merely echoes its title gets no
 * summary line, because printing the headline twice is the duplication defect
 * this whole change exists to remove.
 */
export function buildStories(sources, { period, maxStories } = {}) {
  const cap = resolveStoryCap(period, maxStories);
  const stories = [];
  for (const source of sources || []) {
    const title = sanitizeSnippet(stripMarkdown(source?.title), { maxChars: 120 });
    if (!title) continue;
    const rawSummary = sanitizeSnippet(stripMarkdown(source?.snippet), { maxChars: 110 });
    const summary = rawSummary && !sameProse(rawSummary, title) ? firstSentence(rawSummary) : "";
    stories.push({ title, summary });
    if (stories.length >= cap) break;
  }
  return stories;
}

// --- the note body -> poster stories -------------------------------------

// The body, not the source cards, is the better poster input, and the reason is
// visible in the delivered 2026-09-25 weekly. Its 15 cited sources are raw
// third-party headlines — 8 of the first 12 in English ("Evolving programming
// languages in the AI era", "AD-WM: Action-Discriminative World Models for
// Counterfactual Model Predictive Control"), plus forum register ("Termius-MCP
// 让AI接管你的小鸡") and even the diffusion model's own corruption carried
// through the data ("opencode永久延期DeepSeek4.1f用量！"). The same note's body
// already says all of it in finished Chinese sentences with the actor named.
// Putting the body on the poster is therefore both a quality change and the
// only way de-clustering can reach the image at all.

/**
 * Do these two say the same thing?
 *
 * Compared on the prose with sentence punctuation and whitespace stripped. A
 * plain `!==` is defeated by the one character that is always there: a card
 * titled "同题" with snippet "同题。" is the headline printed twice, and the
 * poster's line-clamp will happily spend a whole line on it.
 */
function sameProse(a, b) {
  const norm = (v) => String(v ?? "").replace(/[\s。．.！!？?，,、；;：:]+/g, "");
  return norm(a) === norm(b);
}

// Measured, not guessed. The headline column is 700px wide (a 1600px frame,
// two columns, 56px gutter) and a CJK glyph at 22px measures 22.0px, so 31
// characters fit on one line. A headline that wraps is not merely untidy: the
// two halves land in different OCR boxes, and Vision reads a two-column page
// top-to-bottom, so the halves arrive separated by the other column's text and
// the acceptance check reads a correct poster as missing content. 30 leaves a
// character of slack for the Latin runs, which are narrower than CJK.
//
// A marked cut spends one more character on the ellipsis, and 31 CJK glyphs is
// 682px — still one line. So the widest headline this can produce is
// BODY_TITLE_MAX + 1, and that is the number the layout has to survive.
export const BODY_TITLE_MAX = 30;
const BODY_SUMMARY_MAX = 100;

/**
 * A headline cut at a claim boundary, not a character count.
 *
 * A split-off bullet has no headline of its own, so one is taken from its first
 * sentence — and that sentence is often longer than a headline slot. Cutting at
 * the cap alone produces "…并自主发现了一种与 DNA 序", a sentence sliced off
 * mid-word with nothing to show it was cut. Falling back to the last clause
 * boundary inside the cap ("该公司的一项关于基因编辑的研究引发讨论") ends the
 * headline where the claim ends, which is the same rule the prompt now asks the
 * model for. When there is no boundary at all the cut is marked with an ellipsis
 * rather than passed off as a whole sentence.
 */
function headlineFrom(text, max) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const boundary = Math.max(head.lastIndexOf("，"), head.lastIndexOf("、"), head.lastIndexOf(","));
  // A short complete clause beats a long truncated one, so the floor here is
  // only there to reject a boundary so early that what remains is a fragment
  // ("，其" alone). It is deliberately not a fraction of `max`.
  if (boundary >= 8) return head.slice(0, boundary);
  return `${head.trimEnd()}…`;
}

/**
 * Turn the note's own bullets into poster stories.
 *
 * `splitOverMergedBullets` runs first, so a bullet the model over-merged
 * contributes one slot per event rather than one slot holding three events —
 * which is the entire point of de-clustering.
 *
 * An untitled bullet has no headline of its own, so one is derived from its
 * first sentence, exactly as buildStories does for a source card. Deriving it
 * here rather than handing the whole paragraph over as a "title" is what keeps
 * a long split-off bullet from wrapping to five lines and clipping.
 */
export function buildStoriesFromBody(markdown, { period, maxStories } = {}) {
  const cap = resolveStoryCap(period, maxStories);
  const stories = [];
  for (const bullet of posterBullets(splitOverMergedBullets(markdown || ""))) {
    const text = stripMarkdown(bullet.body);
    const rawTitle = headlineFrom(bullet.titled ? bullet.title : text, BODY_TITLE_MAX);
    const title = sanitizeSnippet(rawTitle, {
      maxChars: BODY_TITLE_MAX + 1, // +1 so headlineFrom's own ellipsis is not re-cut
    });
    if (!title) continue;
    // The summary is whatever the headline did not use. For a bullet with its
    // own headline that is the whole body; for an untitled one it is the text
    // after the headline — including the clause a boundary cut removed, which
    // would otherwise be deleted outright rather than demoted.
    const consumed = bullet.titled ? 0 : rawTitle.replace(/…$/, "").length;
    // The cut usually lands on a clause boundary, so the tail starts with the
    // comma that boundary left behind. A summary opening on punctuation is the
    // sentence the headline was taken from, minus its subject.
    const rawSummary = sanitizeSnippet(text.slice(consumed).replace(/^[，,、；;：:\s]+/, ""), {
      maxChars: BODY_SUMMARY_MAX,
    });
    // Same rule as buildStories: a summary that merely repeats the title is
    // the duplication defect, not extra information.
    const summary = rawSummary && !sameProse(rawSummary, title) ? rawSummary : "";
    stories.push({ title, summary });
    if (stories.length >= cap) break;
  }
  return stories;
}
