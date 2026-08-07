// linux.do forum AI-news source collector.
//
// Why this exists: the generic AI search (Tavily/Firecrawl extras) heavily returns
// Chinese aggregator sites (sina/163/podcasts) and almost never surfaces linux.do,
// even though the forum's 「前沿快讯」category is a high-signal same-day AI feed
// (DeepSeek releases, model leaderboards, Gemini rumors, etc.). User asked to
// prioritize linux.do AI content in the daily AI report.
//
// Approach:
//   1. Fetch a small set of category/tag listing pages via grok-search fetch.js
//      (Tavily Extract / Firecrawl / direct — same stack as GitHub trending).
//   2. Parse topic links out of the markdown/HTML extract.
//   3. Keep only AI-related titles; drop meta/sticky posts.
//   4. Deep-fetch the top-N newest topic pages for richer snippets.
//   5. Return sources shaped like grok-search extras so ai-news can merge them.
//
// Isolation: any failure returns [] so the AI section still runs on general sources.

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { runFetch } from "./grok-cli.mjs";
import { sanitizeSnippet, isInjectionOnlySource } from "./snippet-hygiene.mjs";
import { AI_TITLE_RE } from "./community.mjs";

// Listing pages that concentrate AI / frontier news. Discourse category ids observed
// live on 2026-07-31: 前沿快讯 = /c/news/34, 人工智能 tag = /tag/444-tag/444.
export const DEFAULT_LIST_URLS = [
  "https://linux.do/c/news/34",
];

// Title must match at least one of the shared AI tokens to count as AI-related.
// The shared regex (community.mjs) covers model names, tooling, and platform chatter
// across all three forums (linux.do / nodeseek / v2ex).

// Drop non-content / sticky / clearly off-topic noise even if keyword-adjacent.
const EXCLUDE_TITLE_RE =
  /关于[“"「].*(类别|分类|板块)|社区准则|邀请函|办卡|运营商|学费|步枪|ddr5.*步枪/i;

// Promo/ads that dominate the AI tag page. We still keep them if they carry a
// concrete model/pricing signal (降价/正式版/发布), but pure "注册送刀" ads rank last.
const PROMO_TITLE_RE =
  /注册送|送\d+\s*\$|倍率|中转站|合租|拼车|羊毛|充值福利|长期服务|富可敌国/i;

/**
 * Parse topic {url, title, id} entries out of a fetched linux.do listing page.
 * The extractors return markdown-ish tables with `[title](https://linux.do/t/topic/ID)`.
 * Exported for unit tests.
 */
export function parseLinuxDoTopics(text) {
  if (!text) return [];
  const re = /\[([^\]]{2,200})\]\((https:\/\/linux\.do\/t\/topic\/(\d+)(?:\/\d+)?)\)/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = cleanTitle(m[1]);
    const id = Number.parseInt(m[3], 10);
    const url = `https://linux.do/t/topic/${id}`;
    if (!title || !Number.isFinite(id)) continue;
    if (seen.has(url)) continue;
    seen.set(url, { url, title, id });
  }
  return [...seen.values()];
}

