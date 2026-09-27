// Daily source fetchers: hacker news, 36kr, arXiv — zero-config public APIs/RSS.
// These are "same-day hard sources" that provide a stable baseline of ≥10 sources
// even when linux.do / community forums have a quiet day.
//
// Each fetcher is a standalone async function following the same contract:
//   returns { url, title, snippet, provider, score, publishedAt }[]
// On failure: 0 sources (catch → fallbackCommunity), never blocks the main flow.
// publishedAt is a Unix epoch MS for filterByRecency.

import { runFetch } from "./grok-cli.mjs";
import { AI_TITLE_RE } from "./community.mjs";

// Attach per-source failure diagnostics to a source array WITHOUT making them
// enumerable, so the array still behaves like a plain list everywhere it is
// spread/concatenated (spread and JSON.stringify skip non-enumerable props).
// 2026-09-26 review P2: every fetcher below used to swallow its own errors and
// return a bare [], so the `dailySourcesError` branch in ai-news.mjs could never
// fire — a full outage of the same-day hard sources printed a clean success.
// The diagnostics ride along here so the aggregate can report which source died.
function attachDailyDiagnostics(sources, provider, failures) {
  if (!Array.isArray(sources)) return sources;
  if (!failures || failures.length === 0) return sources;
  Object.defineProperty(sources, "dailyDiagnostics", {
    value: { provider, failures: failures.slice(0, 5), failureCount: failures.length },
    enumerable: false,
    configurable: true,
  });
  return sources;
}

/** Merge the per-source diagnostics of several collector arrays into one object. */
function collectDailyDiagnostics(arrays) {
  const out = {};
  for (const arr of arrays) {
    const d = arr && arr.dailyDiagnostics;
    if (!d) continue;
    if (d.failureCount > 0) out[d.provider] = { count: d.failureCount, sample: d.failures };
  }
  return out;
}

// --- Hacker News (firebase API, zero-config) ---

const HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_BEST = "https://hacker-news.firebaseio.com/v0/beststories.json";
const HN_ITEM = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

// HN batch size: how many top + best IDs to fetch details for. Larger = more
// AI-relevant hits, especially on quiet days. 100 = top 50 + best 50 deduped.
const HN_BATCH = 100;
// Every HN fetch needs a deadline. Promise.allSettled waits for ALL of them, so
// one hung firebase connection used to stall the whole daily run with no bound.
// 2026-09-26 review P3.
const HN_FETCH_TIMEOUT_MS = 10_000;
// Concurrency for the item-detail fan-out. 100 parallel requests to one host is
// both a rate-limit magnet and a thundering herd; a failing item is simply
// skipped, so a smaller window loses nothing that was going to succeed.
const HN_ITEM_CONCURRENCY = 8;

/** Map `items` through `fn` with at most `concurrency` in flight at a time. */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = { status: "fulfilled", value: await fn(items[idx], idx) };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fetch today's top Hacker News stories, filter by AI relevance via keyword,
 * return same-day source cards. Uses firebase REST API — zero config, no auth.
 * Merges topstories + beststories (dedup by id) for broader coverage.
 */
