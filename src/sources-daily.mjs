// Daily source fetchers: hacker news, 36kr, arXiv — zero-config public APIs/RSS.
// These are "same-day hard sources" that provide a stable baseline of ≥10 sources
// even when linux.do / community forums have a quiet day.
//
// Each fetcher is a standalone async function following the same contract:
//   returns { url, title, snippet, provider, score, publishedAt }[]
// On failure: 0 sources (catch → fallbackCommunity), never blocks the main flow.
// publishedAt is a Unix epoch MS for filterByRecency.

import { runFetch } from "./grok-cli.mjs";

// --- Hacker News (firebase API, zero-config) ---

const HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_BEST = "https://hacker-news.firebaseio.com/v0/beststories.json";
const HN_ITEM = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

// HN batch size: how many top + best IDs to fetch details for. Larger = more
// AI-relevant hits, especially on quiet days. 100 = top 50 + best 50 deduped.
const HN_BATCH = 100;

/**
 * Fetch today's top Hacker News stories, filter by AI relevance via keyword,
 * return same-day source cards. Uses firebase REST API — zero config, no auth.
 * Merges topstories + beststories (dedup by id) for broader coverage.
 */
export async function fetchHackerNewsDaily(config, { limit = 5 } = {}) {
  try {
    const [topResp, bestResp] = await Promise.all([
      fetch(HN_TOP),
      fetch(HN_BEST),
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

    // Fetch item details in parallel, cap at HN_BATCH (top 50 + best 50 deduped).
    const batch = unique.slice(0, HN_BATCH);
    const items = await Promise.allSettled(
      batch.map((id) => fetch(HN_ITEM(id)).then((r) => (r.ok ? r.json() : null)))
    );

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
    return sources;
  } catch {
    return [];
  }
}

function isAiRelevant(title, url) {
  const text = `${title} ${url || ""}`.toLowerCase();
  // Broad AI/tech keyword set
  return /ai|artificial intelligence|llm|gpt|chatgpt|claude|anthropic|openai|deepseek|gemini|mistral|llama|cohere|perplexity|hugging|langchain|rag|agent|codex|cursor|copilot|model|大模型|machine learning|ml|neural|transformer|diffusion|token|reasoning|fine.?tun|rlhf|dpo|grpo|loRA|quantization|inference|vllm|ollama|opencode|ide.*ai|ai.*coding|agent.*harness|tool.*use|mcp|function.*call/i.test(text);
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
  } catch {
    return [];
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
  return out;
}

/** Decode the common HTML entities found in RSS titles/links. */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/**
 * Fetch an official vendor blog RSS (OpenAI / HF) filtered to same-day (Beijing)
 * and AI-relevant, returned as standard source cards.
 */
export async function fetchOfficialBlogRss(url, config, { limit = 5, runFetch: doFetch } = {}) {
  try {
    const fetch = doFetch || runFetch;
    const res = await fetch(url, config, {
      maxChars: 60000,
      provider: "direct",
      cacheFile: config.cacheDir
        ? `${config.cacheDir}/${config.date}-${url.includes("openai") ? "openai" : "hf"}-feed.txt`
        : undefined,
    });
    const text = res?.text || "";
    const items = parseRssItems(text);
    if (!items.length) return [];

    const todayStart = beijingMidnightMs(config.date);
    const sources = [];
    for (const item of items) {
      if (item.pubDateMs != null && item.pubDateMs < todayStart) continue;
      if (!isAiRelevant(item.title, item.url)) continue;
      sources.push({
        url: item.url,
        title: item.title,
        snippet: item.title, // blog RSS has no excerpt; title carries the signal
        provider: url.includes("openai") ? "openai-blog" : url.includes("huggingface") ? "hf-blog" : url.includes("google") ? "google-blog" : "vendor-blog",
        score: 0,
        publishedAt: item.pubDateMs ?? Date.now(),
        // Official blogs don't publish daily; grace 1 day so yesterday's
        // posts are still treated as "today" for the material window.
        recencyGraceDays: 1,
      });
      if (sources.length >= limit) break;
    }
    return sources;
  } catch {
    return [];
  }
}

export async function fetchOpenaiDaily(config, opts = {}) {
  return fetchOfficialBlogRss(OPENAI_FEED, config, { limit: opts.limit ?? 5, runFetch: opts.runFetch });
}

export async function fetchHfDaily(config, opts = {}) {
  return fetchOfficialBlogRss(HF_FEED, config, { limit: opts.limit ?? 5, runFetch: opts.runFetch });
}

export async function fetchGoogleAiDaily(config, opts = {}) {
  return fetchOfficialBlogRss(GOOGLE_AI_FEED, config, { limit: opts.limit ?? 4, runFetch: opts.runFetch });
}

export async function fetchGoogleResearchDaily(config, opts = {}) {
  return fetchOfficialBlogRss(GOOGLE_RESEARCH_FEED, config, { limit: opts.limit ?? 4, runFetch: opts.runFetch });
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
      if (publishedAt < todayStart) continue;

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
        recencyGraceDays: 2,
      });
      if (sources.length >= limit) break;
    }
    return sources;
  } catch {
    return [];
  }
}

// --- helpers ---

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
  const [hn, kr36, arxiv, openai, hf, googleAi, googleResearch] = await Promise.all([
    config.hnDailyEnabled !== false
      ? fetchHackerNewsDaily(config).catch(() => [])
      : Promise.resolve([]),
    config.kr36DailyEnabled !== false
      ? fetch36krDaily(config).catch(() => [])
      : Promise.resolve([]),
    config.arxivDailyEnabled !== false
      ? fetchArxivDaily(config).catch(() => [])
      : Promise.resolve([]),
    config.openaiDailyEnabled !== false
      ? fetchOpenaiDaily(config).catch(() => [])
      : Promise.resolve([]),
    config.hfDailyEnabled !== false
      ? fetchHfDaily(config).catch(() => [])
      : Promise.resolve([]),
    config.googleAiDailyEnabled !== false
      ? fetchGoogleAiDaily(config).catch(() => [])
      : Promise.resolve([]),
    config.googleResearchDailyEnabled !== false
      ? fetchGoogleResearchDaily(config).catch(() => [])
      : Promise.resolve([]),
  ]);
  return [...hn, ...kr36, ...arxiv, ...openai, ...hf, ...googleAi, ...googleResearch];
}