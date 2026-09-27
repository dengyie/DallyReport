// Shared collector for the community-forum AI sources (nodeseek.mjs, v2ex.mjs).
// These are the same data-diversity role as linux.do: same-day AI discussion feeds
// that the generic Tavily/Firecrawl search almost never surfaces. They are merged
// ahead of general sources for synthesis — never written into the shipped note
// (de-pollution: the report surface stays a clean normal daily brief).
//
// Why parameterized: nodeseek and v2ex share the same shape — fetch listing pages,
// parse `[title](url)` links, AI-filter + rank, deep-fetch the top-N topics for
// snippets — and only differ in URL patterns, filters and snippet extraction. One
// orchestrator keeps the failure/cache/diagnostic behavior identical to linuxdo.mjs
// instead of duplicating ~120 lines per site.
//
// Isolation: any failure returns [] so the AI section still runs on general sources.

import path from "node:path";
import { runFetch } from "./grok-cli.mjs";
import { sanitizeSnippet, isInjectionOnlySource, NEGATIVE_COMMUNITY_RE } from "./snippet-hygiene.mjs";

// Shared AI-keyword gate for the community collectors. Kept broad enough for
// Chinese + English model names and tooling chatter across L 站 / NodeSeek / V2EX.
//
// 2026-09-27 review (round 4) corrects the 2026-09-26 fix. That fix put a
// WORD BOUNDARY on BOTH ends of every Latin token (`\bgpt\b`). The leading `\b`
// is what actually blocks the false positives — it is what stops "maintain",
// "email", "said" and "trained" from matching. The TRAILING one caused a much
// larger regression: `5`/`4`/`3` are word characters, so every glued version
// number failed. 20 of 48 real AI headlines were being dropped, and they were
// the most common title shape on an AI forum:
//
//   LOST  GPT5 发布   GLM4.5 发布   Qwen3 登顶   Llama4 开源   Grok4 发布
//   LOST  Sora2 评测  Kimi2 上下文  Veo3 竞品    Mimo7B 评测   vLLM0.9 部署
//   LOST  agentic 架构  tokenizer 改进  AIGC 行业报告
//
// `\bgpt-?4o?\b` was a special case that accidentally rescued GPT-4o/GPT4o but
// NOT GPT-5/GPT4/GPT5 — i.e. exactly the newest-generation titles were the ones
// lost. So: keep the leading `\b`, replace the trailing one with an OPTIONAL
// version suffix. `test/community-ai-corpus.test.mjs` pins both directions —
// the KEEP side (this regression) and the DROP side (the original bare-`ai`
// bug) — because 352 green tests did not catch either.
// Built with a RegExp constructor, not a literal: the pattern is too long to
// survive as one line, and a JS regex literal cannot span lines. `x` (extended)
// is what makes the per-token grouping readable — the previous one-line form
// was unreviewable precisely because a reader could not see which `\b` did what.
const AI_TITLE_RE_SRC = [
  // --- bare `ai` family: leading \b only. The version forms need no trailing
  // boundary because `2` is a word char, but the standalone form must keep one
  // or "maintain"/"email"/"said"/"trained" come back.
  String.raw`\bai\b`,
  String.raw`\bai\d`,
  String.raw`aigc`,
  String.raw`artificial intelligence`,
  // --- CJK: no word boundaries to anchor to, unchanged.
  `人工智能|大模型|大 模型|智谱|混元|豆包|通义|月之暗面|机器人`,
  `推理|蒸馏|榜单|模型|生图|文生|数字人|短剧|编程助手|提示词|词元`,
  // --- vendor names, always safe as bare substrings (multi-char, collision-free)
  `chatgpt|claude|openai|anthropic|deepseek|gemini|mistral|perplexity|cohere`,
  `huggingface|nvidia|codex|ollama|opencode|midjourney|falcon|seedance`,
  `longcat|pangu|openpangu|nanobanana|yiapi|中转站`,
  // --- versioned model names: \b on the LEFT, optional version on the right.
  // This is the round-4 fix: the trailing \b used to eat `GPT5` / `GLM4.5`.
  String.raw`\bgpt(?:-?\d[\w.]*)?o?\b`,
  String.raw`\bqwen(?:-?\d[\w.]*)?\b`,
  String.raw`\bglm(?:-?\d[\w.]*)?\b`,
  String.raw`\bkimi(?:-?[\w.]+)?\b`,
  String.raw`\bllama(?:-?\d[\w.]*)?\b`,
  String.raw`\bmimo(?:-?[\w.]*)?\b`,
  String.raw`\bllms?(?:-?\d[\w.]*)?\b`,
  String.raw`\bgrok(?:-?\d[\w.]*)?\b`,
  String.raw`\bsora(?:-?\d[\w.]*)?\b`,
  String.raw`\bveo(?:-?\d[\w.]*)?\b`,
  String.raw`\bvllm(?:-?[\w.]*)?\b`,
  // --- compound-word families: suffix-anchored, no trailing \b
  String.raw`\bagent(?:s|ic|ive|ic\w*)?\b`,
  String.raw`\bcursor(?:s|-?\d[\w.]*)?\b`,
  String.raw`\btoken(?:s|izer|izers|omics|ization|isation|gate)?\b`,
  String.raw`\bapis?\b`,
  String.raw`\bxai\b`,
  String.raw`\bcoding agents?\b`,
  // --- 额度/配额/余额 with an explicit how-to verb. These are usage questions
  // about a model account ("剩余额度查询方法", "余额怎么查"), which the old bare
  // `额度重置` / `余额` negative-filter entries used to drop.
  `(?:剩余|可用|查询|查看|重置|恢复)?\\s*(?:额度|配额|余额)\\s*(?:查询|查看|怎么|如何|重置|恢复|刷新|到账|用完|上限)`,
].join("|");

