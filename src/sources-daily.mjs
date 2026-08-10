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
const HN_ITEM = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

/**
 * Fetch today's top Hacker News stories, filter by AI relevance via keyword,
 * return same-day source cards. Uses firebase REST API — zero config, no auth.
 */
export async function fetchHackerNewsDaily(config, { limit = 5 } = {}) {
  try {
    const resp = await fetch(HN_TOP);
    if (!resp.ok) return [];
    const ids = await resp.json();
    if (!Array.isArray(ids) || ids.length === 0) return [];

    // Get today's Beijing start time in epoch ms
    const todayStart = beijingMidnightMs(config.date);

    // Fetch item details in parallel, cap at first 50 (topstories can be 500)
    const batch = ids.slice(0, 50);
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
  const [hn, kr36, arxiv] = await Promise.all([
    config.hnDailyEnabled !== false
      ? fetchHackerNewsDaily(config).catch(() => [])
      : Promise.resolve([]),
    config.kr36DailyEnabled !== false
      ? fetch36krDaily(config).catch(() => [])
      : Promise.resolve([]),
    config.arxivDailyEnabled !== false
      ? fetchArxivDaily(config).catch(() => [])
      : Promise.resolve([]),
  ]);
  return [...hn, ...kr36, ...arxiv];
}