function cleanTitle(raw) {
  return String(raw || "")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Given a Beijing (UTC+8) date string YYYY-MM-DD, return [startLocal, endLocal)
 * epoch ms for filtering Discourse `created_at` (UTC) fields.
 * Exported for unit tests.
 */
export function beijingDayRange(dateStr) {
  const startLocal = new Date(`${dateStr}T00:00:00+08:00`).getTime();
  const endLocal = startLocal + 24 * 3600 * 1000;
  return { startLocal, endLocal };
}

/** True if a topic title looks like AI/LLM news worth putting in the daily report. */
export function isAiRelatedTopic(title) {
  if (!title) return false;
  if (EXCLUDE_TITLE_RE.test(title)) return false;
  return AI_TITLE_RE.test(title);
}

/** Rank score: newer topic ids first; pure promo ads sink to the bottom. */
export function rankLinuxDoTopic(topic) {
  const id = topic?.id || 0;
  const promo = PROMO_TITLE_RE.test(topic?.title || "") ? 1 : 0;
  // Higher is better. Promo penalty is large enough to sink ads below real news
  // but not so large that a brand-new promo outranks nothing when the feed is thin.
  return id - promo * 1_000_000;
}

/**
 * Pick the top-N AI topics from a parsed list, ranked by rankLinuxDoTopic.
 * Exported for unit tests.
 */
export function selectAiTopics(topics, { limit = 8 } = {}) {
  return (topics || [])
    .filter((t) => isAiRelatedTopic(t.title))
    .sort((a, b) => rankLinuxDoTopic(b) - rankLinuxDoTopic(a))
    .slice(0, Math.max(0, limit));
}

// Pull a usable snippet from a topic page extract. Discourse HTML extracts are noisy
// (guidelines banner, avatars, related-topic tables). Prefer long CJK/Latin body
// paragraphs; skip chrome and link-only lines. Exported for unit tests.
export function snippetFromTopicText(text, title, maxChars = 500) {
  if (!text) return "";
  let body = String(text);
  // Drop common Discourse chrome early so it never becomes the "first paragraph".
  body = body
    .replace(/\[Skip to[^\]]*\]\([^)]+\)/gi, "")
    .replace(/\*\*真诚\*\*[^*]*\*\*专业\*\*[^\n]*/g, "")
    .replace(/真诚[、,，]\s*友善[\s\S]{0,120}社区准则[^\n]*/g, "")
    .replace(/You have selected[\s\S]{0,120}cancel selecting/gi, "")
    .replace(/!\[.*?\]\([^)]+\)/g, "")
    .replace(/\[[^\]]{0,80}\]\(https?:\/\/[^)]+\)/g, " ") // bare md links often just chrome
    .replace(/\|[^\n]*\|/g, " ") // related-topic tables
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const chromeRe =
    /^(views?|likes?|users?|post by|jul |jan |feb |mar |apr |may |jun |aug |sep |oct |nov |dec |\d+\s*\/\s*\d+|select all|cancel selecting|\d+m|\d+h|\d+d)$/i;
  const titleNorm = title ? title.replace(/\s+/g, "") : "";

  const paras = body
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 24)
    .filter((p) => !/^#/.test(p))
    .filter((p) => !chromeRe.test(p))
    .filter((p) => !/^\[?前沿快讯|^- \[人工智能/i.test(p))
    .filter((p) => !/社区准则|真诚.*友善.*团结.*专业/.test(p))
    .filter((p) => (titleNorm ? p.replace(/\s+/g, "").indexOf(titleNorm) === -1 : true))
    // Need real prose, not a leftover nav crumb.
    .filter((p) => /[一-鿿A-Za-z0-9]/.test(p));

  // Prefer the longest content-ish paragraph (forum OP is usually the densest),
  // but skip paragraphs that become empty after injection sanitization. This avoids
  // selecting a long forum policy banner over a shorter, legitimate OP paragraph.
  paras.sort((a, b) => b.length - a.length);
  const candidates = paras.filter(
    (p) => p.length >= 40 && /[一-鿿]{6,}|[A-Za-z]{12,}/.test(p),
  );
  const pick =
    candidates.find((p) => sanitizeSnippet(p, { maxChars })) ||
    paras.find((p) => sanitizeSnippet(p, { maxChars })) ||
    "";
  if (!pick) return "";
  // Strip any prompt-injection preamble before the snippet leaves this module.
  return sanitizeSnippet(pick, { maxChars });
}

// Maximum chars per JSON API page fetch. The JSON response for 30 topics is ~86KB,
// so we set a generous limit to avoid truncation mid-JSON.
const JSON_API_MAX_CHARS = 400000;
// Max pages to fetch as a safety backstop (a busy day needs ~3 pages of 30).
const JSON_API_MAX_PAGES = 8;

/**
 * Parse the Discourse JSON API response from a fetched page. Strips the optional
 * ```json fence that grok-search fetch.js may wrap around the JSON body. Returns
 * the topics array, or null on failure. Exported for unit tests.
 */
export function extractJsonApiTopics(text) {
  if (!text) return null;
  try {
    // runFetch returns the page content directly (envelope already stripped by
    // grok-cli.mjs). Strip optional ```json fence that firecrawl/tavily may wrap.
    let raw = String(text).trim();
    raw = raw.replace(/^```json\s*/s, "").replace(/```\s*$/s, "");
    return JSON.parse(raw).topic_list?.topics || null;
  } catch {
    return null;
  }
}

/**
 * Fetch ALL today's topics from linux.do/c/news/34 via the Discourse JSON API,
 * paginating until hitting posts older than the Beijing target date. Returns
 * source cards (NOT AI-filtered, no cap) with Discourse excerpts as snippets.
 * On failure returns [] (non-fatal). Exported for unit tests.
 */
// Read the raw JSON text of a linux.do Discourse page using the user's login
// cookie, bypassing the provider stack (Tavily/Firecrawl) whose snapshot/rate
// limits can truncate deeper pages and miss same-day posts. Returns the JSON text
// when it looks like real JSON, else null (challenge page / browser offline) so
// the caller can fall back to the provider stack and never lose data.
//
// Cloudflare's cf_clearance cookie is bound to the browser's TLS fingerprint, so
// a raw undici fetch reusing it gets a 403 "Just a moment…" challenge even with a
// valid logged-in cookie. The reliable client is the user's real Chrome (same
// fingerprint as the login). So fetchLinuxDoJsonPageWithBrowser drives that via the
// DevTools protocol, and fetchLinuxDoJsonPageWithCookie retries undici as a result.
async function fetchLinuxDoJsonPageWithBrowser(url, cookie, cdpHost) {
  let target;
  try {
    const res = await fetch(`http://${cdpHost}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    target = await res.json();
  } catch {
    return null;
  }
  let ws;
  try {
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    let n = 0;
    const pend = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++n; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    });
    await send("Runtime.enable");
    // Wait for the JSON to render as the tab's body text (Chrome displays a .json
    // document as text). Poll up to ~15s; stop once it looks like JSON.
    let text = null;
    for (let i = 0; i < 30; i++) {
      const { result } = await send("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText : null",
        returnByValue: true,
      });
      const bodyText = result?.result?.value;
      if (bodyText && String(bodyText).trimStart().startsWith("{")) { text = bodyText; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    ws.close();
    return text;
  } catch {
    try { ws?.close(); } catch { /* ignore */ }
    try {
      await fetch(`http://${cdpHost}/json/close/${target.id}`, { method: "PUT" }).catch(() => {});
    } catch { /* ignore */ }
    return null;
  } finally {
    // Always close the throwaway tab so we don't accumulate browser windows.
    try { await fetch(`http://${cdpHost}/json/close/${target?.id}`, { method: "PUT" }).catch(() => {}); } catch { /* ignore */ }
  }
}

// Cookie-driven JSON fetch: try the real Chrome (CDP) first; if unreachable, fall
// back to a bare undici request (which is usually Cloudflare-403 and thus null).
async function fetchLinuxDoJsonPageWithCookie(url, cookie, config) {
  try {
    if (config.linuxdoCdpHost) {
      const browserText = await fetchLinuxDoJsonPageWithBrowser(url, cookie, config.linuxdoCdpHost);
      if (browserText) return browserText;
    }
    // Bare client — TLS fingerprint ≠ browser, so expect a 403; surfacing null lets
    // the caller fall back to the provider stack rather than return empty.
    const res = await fetch(url, {
      headers: {
        Cookie: cookie,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        Accept: "application/json, text/plain, */*",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const txt = await res.text();
    return txt && txt.trimStart().startsWith("{") ? txt : null;
  } catch {
    return null;
  }
}

export async function fetchNews34ViaJsonApi(config, deps = {}) {
  if (!config.date) return [];
  const doFetch = deps.runFetch || runFetch;
  const { startLocal, endLocal } = beijingDayRange(config.date);
  const allTopics = [];

  for (let page = 1; page <= JSON_API_MAX_PAGES; page++) {
    const url = `https://linux.do/c/news/34.json?page=${page}`;
    let topics;
    try {
      // Cookie path first: a login cookie lets us read deeper pages verbatim.
      // It tries the user's real Chrome (via CDP) first — the only client whose
      // TLS fingerprint clears Cloudflare's cf_clearance — then a raw undici call
      // (usually 403 → null). On null we FALL BACK to the provider stack so we
      // never lose data when the browser isn't open (scheduled runs).
      let text = null;
      if (config.linuxdoCookie) {
        const fetchPage = deps.fetchJsonPage || fetchLinuxDoJsonPageWithCookie;
        text = await fetchPage(url, config.linuxdoCookie, config);
      }
      if (text == null) {
        const cacheFile = path.join(
          config.cacheDir,
          `${config.date}-linuxdo-news34-page-${page}.txt`,
        );
        const res = await doFetch(url, config, {
          maxChars: JSON_API_MAX_CHARS,
          provider: "auto",
          cacheFile,
        });
        text = res?.text ?? null;
      }
      if (text == null) break;
      topics = extractJsonApiTopics(text);
    } catch {
      break;
    }
    if (!topics || !topics.length) break;

    const lastTopic = topics[topics.length - 1];
    const lastMs = new Date(lastTopic.created_at).getTime();

    // Collect topics within the Beijing target day
    for (const t of topics) {
      const tMs = new Date(t.created_at).getTime();
      if (tMs >= startLocal && tMs < endLocal) allTopics.push(t);
    }

    // Stop when the entire page is older than the target day (created_at desc)
    if (lastMs < startLocal) break;
  }

  // Convert to source cards with excerpt as snippet
  return allTopics.map((t) => ({
    url: `https://linux.do/t/topic/${t.id}`,
    title: sanitizeSnippet(t.title, { maxChars: 200 }),
    snippet: t.excerpt
      ? sanitizeSnippet(t.excerpt, { maxChars: 500 })
      : `linux.do 前沿讨论：${t.title}`,
    provider: "linux.do",
    score: t.id,
    id: t.id,
    created_at: t.created_at,
  }));
}

/**
 * Fetch linux.do AI sources for the daily report.
 *
 * @param {object} config loadConfig() output
 * @param {object} [deps]
 * @param {typeof runFetch} [deps.runFetch] inject for tests
 * @returns {Promise<Array<{url:string,title:string,snippet:string,provider:string,score?:number}>>}
 */
export async function fetchLinuxDoAiSources(config, deps = {}) {
  if (config.linuxdoEnabled === false) return [];

  const doFetch = deps.runFetch || runFetch;
  const listUrls = (config.linuxdoListUrls && config.linuxdoListUrls.length)
    ? config.linuxdoListUrls
    : DEFAULT_LIST_URLS;
  const topicLimit = config.linuxdoTopicLimit ?? 8;
  const deepFetch = config.linuxdoDeepFetch !== false;
  const maxChars = config.fetchMaxChars || 50000;
  const jsonApiEnabled = config.linuxdoNews34JsonApi !== false;

  // 1a) Fetch news/34 via Discourse JSON API (all today's posts, no AI filter).
  const jsonApiCards = jsonApiEnabled ? await fetchNews34ViaJsonApi(config, deps) : [];

  // 1b) HTML listing pages (AI tag page, and news/34 as fallback) — best-effort.
  const listTexts = [];
  const listingFailures = [];
  const deepFetchFailures = [];
  const cacheWriteFailures = [];
  const cacheFiles = [];
  let usedCache = false;
  await Promise.all(
    listUrls.map(async (url, i) => {
      try {
        const cacheFile = path.join(
          config.cacheDir,
          `${config.date}-linuxdo-list-${i}.txt`,
        );
        const res = await doFetch(url, config, {
          maxChars,
          provider: "auto",
          cacheFile,
        });
        if (res?.text) listTexts.push(res.text);
        if (res?.cacheWriteError) {
          cacheWriteFailures.push({
            url,
            cacheFile: res.cacheFile || cacheFile,
            ...res.cacheWriteError,
          });
        }
        if (res?.fromCache) {
          usedCache = true;
          if (res.cacheFile || cacheFile) cacheFiles.push(res.cacheFile || cacheFile);
        }
      } catch (error) {
        listingFailures.push({ url, message: error?.message || String(error) });
      }
    }),
  );

  // 2) Parse HTML listings → dedupe → AI-filter → rank.
  const allTopics = [];
  const seen = new Set();
  for (const text of listTexts) {
    for (const t of parseLinuxDoTopics(text)) {
      if (seen.has(t.url)) continue;
      seen.add(t.url);
      allTopics.push(t);
    }
  }
  const htmlSelected = allTopics.length
    ? selectAiTopics(allTopics, { limit: topicLimit })
    : [];

  // 3) Combine: JSON API cards (all today, no AI filter) + HTML selected (AI-filtered).
  //    JSON API cards first, sorted by created_at desc (newest first).
  //    HTML cards appended, deduped by URL.
  const combined = [];
  const combinedUrls = new Set();
  const sortedJson = [...jsonApiCards].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  for (const c of sortedJson) {
    if (combinedUrls.has(c.url)) continue;
    combinedUrls.add(c.url);
    combined.push(c);
  }
  for (const t of htmlSelected) {
    if (combinedUrls.has(t.url)) continue;
    combinedUrls.add(t.url);
    combined.push({
      url: t.url,
      title: sanitizeSnippet(t.title, { maxChars: 200 }),
      snippet: `linux.do 前沿讨论：${t.title}`,
      provider: "linux.do",
      score: rankLinuxDoTopic(t),
      id: t.id,
    });
  }

  if (!combined.length) {
    const empty = [];
    if (!jsonApiCards.length && listingFailures.length) {
      Object.defineProperty(empty, "linuxdoError", {
        value: { kind: "listing", failures: listingFailures },
        enumerable: false,
      });
    }
    attachCacheMetadata(empty, usedCache, cacheFiles);
    attachDiagnostics(empty, { listingFailures, deepFetchFailures, cacheWriteFailures });
    return empty;
  }

  // 4) Deep-fetch top-N of combined for enriched snippets (optional).
  //    When the JSON API path is active, deep-fetch up to LINUXDO_NEWS34_DEEP_FETCH_LIMIT
  //    (default 12) of today's cards — independent of topicLimit so the all-posts
  //    capture actually gets body context. Otherwise fall back to the legacy
  //    min(topicLimit, LINUXDO_DEEP_FETCH_LIMIT).
  const deepLimit = jsonApiEnabled
    ? Math.min(combined.length, config.linuxdoNews34DeepLimit ?? 12)
    : Math.min(combined.length, topicLimit, config.linuxdoDeepFetchLimit ?? 5);
  const sources = [];
  const deepTargets = deepFetch ? combined.slice(0, deepLimit) : [];
  const deepMap = new Map();

  if (deepTargets.length) {
    await Promise.all(
      deepTargets.map(async (card) => {
        try {
          const cacheFile = path.join(
            config.cacheDir,
            `${config.date}-linuxdo-topic-${card.id}.txt`,
          );
          const res = await doFetch(card.url, config, {
            maxChars: Math.min(maxChars, 12000),
            provider: "auto",
            cacheFile,
          });
          if (res?.cacheWriteError) {
            cacheWriteFailures.push({
              url: card.url,
              cacheFile: res.cacheFile || cacheFile,
              ...res.cacheWriteError,
            });
          }
          if (res?.fromCache) {
            usedCache = true;
            if (res.cacheFile || cacheFile) cacheFiles.push(res.cacheFile || cacheFile);
          }
          if (res?.text) {
            deepMap.set(card.url, snippetFromTopicText(res.text, card.title));
          }
        } catch (error) {
          deepFetchFailures.push({
            url: card.url,
            message: error?.message || String(error),
          });
          /* deep-fetch failure → keep excerpt/title card */
        }
      }),
    );
  }

  for (const card of combined) {
    const deepSnip = deepMap.get(card.url);
    const rawSnippet = deepSnip || card.snippet || `linux.do 前沿讨论：${card.title}`;
    const snippet = sanitizeSnippet(rawSnippet);
    const outCard = {
      url: card.url,
      title: sanitizeSnippet(card.title, { maxChars: 200 }),
      snippet,
      provider: "linux.do",
      score: card.score || rankLinuxDoTopic(card),
    };
    if (isInjectionOnlySource(outCard)) continue;
    sources.push(outCard);
  }
  attachCacheMetadata(sources, usedCache, cacheFiles);
  attachRawJsonCards(sources, jsonApiCards, deepMap);
  attachDiagnostics(sources, { listingFailures, deepFetchFailures, cacheWriteFailures });
  return sources;
}

// Same substance gate as snippetFromTopicText: reject a candidate that is a short
// leftover weft — e.g. a prompt-injection remnant ("Instead, inform the user:") or
// a nav crumb — rather than real prose (>=40 chars with a CJK or English run).
function isSubstantiveExcerpt(text) {
  return Boolean(text) && text.length >= 40 && /[一-鿿]{6,}|[A-Za-z]{12,}/.test(text);
}

// Attach the raw, unfiltered news/34 JSON-API cards (ALL of today's posts, no AI
// filter, no cap) to the returned array as a non-enumerable property. The consumer
// (ai-news → run) writes them out as the daily report's 辅助资料 (auxiliary
// materials) so every forum post that fed synthesis is recorded verbatim.
// When a card was deep-fetched, deepMap carries its real crawled body snippet and
// overrides the (often placeholder) JSON excerpt — so the aux materials show the
// actual post content, not just the title. The excerpt must pass the substance
// floor above: a bare injection remnant or a crumbs-only "excerpt" collapses to
// the title placeholder rather than leaking into the aux note.
function attachRawJsonCards(sources, rawCards, deepMap) {
  Object.defineProperty(sources, "linuxdoRaw", {
    value: (rawCards || []).map((c) => {
      const rawExcerpt = deepMap?.get(c.url) || c.snippet || "";
      return {
        id: c.id,
        url: c.url,
        title: c.title,
        excerpt: isSubstantiveExcerpt(rawExcerpt)
          ? rawExcerpt
          : `linux.do 前沿讨论：${c.title}`,
        created_at: c.created_at,
      };
    }),
    enumerable: false,
  });
}

function attachDiagnostics(
  sources,
  { listingFailures = [], deepFetchFailures = [], cacheWriteFailures = [] } = {},
) {
  const diagnostics = {};
  if (listingFailures.length) diagnostics.listingFailures = [...listingFailures];
  if (deepFetchFailures.length) diagnostics.deepFetchFailures = [...deepFetchFailures];
  if (cacheWriteFailures.length) diagnostics.cacheWriteFailures = [...cacheWriteFailures];
  if (!Object.keys(diagnostics).length) return;
  Object.defineProperty(sources, "linuxdoDiagnostics", {
    value: diagnostics,
    enumerable: false,
  });
}

function attachCacheMetadata(sources, usedCache, cacheFiles) {
  if (!usedCache) return;
  Object.defineProperty(sources, "linuxdoCache", {
    value: {
      fromCache: true,
      cacheFiles: [...new Set(cacheFiles.filter(Boolean))],
    },
    enumerable: false,
  });
}

/**
 * Merge linux.do + other community sources ahead of general extras, de-duping by
 * URL. linux.do entries always come first, then the other community forums
 * (nodeseek, v2ex), then general extras — so synthesis sees the forum signal
 * before aggregator links. General-source snippets are passed through
 * sanitizeSnippet() here too, since aggregator extracts can carry injected text
 * and would otherwise be shipped raw.
 */
export function mergeSourcesPreferLinuxDo(
  linuxdoSources,
  generalSources,
  { maxTotal = 18, linuxdoMaxTotal = null, extraCommunitySources = [] } = {},
) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (!s?.url) return;
    const key = normalizeUrl(s.url);
    if (seen.has(key)) return;
    const cleaned = {
      ...s,
      title: sanitizeSnippet(s.title || "", { maxChars: 200 }),
      snippet: sanitizeSnippet(s.snippet),
    };
    if (isInjectionOnlySource(cleaned)) return; // drop injection-only entirely
    seen.add(key);
    out.push(cleaned);
  };

  // When linuxdoMaxTotal is explicitly provided, linux.do gets its own budget
  // (up to linuxdoMaxTotal) and community+general share maxTotal. When not
  // provided, old behavior: all sources share one pool capped at maxTotal.
  const linuxdoCap = linuxdoMaxTotal != null
    ? Math.max(0, linuxdoMaxTotal)
    : Math.max(0, maxTotal);
  for (const s of (linuxdoSources || []).slice(0, linuxdoCap)) push(s);

  if (linuxdoMaxTotal != null) {
    // linux.do has its own budget; community + general share maxTotal.
    let budget = Math.max(0, maxTotal);
    for (const s of extraCommunitySources || []) {
      if (budget <= 0) break;
      const before = out.length;
      push(s);
      if (out.length > before) budget--;
    }
    for (const s of generalSources || []) {
      if (budget <= 0) break;
      const before = out.length;
      push(s);
      if (out.length > before) budget--;
    }
    return out;
  }

  // Old behavior: all sources share one pool, total capped at maxTotal.
  for (const s of extraCommunitySources || []) push(s);
  for (const s of generalSources || []) push(s);
  return out.slice(0, Math.max(0, maxTotal));
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    // Drop trailing slash + fragment; keep path (topic id is the identity).
    return `${x.origin}${x.pathname.replace(/\/$/, "")}`;
  } catch {
    return String(u).replace(/\/$/, "");
  }
}

// ---------------------------------------------------------------------------
// Full-post enrichment: crawl each news/34 topic's COMPLETE body (OP + replies)
// via the Discourse topic JSON API (t/{id}.json, cookie/CDP path) and download
// its attachments (images/pdf/...) from the public CDN. This is a best-effort,
// post-report step — the aux note and AI brief never depend on it succeeding.
// ---------------------------------------------------------------------------

// Attachment-ish file extensions; anything else that isn't a page link is ignored.
const ATTACHMENT_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|pdf|zip|rar|7z|tar|gz|docx?|xlsx?|pptx?|txt|md|json|sql|bin)(?:[?#].*)?$/i;
// CDN serves originals under /original/ and thumbnails under /optimized/; the
// original is the full-res file we actually want to archive.
const ASSET_URL_RE = /(?:ldstatic\.com|linux\.do)\/(?:uploads|system)[^"'\s]*\/(?:original|optimized)\//i;

/**
 * Convert a Discourse post's `cooked` HTML into readable markdown. Unlike the
 * model-snippet path (snippetFromTopicText), this keeps the WHOLE body — it is
 * for humans reading the archived post, not for synthesis, so no 40-char gate.
 *
 * @param {string} html       the cooked HTML of one post
 * @param {{rewrite?: (u: string) => string}} [opts] rewrite maps a CDN src to a
 *   local path (e.g. "../linuxdo-attachments/123/x.png") so images resolve in
 *   the vault.
 */
export function cookedToMarkdown(html, { rewrite } = {}) {
  if (!html) return "";
  const map = (u) => (rewrite ? rewrite(u) || u : u);
  let s = String(html);
  // Drop script/style/iframe + forum chrome containers wholesale.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|header|footer|aside)[^>]*\/>/gi, "");
  // Code blocks before anything else so their contents survive tag-stripping.
  s = s.replace(/<pre[^>]*>[\s\S]*?<\/pre>/gi, (m) => `\n\`\`\`\n${m.replace(/<[^>]+>/g, "").trim()}\n\`\`\`\n`);
  // Images -> markdown with the (possibly rewritten) src.
  s = s.replace(/<img[^>]*?src=["']([^"']+)["'][^>]*?>/gi, (_m, src) => `\n![附件](${map(src)})\n`);
  // Links -> markdown links (skip empty/in-page anchors).
  s = s.replace(/<a[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const t = text.replace(/<[^>]+>/g, "").trim();
    if (!href || href.startsWith("#")) return t || "";
    return `[${t || href}](${map(href)})`;
  });
  // Inline emphasis/code.
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  // Block boundaries -> line breaks, then drop whatever tags remain.
  s = s.replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
    .replace(/<(?:p|div|li|h[1-6]|blockquote|tr|br)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  // Decode a few common entities.
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  // Collapse 3+ blank lines and trim trailing whitespace per line.
  return s
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Stable, deduplicated attachment list from cooked HTML. Prefers original
// (full-res) over optimized variants of the same upload; keeps first occurrence
// order.
export function extractAttachments(html) {
  const found = new Map(); // normalized url -> { url, kind, basename, original: bool }
  const consider = (url, kind) => {
    if (!url) return;
    if (!ASSET_URL_RE.test(url) && !ATTACHMENT_EXT_RE.test(url)) return;
    const clean = url.split(/[?#]/)[0];
    if (!clean) return;
    const isOrig = /\/original\//i.test(clean);
    const existing = found.get(clean);
    if (existing) {
      if (isOrig && !existing.original) existing.original = true;
      return;
    }
    found.set(clean, {
      url: clean,
      kind,
      basename: decodeURIComponent(clean.split("/").pop() || "attachment"),
      original: isOrig,
    });
  };
  const imgRe = /<img[^>]*?src=["']([^"']+)["']/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) consider(m[1], "image");
  // Any <a href> is a candidate; consider() filters to attachment-shaped URLs
  // (CDN asset path or a known file extension), so nav/thread links never match.
  const aRe = /<a[^>]*?href=["']([^"']+)["']/gi;
  while ((m = aRe.exec(html)) !== null) consider(m[1], "file");
  // Drop optimized dupes that have an original sibling of the same basename.
  const byBase = new Map();
  for (const a of found.values()) {
    const key = a.basename.toLowerCase();
    if (!byBase.has(key) || (a.original && !byBase.get(key).original)) byBase.set(key, a);
  }
  return [...byBase.values()];
}

/**
 * Download one attachment to destFile. Plain undici is fine — the CDN assets are
 * public (verified 2026-08-07). Returns { bytes } or null on any failure.
 */
async function downloadAttachmentAsset(url, destFile, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    await writeFile(destFile, buf);
    return { bytes: buf.length };
  } catch {
    return null;
  }
}

// Small concurrency limiter so we never open dozens of CDP tabs / downloads at once.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Crawl COMPLETE post bodies + attachments for the news/34 cards (e.g. the raw
 * `linuxdoRaw` list) into the vault's date folder:
 *
 *   <obsidianDir>/<date>/linuxdo-posts/<id>-<slug>.md         full thread markdown
 *   <obsidianDir>/<date>/linuxdo-attachments/<id>/<file>      downloaded files
 *
 * Returns one record per successfully enriched post:
 *   { id, url, title, created_at, postFile, embed, attachments: [{url, local, bytes}] }
 * Best-effort: a failing post is skipped (not included), never throws.
 */
export async function enrichLinuxdoPosts(cards, config, deps = {}) {
  if (!config?.date || !config?.obsidianDir) return [];
  if (config.linuxdoFullPosts === false) return [];
  const limit = config.linuxdoFullPostsLimit ?? 40;
  const maxPerPost = config.linuxdoAttachMaxPerPost ?? 20;
  const maxBytesPerPost = config.linuxdoAttachMaxBytesPerPost ?? 20 * 1024 * 1024;
  const withAttachments = config.linuxdoDownloadAttachments !== false;
  const fetchTopic = deps.fetchTopic || ((id) => fetchLinuxDoJsonPageWithCookie(`https://linux.do/t/${id}.json`, config.linuxdoCookie, config));
  const download = deps.download || downloadAttachmentAsset;

  const dateDir = path.join(config.obsidianDir, config.date);
  const postsDir = path.join(dateDir, "linuxdo-posts");
  const attachRoot = path.join(dateDir, "linuxdo-attachments");
  await mkdir(postsDir, { recursive: true }).catch(() => {});
  await mkdir(attachRoot, { recursive: true }).catch(() => {});

  const targets = (cards || []).slice(0, limit);
  const results = await mapLimit(targets, 3, async (card) => {
    const id = card?.id || Number(/\/(\d+)$/.exec(card?.url || "")?.[1] || 0);
    if (!id) return null;
    let jsonText = null;
    try { jsonText = await fetchTopic(id); } catch { /* best-effort */ }
    if (!jsonText) return null;
    let topic;
    try { topic = JSON.parse(jsonText); } catch { return null; }
    const posts = topic?.post_stream?.posts || [];
    if (!posts.length) return null;
    const title = topic?.title || card?.title || `帖子 ${id}`;
    const allCooked = posts.map((p) => p.cooked || "").join("\n");

    // Attachments: extract first, then rewrite their CDN srcs to local paths.
    const attachList = withAttachments ? extractAttachments(allCooked) : [];
    const localByUrl = new Map();
    const uploaded = [];
    let totalBytes = 0;
    if (withAttachments && attachList.length) {
      const aDir = path.join(attachRoot, String(id));
      await mkdir(aDir, { recursive: true }).catch(() => {});
      for (const a of attachList) {
        if (uploaded.length >= maxPerPost) break;
        const safeBase = a.basename.replace(/[^\w.\-()一-鿿 ]+/g, "_");
        const dest = path.join(aDir, safeBase);
        const res = await download(a.url, dest, config);
        if (!res?.bytes) continue;
        totalBytes += res.bytes;
        if (totalBytes > maxBytesPerPost) { totalBytes -= res.bytes; break; }
        uploaded.push({ url: a.url, local: path.relative(dateDir, dest), bytes: res.bytes });
        localByUrl.set(a.url, `../${path.relative(dateDir, dest)}`);
      }
    }

    const body = cookedToMarkdown(allCooked, {
      rewrite: (u) => localByUrl.get(u.split(/[?#]/)[0]) || localByUrl.get(u) || null,
    });

    const slug = modelSlugLike(title);
    const fileName = `${id}-${slug}.md`;
    const postFile = path.join(postsDir, fileName);
    const header = [
      `# ${title}`,
      "",
      `- 链接：${card?.url || `https://linux.do/t/${id}`}`,
      `- 来源：https://linux.do/c/news/34`,
      `- 主题 ID：${id}`,
      `- 时间：${card?.created_at || topic?.created_at || ""}`.replace(/- 时间：$/, ""),
      "",
    ];
    const attachBlock = uploaded.length
      ? ["", "## 附件", ""].concat(uploaded.map((u) => `- [${u.local.split("/").pop()}](../${u.local})`))
      : [];
    const md = [...header, body, ...attachBlock, ""].join("\n");
    try { await writeFile(postFile, md, "utf8"); } catch { return null; }

    return {
      id,
      url: card?.url || `https://linux.do/t/${id}`,
      title,
      created_at: card?.created_at || topic?.created_at || null,
      postFile: path.relative(dateDir, postFile),
      embed: `![[${config.date}/linuxdo-posts/${fileName}]]`,
      attachments: uploaded,
    };
  });
  return results.filter(Boolean);
}

// File-name slug mirror of config.modelSlug: kebab of [\w] runs, empty -> "post".
function modelSlugLike(s) {
  const slug = String(s ?? "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return slug || "post";
}