export async function fetchHackerNewsDaily(config, { limit = 5, fetchImpl = fetch } = {}) {
  const failures = [];
  try {
    const [topResp, bestResp] = await Promise.all([
      fetchImpl(HN_TOP, { signal: AbortSignal.timeout(HN_FETCH_TIMEOUT_MS) }),
      fetchImpl(HN_BEST, { signal: AbortSignal.timeout(HN_FETCH_TIMEOUT_MS) }),
    ]);
    const ids = [];
    for (const resp of [topResp, bestResp]) {
      if (!resp.ok) continue;
      const arr = await resp.json();
      if (Array.isArray(arr)) ids.push(...arr);
    }
    if (ids.length === 0) return [];
    // Dedup by id while preserving rank (top first, then best's unique ones).
    const seen = new Set();
    const unique = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }

    // Get today's Beijing start time in epoch ms
    const todayStart = beijingMidnightMs(config.date);

    // Fetch item details with bounded concurrency, cap at HN_BATCH.
    const batch = unique.slice(0, HN_BATCH);
    const items = await mapWithConcurrency(batch, HN_ITEM_CONCURRENCY, async (id) => {
      try {
        const r = await fetchImpl(HN_ITEM(id), {
          signal: AbortSignal.timeout(HN_FETCH_TIMEOUT_MS),
        });
        return r.ok ? r.json() : null;
      } catch (err) {
        // A timed-out / throttled item is expected under load; record it so a
        // fully-degraded HN run is still visible instead of looking like a quiet day.
        failures.push({ id, reason: err?.code || err?.name || "error" });
        return null;
      }
    });

    const sources = [];
    for (const result of items) {
      const item = result.status === "fulfilled" ? result.value : null;
      if (!item || !item.title || !item.url) continue;
      if (item.type !== "story") continue;
      const publishedAt = (item.time || 0) * 1000; // HN time is unix seconds
      if (publishedAt < todayStart) continue; // not today

      // AI-relevance keyword filter (same as community.mjs AI_TITLE_RE style)
      if (!isAiRelevant(item.title, item.url)) continue;

      sources.push({
        url: item.url,
        title: String(item.title).slice(0, 300),
        snippet:
          String(item.title).slice(0, 500) +
          (item.score ? ` (score: ${item.score})` : ""),
        provider: "hackernews",
        score: item.score || 0,
        publishedAt,
      });
      if (sources.length >= limit) break;
    }
    return attachDailyDiagnostics(sources, "hackernews", failures);
  } catch (err) {
    return attachDailyDiagnostics([], "hackernews", [
      { reason: err?.code || err?.name || "error" },
    ]);
  }
}

// 2026-09-28 review H3: this was a SECOND, hand-maintained copy of the AI
// relevance gate, and the two had drifted in opposite directions.
//
//   sources-daily's copy: `大模型` was its ONLY CJK branch. It rejected
//     `又快又能打！匿名模型玉兔模型杀上双榜第一，Coding实测全记录` — a real
//     model-launch headline, and exactly what a Chinese daily exists to carry.
//   community's copy (AI_TITLE_RE): rich CJK (人工智能/模型/推理/蒸馏/榜单),
//     corpus-tested against real forum titles, but it has NO bare `models?`
//     and no `machine learning`/`neural`/`inference`/`mcp`, because a
//     linux.do title never says "Introducing a new model" without a vendor.
//
// Neither is a superset of the other, so replacing one with the other would
// break the other corpus. This is a UNION: the module gates a MIXED corpus
// (official blogs + aggregators + HN) and each gate is right for its own half.
// The union admits everything either gate admitted before, so no story that
// used to pass can start failing, and the CJK coverage the new Chinese feeds
// need is added.
const DAILY_AI_RELEVANT_SRC = [
  String.raw`\bai\b`,
  String.raw`artificial intelligence|\bllms?\b|\bgpt\b|chatgpt|claude|anthropic|openai`,
  String.raw`deepseek|gemini|mistral|llama|cohere|perplexity|hugging ?face|langchain`,
  String.raw`\brag\b|\bagents?\b|codex|cursor|copilot|\bmodels?\b|machine learning`,
  String.raw`\bml\b|neural|transformer|diffusion|\btokens?\b|reasoning|fine.?tun`,
  String.raw`rlhf|dpo|grpo|\blora\b|quantization|inference|vllm|ollama|opencode`,
  String.raw`ai.*coding|agent.*harness|tool.*use|\bmcp\b|function.*call`,
].join("|");
const AI_RELEVANT_RE = new RegExp(`${AI_TITLE_RE.source}|${DAILY_AI_RELEVANT_SRC}`, "i");

