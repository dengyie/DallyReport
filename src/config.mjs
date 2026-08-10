import "dotenv/config";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const DEFAULT_GROK_SEARCH_DIR = path.join(HOME, ".claude", "skills", "grok-search");
const DEFAULT_OBSIDIAN_DIR = path.join(
  HOME,
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "obsidian-note",
  "Note",
  "AI",
  "DallyReport",
);

// Single source of truth for the synthesis model + tuning. Read here, not re-read
// ad hoc from process.env in section modules, so the default lives in one place.
const DEFAULT_SYNTH_MODEL = "gpt-5.6-luna";
const DEFAULT_SYNTH_MAX_TOKENS = 4000;
const DEFAULT_SYNTH_TIMEOUT_MS = 90000;

// --- GitHub poster image generation (image-gen.mjs) ---
// The poster prompt + reference image live in the Obsidian vault (user-authored).
const DEFAULT_IMAGE_PROMPT_FILE = path.join(
  HOME,
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "obsidian-note",
  "Note",
  "AI",
  "AI 提示词",
  "图片生成提示词",
  "GitHub 日报海报提示词.md",
);
const DEFAULT_AI_IMAGE_PROMPT_FILE = path.join(
  HOME,
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "obsidian-note",
  "Note",
  "AI",
  "AI 提示词",
  "图片生成提示词",
  "AI 日报海报提示词.md",
);
const DEFAULT_IMAGE_REF_IMAGE = path.join(
  HOME,
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "obsidian-note",
  "OneNode",
  "assersts",
  "Pasted image 20260804185819.png",
);
// gpt-image-2 is the user-mandated model. CPA rejects gpt-image-1 on /images/*.
// Probed 2026-07-31: /images/generations is reliable; /images/edits (ref upload)
// works but the gateway/CF 524s ~126s, so retries + a generations fallback are
// wired in image-gen.mjs.
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_IMAGE_SIZE = "1024x1024";
const DEFAULT_IMAGE_TIMEOUT_MS = 180000;
const DEFAULT_IMAGE_RETRIES = 2;
const DEFAULT_IMAGE_SIPS_TIMEOUT_MS = 15000;

function val(name) {
  return process.env[name]?.trim() || null;
}

// Parse a comma-separated env list (e.g. community list URLs) into a non-empty
// string[], or null to mean "use the module default". A single trailing comma is
// tolerated so users can't silently break their list by ending it with one.
function csv(name) {
  const raw = val(name);
  if (!raw) return null;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} 必须是 >= 0 的整数，当前值: ${raw}`);
  }
  return n;
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} 必须是 > 0 的整数，当前值: ${raw}`);
  }
  return n;
}

export function buildQuery(template, today) {
  if (!template) return null;
  return template.replace(/\{date\}/g, today);
}

