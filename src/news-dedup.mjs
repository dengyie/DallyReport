// Deterministic semantic de-duplication + title normalization for the AI news
// synthesis input.
//
// Why: linux.do's news/34 feed is a high-signal same-day source, but a single
// event (e.g. the recurring ChatGPT/Codex free-quota reset) often spawns many
// posts with wildly different titles — "重置了重置了！", "codex 周一还会重置！",
// "奥特曼又给重置了", "Codex余额已重置，Tibo回应称明天周一会再次重置" are all the
// same story. URL-dedup (mergeSourcesPreferLinuxDo) can't see that, so all of
// them reach the synthesis model, which then has to guess they're one event —
// and the raw titles are often not self-contained ("重置了重置了！" means nothing
// to a reader who missed the context). This module folds same-event clusters
// into a single representative card with a clear, self-contained title.
//
// Deterministic, zero-LLM, fail-safe: a source that matches no cluster passes
// through untouched, and the representative keeps the richest snippet so the
// model still gets the details behind the rewritten headline.

import { sanitizeSnippet } from "./snippet-hygiene.mjs";

// --- Event clusters ---------------------------------------------------------
// Each cluster: { key, match, exclude?, rewrite }.
//   match:   RegExp tested against the raw title (case-insensitive). A source
//            whose title matches is folded into this cluster.
//   exclude: optional RegExp — a title matching BOTH match and exclude is NOT
//            clustered (guards a broad match against a different event).
//   rewrite: (title) => clear self-contained news title, or a plain string.
// The representative of a cluster gets the rewritten title; the other members
// are dropped. Order is preserved: the representative sits where the first
// member was.
const CLUSTERS = [
  {
    // The recurring ChatGPT/Codex free-quota reset (Tibo/OpenAI resets balances).
    // Matches any title whose core event is a quota/balance reset. The
    // reverse-proxy post ("反代Codex，结果Claude账号被封") mentions Codex but its
    // event is a ban, not a reset — it does not match and stays separate.
    key: "quota-reset",
    match: /重置|reset/i,
    exclude: /密码|password/i,
    rewrite: () => "ChatGPT/Codex 额度重置",
  },
  {
    // 115 网盘 API 暂停服务 — two posts, same event.
    key: "cloud-api-pause",
    match: /115.*API.*暂停/i,
    rewrite: () => "115 网盘 API 暂停服务",
  },
  {
    // Apple removed the Qwen extension from its China site — two posts, same event.
    // Real titles put the action between the two entities, either order:
    // "苹果中国官网删除 Apple 智能接入阿里千问使用手册" (苹果→删除→千问) and
    // "苹果貌似撤回了有关Apple智能的千问扩展内容" (苹果→撤回→千问). But the plain
    // combination "苹果…千问" alone must NOT match — the earlier "iPhone 接入千问"
    //合作 news is the opposite event (adding, not removing).
    key: "apple-qwen-removal",
    match: /苹果.*千问.*(?:删除|撤回|下架|移除)|苹果.*(?:删除|撤回|下架|移除).*千问/i,
    rewrite: () => "苹果中国官网删除 Apple 智能接入阿里千问使用手册",
  },
];

// Score a snippet's "substance": real Chinese/English prose counts up; URLs and
// Discourse chrome count down. The representative should carry the most informative
// body, not merely the longest one — a long Cloudflare challenge URL or a
// "Topic list, column headers..." chrome line is longer but useless (observed on
// 2026-08-09: the longest reset-post snippet was a Turnstile URL, so the model got
// almost no real body behind the rewritten headline).
const CJK_RE = /[一-鿿]/gu;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9'./'-]{4,}/g;
const URL_RE = /https?:\/\/\S+/gi;
const CHROME_RE =
  /Topic list|column headers|sortable|Troubleshoot|cdn-cgi|challenges\.cloudflare|turnstile|select all|cancel selecting|linuxdo-attachments|\.(?:png|jpe?g|webp|gif)\b/i;

function snippetSubstanceScore(snippet) {
  const s = String(snippet || "");
  if (!s.trim()) return -Infinity;
  const noUrls = s.replace(URL_RE, " "); // URLs carry no prose — strip before counting
  const cjk = (noUrls.match(CJK_RE) || []).length;
  const latin = (noUrls.match(LATIN_WORD_RE) || []).length;
  const chrome = CHROME_RE.test(s) ? 1 : 0;
  return cjk + latin - chrome * 10;
}

// Among a cluster's members, keep the one with the most substantive snippet — the
// model then sees the rewritten headline plus the most informative body behind it.
function pickRepresentative(members) {
  return members.reduce((best, m) => {
    const score = snippetSubstanceScore(m?.snippet);
    const bestScore = snippetSubstanceScore(best?.snippet);
    return score > bestScore ? m : best;
  }, members[0]);
}

/**
 * Fold same-event sources into a single representative card and rewrite its
 * title to a clear, self-contained news headline. Non-cluster sources pass
 * through unchanged, in order. Returns a NEW array; the input is not mutated.
 *
 * @param {Array<{url:string,title?:string,snippet?:string,provider?:string}>} sources
 * @returns {Array<{url:string,title?:string,snippet?:string,provider?:string}>}
 */
export function dedupeAndNormalizeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return sources || [];

  const clusters = new Map(); // key -> { members: [], firstIndex }
  const out = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const title = String(s?.title || "");
    let matched = null;
    for (const c of CLUSTERS) {
      if (c.match.test(title) && !(c.exclude && c.exclude.test(title))) {
        matched = c;
        break;
      }
    }
    if (matched) {
      if (!clusters.has(matched.key)) {
        clusters.set(matched.key, { members: [], firstIndex: out.length });
        out.push(null); // placeholder for the representative
      }
      clusters.get(matched.key).members.push(s);
    } else {
      out.push(s);
    }
  }

  for (const [key, { members, firstIndex }] of clusters) {
    const cluster = CLUSTERS.find((c) => c.key === key);
    const rep = pickRepresentative(members);
    const rewritten =
      typeof cluster.rewrite === "function" ? cluster.rewrite(rep?.title) : cluster.rewrite;
    out[firstIndex] = {
      ...rep,
      title: sanitizeSnippet(rewritten, { maxChars: 200 }),
    };
  }
  return out;
}