function isAiRelevant(title, url) {
  const text = `${title} ${url || ""}`.toLowerCase();
  // 2026-09-26 review P1: the alternation's first branch used to be a bare,
  // unanchored `ai`, which matches inside ordinary English — "email",
  // "maintain", "available", "domain", "chain", "detail", "Rainbow" — so the
  // filter was effectively always true and HN contributed its first N stories
  // regardless of topic. Latin branches are now word-anchored; CJK branches have
  // no word boundaries to anchor to and stay unanchored. That anchoring now
  // lives in community.mjs's AI_TITLE_RE, which this module reuses.
  return AI_RELEVANT_RE.test(text);
}

// --- 36kr RSS (zero-config, Chinese tech news) ---

const KR_36_FEED = "https://36kr.com/feed";

// --- Official vendor blogs (RSS, zero-config) ---
// OpenAI News + Hugging Face Blog are first-party, same-day sources with proper
// URLs and pubDates (unlike 36kr through Firecrawl). High signal, no WAF issues.

const OPENAI_FEED = "https://openai.com/news/rss.xml";
const HF_FEED = "https://huggingface.co/blog/feed.xml";
const GOOGLE_AI_FEED = "https://blog.google/technology/ai/rss";
const GOOGLE_RESEARCH_FEED = "https://research.google/blog/rss";

/**
 * Fetch today's 36kr feed, filter by AI relevance, return same-day sources.
 * 36kr's bare URL is WAF-protected (火山引擎 challenge) for direct fetches, so we
 * go through the provider stack (Tavily/Firecrawl) which returns a markdown-style
 * listing of `### [Title](url)` lines, parsed below. Falls back to RSS XML parsing
 * if a provider returns raw XML instead.
 */
