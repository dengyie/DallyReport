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
const DEFAULT_SYNTH_MODEL = "grok-4.5";
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
const DEFAULT_IMAGE_REF_IMAGE = path.join(
  HOME,
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "obsidian-note",
  "OneNode",
  "assersts",
  "Pasted image 20260730051155.png",
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
  const config = {
    grokSearchDir: val("GROK_SEARCH_DIR") || DEFAULT_GROK_SEARCH_DIR,
    obsidianDir: val("OBSIDIAN_DIR") || DEFAULT_OBSIDIAN_DIR,
    days: int("GROK_DAYS", 2),
    extra: int("GROK_EXTRA", 10),
    fetchMaxChars: int("GROK_FETCH_MAX_CHARS", 80000),
    aiQueryTemplate:
      val("AI_QUERY") ||
      "今天{date}最新的AI资讯和大模型动态（优先关注 linux.do 论坛前沿快讯与人工智能相关讨论）",
    date,
    // --- linux.do forum AI source prioritization ---
    // When enabled (default), ai-news also scrapes linux.do 前沿快讯 + 人工智能 tag
    // and merges those sources ahead of generic Tavily/Firecrawl extras.
    linuxdoEnabled: (() => {
      const raw = val("LINUXDO_ENABLED");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    linuxdoListUrls: (() => {
      const raw = val("LINUXDO_LIST_URLS");
      if (!raw) return null; // module default
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    })(),
    linuxdoTopicLimit: int("LINUXDO_TOPIC_LIMIT", 8),
    linuxdoDeepFetch: (() => {
      const raw = val("LINUXDO_DEEP_FETCH");
      if (raw == null) return true;
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    linuxdoDeepFetchLimit: int("LINUXDO_DEEP_FETCH_LIMIT", 5),
    // Cap on total sources fed to synthesis after merge (linux.do first).
    sourceMaxTotal: int("AI_SOURCE_MAX_TOTAL", 16),
    // GROK_MODEL governs BOTH the grok-search /responses search call (forwarded to
    // the child via childEnv) AND the llm-synthesize synthesis call. If you ever want
    // them independent, split into GROK_SEARCH_MODEL / SYNTH_MODEL here.
    synthModel: val("GROK_MODEL") || DEFAULT_SYNTH_MODEL,
    synthMaxTokens: positiveInt("GROK_SYNTH_MAX_TOKENS", DEFAULT_SYNTH_MAX_TOKENS),
    synthTimeoutMs: positiveInt("GROK_SYNTH_TIMEOUT_MS", DEFAULT_SYNTH_TIMEOUT_MS),
    // cwd-independent cache dir, so reruns always read the same on-disk cache.
    cacheDir: path.join(PROJECT_ROOT, "reports-cache"),
    // GitHub poster image generation (image-gen.mjs). The prompt file + reference
    // image live in the vault; creds are read via assertImageCreds()/imageApi*(),
    // not threaded through here (kept out of the returned config like grok creds).
    imagePromptFile: val("IMAGE_PROMPT_FILE") || DEFAULT_IMAGE_PROMPT_FILE,
    imageRefImage: val("IMAGE_REF_IMAGE") || DEFAULT_IMAGE_REF_IMAGE,
    imageModel: val("IMAGE_MODEL") || DEFAULT_IMAGE_MODEL,
    imageSize: val("IMAGE_SIZE") || DEFAULT_IMAGE_SIZE,
    imageTimeoutMs: positiveInt("IMAGE_TIMEOUT_MS", DEFAULT_IMAGE_TIMEOUT_MS),
    imageSipsTimeoutMs: positiveInt("IMAGE_SIPS_TIMEOUT_MS", DEFAULT_IMAGE_SIPS_TIMEOUT_MS),
    imageRetries: int("IMAGE_RETRIES", DEFAULT_IMAGE_RETRIES),
    // When true, generate the poster after the GitHub section and embed it in
    // GitHub.md. Set IMAGE_ENABLED=false to skip entirely (e.g. offline runs).
    imageEnabled: (() => {
      const raw = val("IMAGE_ENABLED");
      if (raw == null) return true; // on by default
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
  };
  return config;
}

export function validateRuntimePaths(config) {
  const warnings = [];
  const checks = [
    ["GROK_SEARCH_DIR", config?.grokSearchDir],
    ["OBSIDIAN_DIR", config?.obsidianDir],
    ["IMAGE_PROMPT_FILE", config?.imagePromptFile],
    ["IMAGE_REF_IMAGE", config?.imageRefImage],
  ];
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