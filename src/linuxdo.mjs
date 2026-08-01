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

// Listing pages that concentrate AI / frontier news. Discourse category ids observed
// live on 2026-07-31: 前沿快讯 = /c/news/34, 人工智能 tag = /tag/444-tag/444.
export const DEFAULT_LIST_URLS = [
  "https://linux.do/c/news/34",
  "https://linux.do/tag/444-tag/444",
];

// Title must match at least one of these to count as AI-related (case-insensitive).
// Kept broad enough for Chinese + English model names and tooling chatter on L 站.
const AI_TITLE_RE =
  /ai|人工智能|大模型|大 模型|gpt|claude|openai|anthropic|deepseek|gemini|llm|qwen|kimi|glm|智谱|混元|豆包|通义|月之暗面|机器人|agent|seedance|opencode|midjourney|sora|cursor|codex|ollama|vllm|huggingface|nvidia|推理|蒸馏|榜单|模型|token|mimo|longcat|pangu|openpangu|nanobanana|veo|grok|xai|perplexity|cohere|mistral|llama|falcon|yiapi|中转站|api/i;

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
  const deepLimit = Math.min(topicLimit, config.linuxdoDeepFetchLimit ?? 5);
  const maxChars = config.fetchMaxChars || 50000;

  // 1) Listing pages — best-effort, any one success is enough.
  const listTexts = [];
  const listingFailures = [];
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
        if (res?.fromCache) {
          usedCache = true;
          if (res.cacheFile || cacheFile) cacheFiles.push(res.cacheFile || cacheFile);
        }
      } catch (error) {
        listingFailures.push({ url, message: error?.message || String(error) });
      }
    }),
  );

  if (!listTexts.length) {
    const empty = [];
    if (listingFailures.length) {
      Object.defineProperty(empty, "linuxdoError", {
        value: { kind: "listing", failures: listingFailures },
        enumerable: false,
      });
    }
    attachCacheMetadata(empty, usedCache, cacheFiles);
    return empty;
  }

  // 2) Parse + dedupe + filter + rank.
  const allTopics = [];
  const seen = new Set();
  for (const text of listTexts) {
    for (const t of parseLinuxDoTopics(text)) {
      if (seen.has(t.url)) continue;
      seen.add(t.url);
      allTopics.push(t);
    }
  }
  const selected = selectAiTopics(allTopics, { limit: topicLimit });
  if (!selected.length) {
    const empty = [];
    attachCacheMetadata(empty, usedCache, cacheFiles);
    return empty;
  }

  // 3) Deep-fetch top topics for snippets (optional; title-only still useful).
  const sources = [];
  const deepTargets = deepFetch ? selected.slice(0, deepLimit) : [];
  const deepMap = new Map();

  if (deepTargets.length) {
    await Promise.all(
      deepTargets.map(async (t) => {
        try {
          const cacheFile = path.join(
            config.cacheDir,
            `${config.date}-linuxdo-topic-${t.id}.txt`,
          );
          const res = await doFetch(t.url, config, {
            maxChars: Math.min(maxChars, 12000),
            provider: "auto",
            cacheFile,
          });
          if (res?.fromCache) {
            usedCache = true;
            if (res.cacheFile || cacheFile) cacheFiles.push(res.cacheFile || cacheFile);
          }
          if (res?.text) {
            deepMap.set(t.url, snippetFromTopicText(res.text, t.title));
          }
        } catch {
          /* topic deep-fetch failure → keep title-only card */
        }
      }),
    );
  }

  for (const t of selected) {
    const rawSnippet = deepMap.get(t.url) || `linux.do 前沿讨论：${t.title}`;
    const snippet = sanitizeSnippet(rawSnippet);
    const card = {
      url: t.url,
      title: sanitizeSnippet(t.title, { maxChars: 200 }),
      snippet,
      provider: "linux.do",
      score: rankLinuxDoTopic(t),
    };
    // If the *only* thing we have is injection text + a real title, keep the card
    // (title alone is signal); only drop when title is also injected/empty.
    if (isInjectionOnlySource(card)) continue;
    sources.push(card);
  }
  attachCacheMetadata(sources, usedCache, cacheFiles);
  return sources;
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
 * Merge linux.do sources ahead of general extras, de-duping by URL.
 * linux.do entries always come first so synthesis sees them as [1]..[N].
 * General-source snippets are passed through sanitizeSnippet() here too, since
 * aggregator extracts can carry injected text and would otherwise be shipped raw.
 */
export function mergeSourcesPreferLinuxDo(linuxdoSources, generalSources, { maxTotal = 16 } = {}) {
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
  for (const s of linuxdoSources || []) push(s);
  for (const s of generalSources || []) push(s);
  return out.slice(0, Math.max(1, maxTotal));
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