export const AI_TITLE_RE = new RegExp(AI_TITLE_RE_SRC, "i");



// Promo/ads that should sink to the bottom even when keyword-adjacent.
const PROMO_TITLE_RE =
  /注册送|送\d+\s*\$|倍率|中转站|合租|拼车|羊毛|充值福利|长期服务|富可敌国/i;

function cleanTitle(raw) {
  return String(raw || "")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if a topic title looks like AI/LLM news worth putting in the daily report. */
export function isAiRelatedTopic(title, { exclude = null } = {}) {
  if (!title) return false;
  if (NEGATIVE_COMMUNITY_RE.test(title)) return false;
  if (exclude && exclude.test(title)) return false;
  return AI_TITLE_RE.test(title);
}

/** Rank score: newer topic ids first; pure promo ads sink to the bottom. */
export function rankTopic(topic) {
  const id = topic?.id || 0;
  const promo = PROMO_TITLE_RE.test(topic?.title || "") ? 1 : 0;
  return id - promo * 1_000_000;
}

/**
 * Pick the top-N AI topics from a parsed list, ranked by rankTopic.
 * `filter` is site-specific (e.g. nodeseek's VPS-trade exclusion).
 */
export function selectAiTopics(topics, { limit = 8, filter = null } = {}) {
  return (topics || [])
    .filter((t) => isAiRelatedTopic(t.title, { exclude: filter }))
    .sort((a, b) => rankTopic(b) - rankTopic(a))
    .slice(0, Math.max(0, limit));
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
  Object.defineProperty(sources, "communityDiagnostics", {
    value: diagnostics,
    enumerable: false,
  });
}

function attachCacheMetadata(sources, usedCache, cacheFiles) {
  if (!usedCache) return;
  Object.defineProperty(sources, "communityCache", {
    value: {
      fromCache: true,
      cacheFiles: [...new Set(cacheFiles.filter(Boolean))],
    },
    enumerable: false,
  });
}

/**
 * Generic community-forum source collector.
 *
 * @param {object} site
 * @param {string} site.key            config key prefix, e.g. "nodeseek"
 * @param {string} site.provider       source card provider tag, e.g. "nodeseek"
 * @param {string[]} site.listUrls     default listing page URLs
 * @param {(text:string)=>{url,title,id}[]} site.parse      parse links out of a listing extract
 * @param {(text:string,title:string)=>string} site.snippetOf  topic-page body -> snippet
 * @param {RegExp|null} [site.exclude] title exclusion filter (VPS trade, spam, …)
 * @param {number} [site.topicLimit]   default topic cap
 * @param {number} [site.deepFetchLimit] default deep-fetch cap
 * @param {object} config              loadConfig() output
 * @param {object} [deps]              { runFetch } injected for tests
 * @returns {Promise<Array<{url,title,snippet,provider,score?}>>}
 */
export async function fetchCommunitySources(site, config, deps = {}) {
  const enabled = config[`${site.key}Enabled`];
  if (enabled === false) return [];

  const doFetch = deps.runFetch || runFetch;
  const listUrls = (config[`${site.key}ListUrls`] && config[`${site.key}ListUrls`].length)
    ? config[`${site.key}ListUrls`]
    : site.listUrls;
  const topicLimit = config[`${site.key}TopicLimit`] ?? site.topicLimit ?? 6;
  const deepFetch = config[`${site.key}DeepFetch`] !== false;
  const deepLimit = Math.min(topicLimit, config[`${site.key}DeepFetchLimit`] ?? site.deepFetchLimit ?? 3);
  const maxChars = config.fetchMaxChars || 50000;

  // 1) Listing pages — best-effort, any one success is enough.
  const listTexts = [];
  const listingFailures = [];
  const deepFetchFailures = [];
  const cacheWriteFailures = [];
  const cacheFiles = [];
  let usedCache = false;
  await Promise.all(
    listUrls.map(async (url, i) => {
      try {
        const cacheFile = path.join(config.cacheDir, `${config.date}-${site.key}-list-${i}.txt`);
        const res = await doFetch(url, config, {
          maxChars,
          provider: "auto",
          cacheFile,
          // Cache gate (READ + WRITE via runFetch): a 200 challenge/error page
          // parses to zero topics, so it must neither be cached as a "valid list"
          // nor replayed from a poisoned cache as an empty day.
          cachePredicate: (text) => site.parse(text).length > 0,
        });
        if (res?.text) listTexts.push(res.text);
        if (res?.cacheWriteError) {
          cacheWriteFailures.push({ url, cacheFile: res.cacheFile || cacheFile, ...res.cacheWriteError });
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

  if (!listTexts.length) {
    const empty = [];
    attachListingError(empty, listingFailures);
    attachCacheMetadata(empty, usedCache, cacheFiles);
    attachDiagnostics(empty, { listingFailures, deepFetchFailures, cacheWriteFailures });
    return empty;
  }

  // 2) Parse + dedupe + filter + rank.
  const allTopics = [];
  const seen = new Set();
  for (const text of listTexts) {
    for (const t of site.parse(text)) {
      if (seen.has(t.url)) continue;
      seen.add(t.url);
      allTopics.push(t);
    }
  }
  const selected = selectAiTopics(allTopics, { limit: topicLimit, filter: site.exclude || null });
  if (!selected.length) {
    const empty = [];
    attachCacheMetadata(empty, usedCache, cacheFiles);
    attachDiagnostics(empty, { listingFailures, deepFetchFailures, cacheWriteFailures });
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
          const cacheFile = path.join(config.cacheDir, `${config.date}-${site.key}-topic-${t.id}.txt`);
          const res = await doFetch(t.url, config, {
            maxChars: Math.min(maxChars, 12000),
            provider: "auto",
            cacheFile,
            // Topic-page analogue of the list gate: the live path's own parser
            // (snippetOf) must extract something, so a cached challenge page is
            // re-fetched instead of replayed as an empty topic body.
            cachePredicate: (text) => site.snippetOf(text, "") !== "",
          });
          if (res?.cacheWriteError) {
            cacheWriteFailures.push({ url: t.url, cacheFile: res.cacheFile || cacheFile, ...res.cacheWriteError });
          }
          if (res?.fromCache) {
            usedCache = true;
            if (res.cacheFile || cacheFile) cacheFiles.push(res.cacheFile || cacheFile);
          }
          if (res?.text) deepMap.set(t.url, site.snippetOf(res.text, t.title));
        } catch (error) {
          deepFetchFailures.push({ url: t.url, message: error?.message || String(error) });
        }
      }),
    );
  }

  for (const t of selected) {
    const rawSnippet = deepMap.get(t.url) || `${site.provider} 社区讨论：${t.title}`;
    const card = {
      url: t.url,
      title: sanitizeSnippet(t.title, { maxChars: 200 }),
      snippet: sanitizeSnippet(rawSnippet),
      provider: site.provider,
      score: rankTopic(t),
    };
    if (isInjectionOnlySource(card)) continue;
    sources.push(card);
  }
  attachCacheMetadata(sources, usedCache, cacheFiles);
  attachDiagnostics(sources, { listingFailures, deepFetchFailures, cacheWriteFailures });
  return sources;
}

function attachListingError(sources, listingFailures) {
  if (!listingFailures.length) return;
  Object.defineProperty(sources, "communityError", {
    value: { kind: "listing", failures: listingFailures },
    enumerable: false,
  });
}
