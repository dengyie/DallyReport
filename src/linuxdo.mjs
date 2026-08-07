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