export async function fetch36krDaily(config, { limit = 5, runFetch: doFetch } = {}) {
  try {
    const fetch = doFetch || runFetch;
    // Note: Firecrawl/Tavily render pages as markdown with `### [Title](url)` rows.
    const res = await fetch(KR_36_FEED, config, {
      maxChars: 20000,
      provider: "auto",
      cacheFile: config.cacheDir
        ? `${config.cacheDir}/${config.date}-36kr-feed.txt`
        : undefined,
    });
    const text = res?.text || "";
    if (!text) return [];

    const todayStart = beijingMidnightMs(config.date);

    // 1) Firecrawl/Tavily markdown style: `### [Title](url)` lines
    const items = [];
    const mdRe = /###\s*\[([^\]]+)\]\(([^)]+)\)/g;
    let m;
    while ((m = mdRe.exec(text)) !== null) {
      items.push({ title: m[1].trim(), url: m[2].trim() });
    }

    // 2) RFC-822 RSS XML fallback (only when markdown parse found nothing).
    if (items.length === 0) {
      const rssItemRegex = /<item>([\s\S]*?)<\/item>/gi;
      while ((m = rssItemRegex.exec(text)) !== null) {
        items.push({
          title: extractTag(m[1], "title"),
          url: extractTag(m[1], "link"),
          pubDate: extractTag(m[1], "pubDate") || "",
        });
      }
    }

    const sources = [];
    for (const item of items) {
      const title = (item.title || "").trim();
      const url = (item.url || "").trim();
      if (!title || !url) continue;
      if (!isAiRelevant(title, url)) continue;

      // Markdown rows carry no pubDate — treat as same-day (fetched live now).
      const publishedAt =
        item.pubDate && new Date(item.pubDate).getTime()
          ? new Date(item.pubDate).getTime()
          : Date.now();
      if (item.pubDate && publishedAt < todayStart) continue;

      sources.push({
        url,
        title: title.slice(0, 300),
        snippet: title.slice(0, 500),
        provider: "36kr",
        score: 0,
        publishedAt,
      });
      if (sources.length >= limit) break;
    }
    return sources;
  } catch (err) {
    return attachDailyDiagnostics([], "36kr", [{ reason: err?.code || err?.name || "error" }]);
  }
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(xml);
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse RSS 2.0 items (with optional CDATA) into {title, url, pubDateMs}.
 * Handles both <link> plain and <link> with atom:link. Never throws.
 * HTML entities (&amp; &lt; &gt; &quot; &#39;) are decoded in titles.
 */
export function parseRssItems(xml, { maxChars = 20000 } = {}) {
  if (!xml) return [];
  const cap = xml.slice(0, maxChars);
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(cap)) !== null) {
    const block = m[1];
    const title = decodeEntities(extractTag(block, "title"));
    const link = decodeEntities(extractTag(block, "link"));
    const pubRaw = extractTag(block, "pubDate") || extractTag(block, "date");
    if (!title || !link) continue;
    const pubDateMs = pubRaw ? Date.parse(pubRaw) : NaN;
    out.push({
      title: title.slice(0, 300),
      url: link,
      pubDateMs: Number.isFinite(pubDateMs) ? pubDateMs : null,
    });
  }
  // 2026-09-28 review H2: Atom. The Verge's AI feed is Atom, and this parser
  // matched only <item>, so that feed parsed to ZERO items and looked exactly
  // like an empty channel. <entry> differs in three ways that matter: the link
  // is an href ATTRIBUTE rather than element text, the date is <published>/
  // <updated> in ISO-8601 rather than RFC-822 <pubDate>, and the id is often
  // the canonical URL. Dropping <entry> support is how a live daily feed reads
  // as a dead one.
  const entryRe = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  while ((m = entryRe.exec(cap)) !== null) {
    const block = m[1];
    const title = decodeEntities(stripCdata(extractTag(block, "title")));
    // rel="alternate" is the canonical entry link; fall back to the first href,
    // then to <id>, which Atom requires and which is usually the permalink.
    const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map((x) => x[1]);
    const attrsOf = (a) => ({
      href: (a.match(/href="([^"]+)"/i) || [])[1] || "",
      rel: (a.match(/rel="([^"]+)"/i) || [])[1] || "",
    });
    const parsedLinks = links.map(attrsOf).filter((l) => l.href);
    const link =
      decodeEntities(
        (parsedLinks.find((l) => /alternate/i.test(l.rel))?.href || parsedLinks[0]?.href || "").trim(),
      ) || decodeEntities(extractTag(block, "id")).trim();
    const pubRaw =
      extractTag(block, "published") || extractTag(block, "updated") || extractTag(block, "date");
    if (!title || !link) continue;
    const pubDateMs = pubRaw ? Date.parse(pubRaw) : NaN;
    out.push({
      title: title.slice(0, 300),
      url: link,
      pubDateMs: Number.isFinite(pubDateMs) ? pubDateMs : null,
    });
  }
  return out;
}

// Atom <link> selection lives inline above; this stub is gone.
function stripCdata(s) {
  return String(s || "").replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
}

/** Decode the common HTML entities found in RSS titles/links. */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