// The report and posters self-describe their timestamp as 北京时间, so the date
// must be the Beijing (UTC+8) calendar date regardless of the host machine's
// timezone. A CI/UTC box calling new Date() would otherwise label yesterday's
// or tomorrow's news as "today", and the poster {date} ("统计时间：{date}（北京时间）")
// would disagree with the date stamped in the output dir / front-matter / H1.
// Deterministic: takes Date.now()-free instant in ms, derives the YYYY-MM-DD that
// is current at UTC+8 at that instant. Exported for unit tests.
export function beijingDateFor(epochMs) {
  // +08:00 offset in ms; offset the instant then read the UTC components, which
  // mirrors what a wall clock in Asia/Shanghai would show.
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Image-gen creds: prefer dedicated IMAGE_* vars; fall back to the grok-search
// gateway (CPA exposes gpt-image-2 on the same /v1 base). Returns an Error with
// .code MISSING_IMAGE_CREDS or null. creds live in process.env, not loadConfig,
// matching how assertGrokCreds keeps creds out of the returned config object.
export function assertImageCreds() {
  const missing = [];
  if (!imageApiUrl()) missing.push("IMAGE_API_URL/GROK_API_URL");
  if (!imageApiKey()) missing.push("IMAGE_API_KEY/GROK_API_KEY");
  if (missing.length) {
    const err = new Error(
      `缺少生图必填环境变量 ${missing.join(", ")}。请在 .env 配置 IMAGE_API_URL/IMAGE_API_KEY（或复用 GROK_API_URL/GROK_API_KEY）。`,
    );
    err.code = "MISSING_IMAGE_CREDS";
    return err;
  }
  return null;
}

export function imageApiUrl() {
  return val("IMAGE_API_URL") || val("GROK_API_URL");
}

export function imageApiKey() {
  return val("IMAGE_API_KEY") || val("GROK_API_KEY");
}

// grok-search reads GROK_API_URL / GROK_API_KEY straight from process.env via its
// own config.js. We don't hard-require them at config load (GitHub section needs no
// Grok creds), but the AI section does - call this before issuing a Grok search.
export function assertGrokCreds() {
  const missing = [];
  if (!val("GROK_API_URL")) missing.push("GROK_API_URL");
  if (!val("GROK_API_KEY")) missing.push("GROK_API_KEY");
  if (missing.length) {
    const err = new Error(
      `缺少 grok-search 必填环境变量 ${missing.join(", ")}。请复制 .env.example 为 .env 填入。`,
    );
    err.code = "MISSING_GROK_CREDS";
    return err;
  }
  return null;
}

// Project root = this file's dir's parent. Used so reports-cache resolves to the
// project dir regardless of cwd (running from elsewhere wouldn't re-hit the net or
// split caches across directories).
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig({ date = null } = {}) {
  const imageEnabled = (() => {
    const raw = val("IMAGE_ENABLED");
    if (raw == null) return true;
    return raw === "1" || raw.toLowerCase() === "true";
  })();
  const config = {
    grokSearchDir: val("GROK_SEARCH_DIR") || DEFAULT_GROK_SEARCH_DIR,
    obsidianDir: val("OBSIDIAN_DIR") || DEFAULT_OBSIDIAN_DIR,
    days: int("GROK_DAYS", 1),
    // Report in strict-daily mode: when true, tavily/firecrawl sources without
    // timestamps are still included, but the report header annotates the material
    // window (today-only vs broader). Also enables the "来源不足" anti-hallucination
    // prompt clause. Default: true.
    reportStrictDaily: (() => {
      const raw = val("REPORT_STRICT_DAILY");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    // --- daily hard sources (HN/36kr/arXiv, zero-config public APIs) ---
    // These provide a stable baseline of ≥10 same-day sources so the model never
    // has to hallucinate from memory on quiet days. Each has an independent
    // enable/disable switch and a per-source limit.
    // aggregateDailySources: total limit for combined daily sources (capped).
    aggregateDailySourceLimit: int("AGGREGATE_DAILY_SOURCE_LIMIT", 15),
    hnDailyEnabled: (() => {
      const raw = val("HN_DAILY_ENABLED");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    hnDailyLimit: int("HN_DAILY_LIMIT", 5),
    kr36DailyEnabled: (() => {
      // 2026-08-11: 默认关闭。36kr 通过 Firecrawl 拿到的 URL 被重写为 feed 首页,
      // 所有条目 URL 相同导致去重合并。待找到稳定 provider 或 raw RSS 绕过 WAF 后再启用。
      if (true) return false; // TEMP: disabled pending URL stability
      const raw = val("KR36_DAILY_ENABLED");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    kr36DailyLimit: int("KR36_DAILY_LIMIT", 5),
    arxivDailyEnabled: (() => {
      const raw = val("ARXIV_DAILY_ENABLED");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    arxivDailyLimit: int("ARXIV_DAILY_LIMIT", 5),
    // -- search model override (default: use GROK_MODEL = synthModel) ---
    // When set, grok-cli.mjs passes this model to grok-search search.js instead
    // of GROK_MODEL, allowing the search step to use a cheaper/faster model while
    // the synthesis writer uses the main model. Leave unset for identical behavior.
    searchModel: val("GROK_SEARCH_MODEL") || null,
    extra: int("GROK_EXTRA", 10),
    fetchMaxChars: int("GROK_FETCH_MAX_CHARS", 80000),
    aiQueryTemplate: val("AI_QUERY") || "今天{date}最新的AI资讯和大模型动态",
    date,
    // --- linux.do forum AI source prioritization ---
    // When enabled (default), ai-news also scrapes linux.do 前沿快讯 + 人工智能 tag
    // and merges those sources ahead of generic Tavily/Firecrawl extras.
    linuxdoEnabled: (() => {
      const raw = val("LINUXDO_ENABLED");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    linuxdoListUrls: csv("LINUXDO_LIST_URLS"),
    linuxdoTopicLimit: int("LINUXDO_TOPIC_LIMIT", 8),
    linuxdoDeepFetch: (() => {
      const raw = val("LINUXDO_DEEP_FETCH");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    linuxdoDeepFetchLimit: int("LINUXDO_DEEP_FETCH_LIMIT", 5),
    // When true, fetch news/34 via the Discourse JSON API — captures ALL today's
    // posts (not just AI-filtered top-N) with accurate created_at/excerpt fields.
    linuxdoNews34JsonApi: (() => {
      const raw = val("LINUXDO_NEWS34_JSON_API");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    // Max linux.do source cards fed into synthesis (separate from sourceMaxTotal).
    // Allows all today's news/34 posts to flow through, while community+general
    // sources still respect AI_SOURCE_MAX_TOTAL for their combined budget.
    // Set to 0 to cap linux.do to the same pool as other sources.
    linuxdoMaxSources: int("LINUXDO_MAX_SOURCES", 50),
    // Optional login cookie for linux.do (raw Cookie header value, e.g. `_t=...; _u=...`).
    // When set, the news/34 JSON-API pagination fetches each page directly with this
    // cookie so deeper pages (2nd/3rd level) are read reliably without Tavily's
    // snapshot limits. Leave empty to keep using the provider stack (runFetch).
    linuxdoCookie: val("LINUXDO_COOKIE"),
    // CDP endpoint of the user's logged-in Chrome (e.g. Chrome launched with
    // --remote-debugging-port=9222). Used to drive a throwaway tab that fetches the
    // linux.do JSON with the real browser fingerprint — the only client whose TLS
    // fingerprint clears Cloudflare's cf_clearance. Leave empty to skip the browser
    // path (cookie then only a raw undici attempt, usually 403 → provider fallback).
    linuxdoCdpHost: val("LINUXDO_CDP_HOST") || "127.0.0.1:9222",
    // How many of the news/34 JSON-API cards to deep-fetch for real body snippets.
    // Independent of LINUXDO_TOPIC_LIMIT (which only gates the HTML-list path);
    // only applies when LINUXDO_NEWS34_JSON_API is on. Default 12 — gives the
    // synthesis model real body content for the top ~12 of today's posts; the rest
    // stay title-only. Raise for richer analysis, lower for a faster run.
    linuxdoNews34DeepLimit: int("LINUXDO_NEWS34_DEEP_FETCH_LIMIT", 40),
    // Post-report enrichment: crawl COMPLETE post bodies (OP + replies) via the
    // Discourse topic JSON API and download attachments into the vault. Disable to
    // keep the run light (scheduled/headless without the 9222 browser).
    linuxdoFullPosts: (() => {
      const raw = val("LINUXDO_FULL_POSTS");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    linuxdoDownloadAttachments: (() => {
      const raw = val("LINUXDO_DOWNLOAD_ATTACHMENTS");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    // How many today's posts to fully crawl (cap on the enrichment fan-out).
    linuxdoFullPostsLimit: int("LINUXDO_FULL_POSTS_LIMIT", 40),
    // Attachment safety valves per post: max files and max accumulated bytes.
    linuxdoAttachMaxPerPost: int("LINUXDO_ATTACH_MAX_PER_POST", 20),
    linuxdoAttachMaxBytesPerPost: int("LINUXDO_ATTACH_MAX_BYTES_PER_POST", 20 * 1024 * 1024),
    // Wall-clock budget for the whole post-report enrichment (complete-body crawl
    // + attachment downloads). On expiry the run skips re-rendering the 辅助资料
    // with embeds and prints a warning — the report and posters are unaffected.
    // 0 = no ceiling (the crawl still runs, it just may extend the run).
    linuxdoEnrichBudgetMs: int("LINUXDO_ENRICH_BUDGET_MS", 120000),
    // Cap on total sources fed to synthesis after merge (community first).
    sourceMaxTotal: int("AI_SOURCE_MAX_TOTAL", 18),
    // --- nodeseek.com community AI sources (nodeseek.mjs) ---
    nodeseekEnabled: (() => {
      const raw = val("NODESEEK_ENABLED");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    nodeseekListUrls: csv("NODESEEK_LIST_URLS"),
    nodeseekTopicLimit: int("NODESEEK_TOPIC_LIMIT", 6),
    nodeseekDeepFetch: (() => {
      const raw = val("NODESEEK_DEEP_FETCH");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    nodeseekDeepFetchLimit: int("NODESEEK_DEEP_FETCH_LIMIT", 3),
    // --- v2ex.com OpenAI-node community AI sources (v2ex.mjs) ---
    v2exEnabled: (() => {
      const raw = val("V2EX_ENABLED");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    v2exListUrls: csv("V2EX_LIST_URLS"),
    v2exTopicLimit: int("V2EX_TOPIC_LIMIT", 6),
    v2exDeepFetch: (() => {
      const raw = val("V2EX_DEEP_FETCH");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    v2exDeepFetchLimit: int("V2EX_DEEP_FETCH_LIMIT", 3),
    // GROK_MODEL governs BOTH the grok-search /responses search call (forwarded to
    // the child via childEnv) AND the llm-synthesize synthesis call. If you ever want
    // them independent, split into GROK_SEARCH_MODEL / SYNTH_MODEL here.
    synthModel: val("GROK_MODEL") || DEFAULT_SYNTH_MODEL,
    synthMaxTokens: positiveInt("GROK_SYNTH_MAX_TOKENS", DEFAULT_SYNTH_MAX_TOKENS),
    synthTimeoutMs: positiveInt("GROK_SYNTH_TIMEOUT_MS", DEFAULT_SYNTH_TIMEOUT_MS),
    // Optional backstop for the main-writer synthesis call. The main channel's
    // configured writer (e.g. gpt-5.6-luna) can be slow/flaky on some gateways
    // (Cloudflare ~120s cap → 524), which would otherwise degrade the report to a
    // raw-answer fallback. When set, a failed one-shot synthesis automatically
    // retries once with this model so the daily report still completes. Only used
    // for the non-gemini one-shot path; the gemini web_search loop is unaffected.
    synthFallbackModel: val("GROK_SYNTH_FALLBACK_MODEL") || "grok-4.5",
    // --- second AI channel (full dual-channel, ai-news.mjs + run.mjs) ---
    // When enabled, run.mjs registers an "ai-alt" section that reuses the whole
    // aiNewsSection pipeline (independent search + community merge + synthesis) with
    // a different writer model, landing in its own file <date>/AI-<slug>.md.
    // Writer models go through /chat/completions for synthesis only — native
    // /responses web_search is model-locked (non-Grok models 502 / return 0 tool
    // calls, probed 2026-08-06), so the real search sources stay model-agnostic.
    aiAltChannel: (() => {
      const raw = val("AI_ALT_CHANNEL");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    aiAltModel: val("AI_ALT_MODEL") || "gemini-3.6-flash",
    aiAltQueryTemplate: val("AI_ALT_QUERY"),
    aiAltFile: val("AI_ALT_FILE"),
    // The alt writer model gets its own synthesis budget instead of sharing
    // GROK_SYNTH_TIMEOUT_MS because writers can differ a lot in speed: gpt-5.6-luna
    // (~11s) is fast, but deepseek-v4-pro measured ~77s on a 200-token probe and
    // the shared 90s budget used to time out and degrade the note to the raw
    // answer (measured 2026-08-06). Default 5min keeps the margin.
    aiAltSynthTimeoutMs: positiveInt("AI_ALT_SYNTH_TIMEOUT_MS", 300000),
    // --- gemini-3.6-flash alt writer: client-side web_search tool loop ---
    // gemini is the only writer model on the gateway that voluntarily emits
    // web_search tool_calls (verified 2026-08-07; DeepSeek emits 0, Luna 502s).
    // When the alt writer is gemini and this is on, the synthesis path runs a
    // bounded client loop: each emitted query is executed through grok-search
    // (Tavily/Firecrawl), results fed back, then the model converges to the brief.
    // Set AI_ALT_GEMINI_WEBSEARCH=false to force plain single-shot synthesis (the
    // same path as the other writers).
    aiAltGeminiWebSearch: (() => {
      const raw = val("AI_ALT_GEMINI_WEBSEARCH");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    // Hard cap on web_search rounds so a runaway tool-call loop can't spin forever:
    // after this many rounds the loop drops the tool and forces a final answer.
    aiAltGeminiMaxRounds: int("AI_ALT_GEMINI_MAX_ROUNDS", 2),
    // cwd-independent cache dir, so reruns always read the same on-disk cache.
    cacheDir: path.join(PROJECT_ROOT, "reports-cache"),
    // GitHub poster image generation (image-gen.mjs). The prompt file + reference
    // image live in the vault; creds are read via assertImageCreds()/imageApi*(),
    // not threaded through here (kept out of the returned config like grok creds).
    imagePromptFile: val("IMAGE_PROMPT_FILE") || DEFAULT_IMAGE_PROMPT_FILE,
    imageRefImage: val("IMAGE_REF_IMAGE") || DEFAULT_IMAGE_REF_IMAGE,
    aiImagePromptFile: val("AI_IMAGE_PROMPT_FILE") || DEFAULT_AI_IMAGE_PROMPT_FILE,
    aiImageRefImage: val("AI_IMAGE_REF_IMAGE") || val("IMAGE_REF_IMAGE") || DEFAULT_IMAGE_REF_IMAGE,
    imageModel: val("IMAGE_MODEL") || DEFAULT_IMAGE_MODEL,
    imageSize: val("IMAGE_SIZE") || DEFAULT_IMAGE_SIZE,
    imageTimeoutMs: positiveInt("IMAGE_TIMEOUT_MS", DEFAULT_IMAGE_TIMEOUT_MS),
    imageSipsTimeoutMs: positiveInt("IMAGE_SIPS_TIMEOUT_MS", DEFAULT_IMAGE_SIPS_TIMEOUT_MS),
    imageRetries: int("IMAGE_RETRIES", DEFAULT_IMAGE_RETRIES),
    // When true, generate the poster after the GitHub section and embed it in
    // GitHub.md. Set IMAGE_ENABLED=false to skip entirely (e.g. offline runs).
    imageEnabled,
    // AI poster defaults to the global image switch, but can be disabled alone.
    aiImageEnabled: (() => {
      const raw = val("AI_IMAGE_ENABLED");
      if (raw == null) return imageEnabled;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
  };
  return config;
}

// Display-friendly slug for an alt-channel writer model, used for the alt file
// name (AI-<slug>.md) and the H1 subtitle. Known models map to short labels;
// anything else falls back to a sanitized kebab of the raw model id.
const ALT_MODEL_SLUGS = {
  "deepseek-v4-pro": "DeepSeek",
  "grok-4.5": "Grok",
  "gpt-5.6-luna": "Luna",
  "gemini-3.6-flash": "Gemini",
};
export function modelSlug(model) {
  if (ALT_MODEL_SLUGS[model]) return ALT_MODEL_SLUGS[model];
  const slug = String(model ?? "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "Alt";
}

// Resolve the alt-channel wiring from config. Returns null when the channel is
// disabled (single-channel mode). queryTemplate defaults to the main AI query so
// the alt channel searches the same topic; name/title default from the model slug.
export function resolveAltChannel(config) {
  if (!config.aiAltChannel) return null;
  const model = config.aiAltModel || "gemini-3.6-flash";
  const slug = modelSlug(model);
  return {
    name: config.aiAltFile || `AI-${slug}`,
    model,
    queryTemplate: config.aiAltQueryTemplate || config.aiQueryTemplate,
    // Alt writers are slower than grok-4.5 on /chat/completions, so they get a
    // dedicated, larger synthesis budget (default 5min) instead of the shared one.
    synthTimeoutMs: config.aiAltSynthTimeoutMs,
    title: `# AI 热点（${slug}）· ${config.date}`,
  };
}

export function validateRuntimePaths(config) {
  const warnings = [];
  const checks = [
    ["GROK_SEARCH_DIR", config?.grokSearchDir],
    ["OBSIDIAN_DIR", config?.obsidianDir],
    ["IMAGE_PROMPT_FILE", config?.imagePromptFile],
    ["IMAGE_REF_IMAGE", config?.imageRefImage],
    ["AI_IMAGE_PROMPT_FILE", config?.aiImagePromptFile],
  ];
  if (val("AI_IMAGE_REF_IMAGE")) {
    checks.push(["AI_IMAGE_REF_IMAGE", config?.aiImageRefImage]);
  }
  for (const [name, target] of checks) {
    if (!target) continue;
    try {
      if (!existsSync(target)) warnings.push(`${name} 不存在：${target}`);
    } catch (error) {
      warnings.push(`${name} 无法检查：${target}（${error.message}）`);
    }
  }
  return warnings;
}