// 2026-09-28 H4: TechCrunch ships `Anthropic&#8217;s` inside <title> and the
// entity reached the note verbatim. fromCodePoint THROWS on an out-of-range
// value, so decoding numerically has to be defensive — a malformed entity from
// any feed would otherwise take down every title in the report, which is the
// opposite of a graceful degrade.
function safeFromCodePoint(code) {
  try {
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

/**
 * Fetch an official vendor blog RSS (OpenAI / HF / Google) filtered to same-day
 * (Beijing) and AI-relevant, returned as standard source cards.
 *
 * `site` identifies the source and MUST be passed explicitly: the cache filename
 * used to be derived from the URL with `url.includes("openai") ? "openai" : "hf"`,
 * so HuggingFace, blog.google and research.google all collided on ONE
 * `<date>-hf-feed.txt`. The three run concurrently in fetchAllDailySources, so
 * whichever finished last overwrote the others and the other two were re-read
 * from a cache that no longer contained them — verified on disk: 12 consecutive
 * days (2026-08-26 … 2026-09-11) of `-hf-feed.txt` held Google bodies, not HF.
 * Inferred identity is exactly the kind of surface that silently rots.
 */
export async function fetchOfficialBlogRss(
  url,
  config,
  { limit = 5, runFetch: doFetch, site, provider } = {},
) {
  if (!site) throw new Error("fetchOfficialBlogRss 必须显式传入 site（用于缓存与来源标识）");
  try {
    const fetch = doFetch || runFetch;
    const res = await fetch(url, config, {
      maxChars: 60000,
      provider: "direct",
      cacheFile: config.cacheDir ? `${config.cacheDir}/${config.date}-${site}-feed.txt` : undefined,
    });
    const text = res?.text || "";
    if (!text) return attachDailyDiagnostics([], site, [{ reason: "empty-response" }]);
    const items = parseRssItems(text);
    if (!items.length) {
      return attachDailyDiagnostics([], site, [{ reason: "no-rss-items" }]);
    }

    const todayStart = beijingMidnightMs(config.date);
    // Official blogs don't publish daily; grace 1 day so yesterday's posts are
    // still treated as "today" for the material window.
    //
    // 2026-09-27 review C1: the gate used to be a strict `pubDateMs < todayStart`
    // and the grace was attached only to the card that had already survived it —
    // so the field downstream honours was dead code and the comment above was
    // false. A Beijing-yesterday post measured as dropped. The cutoff now
    // expresses the window this source is actually given.
    const BLOG_GRACE_DAYS = 1;
    const windowStart = todayStart - BLOG_GRACE_DAYS * 24 * 60 * 60 * 1000;
    const sources = [];
    for (const item of items) {
      if (item.pubDateMs != null && item.pubDateMs < windowStart) continue;
      if (!isAiRelevant(item.title, item.url)) continue;
      sources.push({
        url: item.url,
        title: item.title,
        snippet: item.title, // blog RSS has no excerpt; title carries the signal
        provider: provider || site,
        score: 0,
        publishedAt: item.pubDateMs ?? Date.now(),
        recencyGraceDays: BLOG_GRACE_DAYS,
      });
      if (sources.length >= limit) break;
    }
    // 2026-09-28 review H1: this used to return a bare `sources` with no
    // diagnostic, on the grounds that "a feed that parsed fine but yielded
    // nothing for today is a normal quiet day". That is true of ONE blog and
    // false in aggregate: measured 2026-09-28, all five configured hard sources
    // returned 0, `dailyDiagnostics` came back null, and the report still
    // printed a clean success over forum chatter. P2 caught transport failure;
    // a feed that fetches fine and is then emptied by the window is the far
    // more common case and was completely silent. Name it.
    if (sources.length === 0) {
      return attachDailyDiagnostics([], site, [
        { reason: "no-fresh-items-in-window", parsed: items.length },
      ]);
    }
    return sources;
  } catch (err) {
    return attachDailyDiagnostics([], site, [{ reason: err?.code || err?.name || "error" }]);
  }
}

export async function fetchOpenaiDaily(config, opts = {}) {
  return fetchOfficialBlogRss(OPENAI_FEED, config, {
    limit: opts.limit ?? 5,
    runFetch: opts.runFetch,
    site: "openai",
    provider: "openai-blog",
  });
}

export async function fetchHfDaily(config, opts = {}) {
  return fetchOfficialBlogRss(HF_FEED, config, {
    limit: opts.limit ?? 5,
    runFetch: opts.runFetch,
    site: "hf",
    provider: "hf-blog",
  });
}

export async function fetchGoogleAiDaily(config, opts = {}) {
  return fetchOfficialBlogRss(GOOGLE_AI_FEED, config, {
    limit: opts.limit ?? 4,
    runFetch: opts.runFetch,
    site: "google-ai",
    provider: "google-ai-blog",
  });
}

export async function fetchGoogleResearchDaily(config, opts = {}) {
  return fetchOfficialBlogRss(GOOGLE_RESEARCH_FEED, config, {
    limit: opts.limit ?? 4,
    runFetch: opts.runFetch,
    site: "google-research",
    provider: "google-research-blog",
  });
}

// --- Daily-publishing news aggregators (2026-09-28 review H2) ---
//
// The five vendor blogs above are high-signal but publish weekly-ish, so they
// cannot carry a DAILY. Measured 2026-09-28 against the live feeds, every one
// of them returned 0 items inside the recency window (newest OpenAI post 45h
// old, newest arXiv paper 4 days old) and the report fell back to forum
// chatter — 6 of 9 sources, and on 09-27 fully 100%.
//
// These four publish every day, which is what the "same-day hard source" role
// actually requires. Two are Chinese-language, which matters for a Chinese
// daily. Fresh-item counts measured on 2026-09-28 (1-day window, after the
// existing AI-relevance gate): techcrunch-ai 4, qbitai 3, infoq-cn 3,
// verge-ai 3.
//
// They reuse fetchOfficialBlogRss rather than getting bespoke parsers, so the
// same window, the same relevance gate and the same H1 starved-source
// diagnostic apply to them. Verge is Atom, which is why parseRssItems grew
// <entry> support above.
const TECHCRUNCH_AI_FEED = "https://techcrunch.com/category/artificial-intelligence/feed/";
const VERGE_AI_FEED = "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml";
const QBITAI_FEED = "https://www.qbitai.com/feed";
const INFOQ_CN_FEED = "https://www.infoq.cn/feed";

export async function fetchTechcrunchAiDaily(config, opts = {}) {
  return fetchOfficialBlogRss(TECHCRUNCH_AI_FEED, config, {
    limit: opts.limit ?? 5,
    runFetch: opts.runFetch,
    site: "techcrunch-ai",
    provider: "techcrunch-ai",
  });
}

export async function fetchVergeAiDaily(config, opts = {}) {
  return fetchOfficialBlogRss(VERGE_AI_FEED, config, {
    limit: opts.limit ?? 5,
    runFetch: opts.runFetch,
    site: "verge-ai",
    provider: "verge-ai",
  });
}

export async function fetchQbitaiDaily(config, opts = {}) {
  return fetchOfficialBlogRss(QBITAI_FEED, config, {
    limit: opts.limit ?? 5,
    runFetch: opts.runFetch,
    site: "qbitai",
    provider: "qbitai",
  });
}

export async function fetchInfoqCnDaily(config, opts = {}) {
  return fetchOfficialBlogRss(INFOQ_CN_FEED, config, {
    limit: opts.limit ?? 5,
    runFetch: opts.runFetch,
    site: "infoq-cn",
    provider: "infoq-cn",
  });
}

// --- arXiv cs.AI API (zero-config, same-day papers) ---

const ARXIV_QUERY = "https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=30";

/**
 * Fetch today's arXiv cs.AI new submissions, return source cards.
 * arXiv API returns Atom XML with <entry> blocks.
 */
export async function fetchArxivDaily(config, { limit = 5, runFetch: doFetch } = {}) {
  try {
    const fetch = doFetch || runFetch;
    const res = await fetch(ARXIV_QUERY, config, {
      maxChars: 80000,
      provider: "direct",
      cacheFile: config.cacheDir
        ? `${config.cacheDir}/${config.date}-arxiv-feed.txt`
        : undefined,
    });
    const text = res?.text || "";
    if (!text) return [];

    const todayStart = beijingMidnightMs(config.date);
    const ARXIV_GRACE_DAYS = 2;
    const arxivWindowStart = todayStart - ARXIV_GRACE_DAYS * 24 * 60 * 60 * 1000;

    // Parse Atom entries via regex
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
    const entries = [];
    let m;
    while ((m = entryRegex.exec(text)) !== null) {
      entries.push(m[1]);
    }

    const sources = [];
    for (const block of entries) {
      const title = extractTag(block, "title").replace(/\s+/g, " ").trim();
      const id = extractTag(block, "id");
      const summary = extractTag(block, "summary").replace(/\s+/g, " ").trim().slice(0, 500);
      const published = extractTag(block, "published");
      if (!title || !id) continue;

      // arXiv IDs look like http://arxiv.org/abs/1234.56789v1
      const absUrl = id.replace(/v\d+$/i, "").replace(/^http:/, "https:");

      const publishedAt = published ? new Date(published).getTime() : 0;
      // 2026-09-27 review C1: the cutoff was a strict `publishedAt < todayStart`
      // while the grace of 2 was attached only to cards that had survived it, so
      // the field was dead code. On a 09:00 Beijing run this dropped the whole
      // previous Beijing day's batch — measured empty. The window is now
      // expressed in the cutoff itself.
      if (publishedAt < arxivWindowStart) continue;

      // arXiv abstracts are often very technical; always include them
      sources.push({
        url: absUrl,
        title: title.slice(0, 300),
        snippet: summary,
        provider: "arxiv",
        score: 0,
        publishedAt: publishedAt || Date.now(),
        // arXiv labels papers with their UTC submit day; on Beijing time those usually
        // land on "yesterday" or the day before. Grace 2 days so yesterday's +
        // today's papers survive the recency gate (arxiv publishes in a burst
        // late UTC; a strict same-day window would starve the paper source).
        recencyGraceDays: ARXIV_GRACE_DAYS,
      });
      if (sources.length >= limit) break;
    }
    return sources;
  } catch (err) {
    return attachDailyDiagnostics([], "arxiv", [{ reason: err?.code || err?.name || "error" }]);
  }
}

/**
 * Take at most `cap` items across the per-source parts, round-robin, so no whole
 * source is starved by an earlier one exhausting the budget.
 *
 * Round-robin rather than even-share: even-share would need a policy for the
 * remainder and would flatten an operator's deliberate per-source *_DAILY_LIMIT
 * (they asked for 5 HN, 4 OpenAI). Round-robin takes one item from each source
 * in turn, which honours those limits as an upper bound per source and spends
 * the remaining budget in the same order the sources are already declared.
 * Sources with nothing to contribute are skipped without consuming a turn.
 */
export function interleaveAndCap(parts, cap) {
  const out = [];
  const longest = parts.reduce((n, p) => Math.max(n, p.length), 0);
  for (let i = 0; i < longest && out.length < cap; i++) {
    for (const part of parts) {
      if (out.length >= cap) break;
      if (i < part.length) out.push(part[i]);
    }
  }
  return out;
}

/**
 * Compute the epoch ms of midnight (Beijing time) for a given date string.
 * Used to filter sources by "today's content".
 */
export function beijingMidnightMs(dateStr) {
  // dateStr is "YYYY-MM-DD" in Beijing calendar
  const [y, m, d] = dateStr.split("-").map(Number);
  // Beijing midnight = UTC 16:00 of previous day (UTC+8)
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 8 * 60 * 60 * 1000;
}

/**
 * Fetch all daily sources in parallel, each with catch-fallback returning [].
 * Merged into ai-news-section's community sources slot.
 */
export async function fetchAllDailySources(config) {
  // 2026-09-26 review P2: the six `*DailyLimit` keys were read, validated and
  // documented in config.mjs but never passed to anything, so every fetcher fell
  // back to its own hardcoded default and an operator tuning HN_DAILY_LIMIT in
  // .env saw no effect and no warning. `aggregateDailySourceLimit` had no
  // consumer at all, leaving the merged pool unbounded.
  const [
    hn, kr36, arxiv, openai, hf, googleAi, googleResearch,
    techcrunch, verge, qbitai, infoqCn,
  ] = await Promise.all([
    config.hnDailyEnabled !== false
      ? fetchHackerNewsDaily(config, { limit: config.hnDailyLimit }).catch(() => [])
      : Promise.resolve([]),
    config.kr36DailyEnabled !== false
      ? fetch36krDaily(config, { limit: config.kr36DailyLimit }).catch(() => [])
      : Promise.resolve([]),
    config.arxivDailyEnabled !== false
      ? fetchArxivDaily(config, { limit: config.arxivDailyLimit }).catch(() => [])
      : Promise.resolve([]),
    config.openaiDailyEnabled !== false
      ? fetchOpenaiDaily(config, { limit: config.openaiDailyLimit }).catch(() => [])
      : Promise.resolve([]),
    config.hfDailyEnabled !== false
      ? fetchHfDaily(config, { limit: config.hfDailyLimit }).catch(() => [])
      : Promise.resolve([]),
    config.googleAiDailyEnabled !== false
      ? fetchGoogleAiDaily(config, { limit: config.googleAiDailyLimit }).catch(() => [])
      : Promise.resolve([]),
    config.googleResearchDailyEnabled !== false
      ? fetchGoogleResearchDaily(config, { limit: config.googleResearchDailyLimit }).catch(
          () => [],
        )
      : Promise.resolve([]),
    // 2026-09-28 review H2: the daily-publishing half of the baseline. Each is
    // individually switchable so an operator can mute one that goes bad without
    // losing the rest — the aggregator feeds are the only ones that carry a
    // quiet day, so muting them re-creates the exact failure this fixes.
    config.techcrunchAiEnabled !== false
      ? fetchTechcrunchAiDaily(config, { limit: config.techcrunchAiLimit }).catch(() => [])
      : Promise.resolve([]),
    config.vergeAiEnabled !== false
      ? fetchVergeAiDaily(config, { limit: config.vergeAiLimit }).catch(() => [])
      : Promise.resolve([]),
    config.qbitaiEnabled !== false
      ? fetchQbitaiDaily(config, { limit: config.qbitaiLimit }).catch(() => [])
      : Promise.resolve([]),
    config.infoqCnEnabled !== false
      ? fetchInfoqCnDaily(config, { limit: config.infoqCnLimit }).catch(() => [])
      : Promise.resolve([]),
  ]);
  const parts = [
    hn, kr36, arxiv, openai, hf, googleAi, googleResearch,
    techcrunch, verge, qbitai, infoqCn,
  ];
  const merged = parts.flat();
  const cap = Number.isFinite(config.aggregateDailySourceLimit)
    ? config.aggregateDailySourceLimit
    : null;
  // The diagnostics must be read BEFORE any slice, and attached to the array that
  // is actually returned — a caller spreading the result would otherwise drop a
  // property that was never enumerable in the first place.
  const diagnostics = collectDailyDiagnostics(parts);
  // 2026-09-27 review (round 4) P2-2. This used to be `merged.slice(0, cap)`,
  // which takes the first N in ARRAY order. With the shipped per-source defaults
  // (5+5+5+4+4+4+4 = 31) against the default cap of 15, the first three sources
  // consumed the entire budget and openai / huggingface / blog.google /
  // research.google contributed NOTHING — on every run, silently. Each of those
  // has its own enable switch and its own *_DAILY_LIMIT that an operator can
  // tune, and an operator watching one of those feeds fail would see no error.
  const capped = cap != null && cap > 0 ? interleaveAndCap(parts, cap) : merged;
  if (Object.keys(diagnostics).length > 0) {
    Object.defineProperty(capped, "dailyDiagnostics", {
      value: diagnostics,
      enumerable: false,
      configurable: true,
    });
  }
  return capped;
}