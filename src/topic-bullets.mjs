import { stripMarkdown } from "./markdown.mjs";

// One bullet, one topic.
//
// The 2026-09-29 Gemini note put Qwen4, an image-fix, a Plus payment and a
// model poll into a single "[1, 3, 5, 7]". Citation numbers all resolved, and
// the sentence was still four events. This check runs after synthesis and
// before the reference list is built, so a dropped bullet cannot leave a
// dangling [N].
//
// A bullet is the whole run of lines that starts at a list marker, not one
// physical line: the model wraps, and the citation usually lands on the last
// line. A bullet whose citations resolve to more than one topicId is retried
// once. If the retry still crosses topics, that bullet is dropped and the
// next one stays.

const CITE_GROUP = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
const BULLET_START = /^(\s*)(?:[*+-]|\d+\.)\s+/;

export async function enforceOneTopicPerBullet(markdown, { topics, sources, retry } = {}) {
  const blocks = bulletBlocks(markdown);
  const out = [];
  for (const block of blocks) {
    if (!block.bullet || !crossesTopics(block.text, topics, sources)) {
      out.push(block.bullet ? faithfulSingle(block.text, sources) : block.text);
      continue;
    }
    const retried = typeof retry === "function" ? await retry(block.text) : "";
    if (retried && retried !== block.text && !crossesTopics(retried, topics, sources)) {
      out.push(retried);
      continue;
    }
    // The model's sentence joined the posts, so it cannot be sliced into the
    // replacement bullets. Each cited source keeps its own title.
    const split = splitBySource(block.text, sources);
    if (split) out.push(split);
  }
  return out.join("\n");
}

export function crossesTopics(text, topics, sources) {
  return topicIdsIn(text, topics, sources).size > 1;
}

function bulletBlocks(markdown) {
  const blocks = [];
  let current = null;
  for (const line of String(markdown || "").split("\n")) {
    if (BULLET_START.test(line) || current == null) {
      current = { bullet: BULLET_START.test(line), text: line };
      blocks.push(current);
      continue;
    }
    current.text += `\n${line}`;
  }
  return blocks;
}

// Number + unit as one token, so 15.75亿 is not 15 then 7.5.
// Unit is required: a bare "18" or "2026" is not an amount.
const AMOUNT = /\$?\s*(\d+(?:\.\d+)?)\s*(亿|万|million|billion|[mb](?![a-z]))/gi;
const NAMED = /\b[A-Z][A-Za-z0-9.+-]{2,}\b/g;

// Generic tech terms and abbreviations that appear naturally in AI tech news summaries
// and should never be counted as drifted "proper names".
const GENERIC_TECH_WORDS = new Set([
  "api", "sdk", "gpu", "cpu", "tpu", "npu", "llm", "agi", "app", "web",
  "tui", "gui", "cli", "saas", "bot", "pc", "mac", "ide", "json", "http",
  "https", "url", "html", "css", "rss", "cdp", "tts", "asr", "rag", "rlhf",
  "dpo", "sft", "cot", "vlm", "nlp", "ml", "dl", "ar", "vr", "xr", "mr",
  "ceo", "cto", "coo", "cfo", "ipo", "oss", "repo", "star", "stars", "arxiv",
  "github", "huggingface", "show", "tech", "code"
]);

// Known entity alias groups: if a source title mentions any name in the group,
// mentioning another alias from the same group in the summary is valid context/attribution.
const ALIAS_GROUPS = [
  new Set(["google", "gemini", "deepmind", "waymo", "android", "alphabet"]),
  new Set(["meta", "facebook", "instagram", "whatsapp", "llama"]),
  new Set(["microsoft", "xbox", "azure", "copilot", "windows"]),
  new Set(["openai", "chatgpt", "codex", "sora", "dall-e", "gpt"]),
  new Set(["anthropic", "claude"]),
  new Set(["liquid", "liquidai", "lfm", "lfm2", "lfm2.5"]),
  new Set(["alibaba", "qwen", "tongyi", "aliyun"]),
  new Set(["bytedance", "doubao", "tiktok"]),
  new Set(["zhipu", "glm", "chatglm"]),
  new Set(["moonshot", "kimi"]),
  new Set(["stepfun", "step"]),
  new Set(["deepseek"]),
  new Set(["xai", "grok", "twitter"]),
  new Set(["amazon", "aws", "bedrock", "titan", "alexa"]),
  new Set(["apple", "ios", "macos", "siri"])
];

function nameMatchesTitle(name, titleNames) {
  if (GENERIC_TECH_WORDS.has(name)) return true;
  if (titleNames.has(name)) return true;
  for (const group of ALIAS_GROUPS) {
    if (group.has(name)) {
      for (const tn of titleNames) {
        if (group.has(tn)) return true;
      }
    }
  }
  return false;
}

function cleanTitle(s) {
  if (!s) return "";
  return stripMarkdown(s).replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function faithfulSingle(text, sources) {
  const cites = citedNumbers(text);
  if (cites.length !== 1) return text;
  const source = (sources || [])[cites[0] - 1];
  const title = cleanTitle(source?.title);
  if (!title) return text;
  const titled = text.match(/^(\s*)(?:[*+-]|\d+\.)\s+\*\*([\s\S]*?)\*\*(?:[：:]\s*)?([\s\S]*)$/);
  if (!titled) return text;
  const [, indent, headline, rest = ""] = titled;
  const claim = `${headline} ${rest}`;
  if (!driftsFromTitle(claim, title)) return text;
  return `${indent}* **${title}** [${cites[0]}]`;
}

export function driftsFromTitle(claim, title) {
  const prose = String(claim).replace(CITE_GROUP, " ");
  const titleAmounts = new Set(amountValues(title));
  for (const value of amountValues(prose)) {
    if (!titleAmounts.has(value)) return true;
  }
  const titleNames = new Set(properNames(title));
  for (const name of properNames(prose)) {
    if (!nameMatchesTitle(name, titleNames)) return true;
  }
  if (/[\u4e00-\u9fff]/.test(title) && chineseRunsDiffer(prose, title)) return true;
  return false;
}

function chineseRunsDiffer(claim, title) {
  const cleanTitle = String(title).replace(/[^\u4e00-\u9fff]/g, "");
  if (cleanTitle.length < 2) return false;

  const titleBigrams = new Set();
  for (let i = 0; i < cleanTitle.length - 1; i++) {
    titleBigrams.add(cleanTitle.slice(i, i + 2));
  }

  const cleanClaim = String(claim).replace(/[^\u4e00-\u9fff]/g, "");
  if (cleanClaim.length < 2) return true;

  let matchedBigrams = 0;
  for (let i = 0; i < cleanClaim.length - 1; i++) {
    if (titleBigrams.has(cleanClaim.slice(i, i + 2))) {
      matchedBigrams++;
    }
  }

  const minRequired = Math.min(2, cleanTitle.length - 1);
  const titleRatio = matchedBigrams / (cleanTitle.length - 1);
  // Drift occurs if there is virtually no overlap between the claim and the source title
  return matchedBigrams < minRequired || titleRatio < 0.15;
}

function amountValues(text) {
  const compact = String(text || "").replace(/(\d)\s+(?=[亿万])/g, "$1");
  return [...compact.matchAll(AMOUNT)].map((m) => scale(m[1], m[2]));
}

function scale(number, unit) {
  const n = Number(number);
  const u = String(unit || "").toLowerCase();
  if (u === "亿") return n * 1e8;
  if (u === "万") return n * 1e4;
  if (u === "b" || u === "billion") return n * 1e9;
  if (u === "m" || u === "million") return n * 1e6;
  return n;
}

function properNames(text) {
  return [...String(text || "").matchAll(NAMED)].map((m) => m[0].toLowerCase());
}

function citedNumbers(text) {
  const out = [];
  for (const match of String(text || "").matchAll(CITE_GROUP)) {
    for (const part of match[1].split(",")) {
      const n = Number.parseInt(part.trim(), 10);
      if (Number.isInteger(n) && n > 0) out.push(n);
    }
  }
  return out;
}

function splitBySource(text, sources) {
  const list = sources || [];
  const seen = new Set();
  const lines = [];
  const indent = text.match(/^(\s*)/)?.[1] || "";
  for (const match of String(text || "").matchAll(CITE_GROUP)) {
    for (const part of match[1].split(",")) {
      const n = Number.parseInt(part.trim(), 10);
      if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue;
      const source = list[n - 1];
      const title = cleanTitle(source?.title);
      if (!title) continue;
      seen.add(n);
      lines.push(`${indent}* **${title}** [${n}]`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function topicIdsIn(text, topics, sources) {
  const ids = new Set();
  const list = sources || [];
  const index = new Map();
  (topics || []).forEach((topic, i) => {
    for (const card of topic.cards || []) {
      if (card?.url) index.set(card.url, topic.id || `topic-${i}`);
    }
  });
  for (const match of String(text || "").matchAll(CITE_GROUP)) {
    for (const part of match[1].split(",")) {
      const n = Number.parseInt(part.trim(), 10);
      const source = list[n - 1];
      const id = source?.url ? index.get(source.url) : undefined;
      if (id) ids.add(id);
    }
  }
  return ids;
}

const BULLET_PATTERN = /^(\s*)(?:[*+-]|\d+\.)\s+\*\*([\s\S]*?)\*\*(?:([：:])\s*)?([\s\S]*)$/;

/**
 * Detect bullets that lack Chinese text (e.g. raw English titles from fallback
 * or models) and translate them into Simplified Chinese via the provided translate function.
 * Preserves citations [N], list markers, indentation and existing Chinese bullets.
 */
export async function localizeEnglishBullets(markdown, { translate } = {}) {
  if (typeof translate !== "function") return markdown;
  const lines = String(markdown || "").split("\n");
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/[\u4e00-\u9fff]/.test(line)) continue;
    const m = line.match(BULLET_PATTERN);
    if (!m) continue;
    const [, indent, headline, colon, rest = ""] = m;
    const cites = [...rest.matchAll(CITE_GROUP)].map((cm) => cm[0]).join(" ");
    const restText = rest.replace(CITE_GROUP, " ").replace(/\s{2,}/g, " ").trim();
    candidates.push({
      index: i,
      indent,
      headline: headline.trim(),
      restText,
      cites,
    });
  }

  if (candidates.length === 0) return markdown;

  const workItems = [];
  for (const c of candidates) {
    if (!c.restText) {
      workItems.push({ type: "headline", text: c.headline, cand: c });
    } else {
      const words = c.headline.split(/\s+/).filter(Boolean);
      if (words.length > 2) {
        workItems.push({ type: "headline", text: c.headline, cand: c });
      }
      workItems.push({ type: "desc", text: c.restText, cand: c });
    }
  }

  const rawTexts = workItems.map((w) => w.text);
  const translated = await translate(rawTexts);
  workItems.forEach((w, i) => {
    w.translated = (translated && translated[i]) || w.text;
  });

  for (const c of candidates) {
    const hItem = workItems.find((w) => w.cand === c && w.type === "headline");
    const dItem = workItems.find((w) => w.cand === c && w.type === "desc");
    const finalHeadline = hItem ? hItem.translated : c.headline;
    const citePart = c.cites ? ` ${c.cites}` : "";
    if (dItem) {
      lines[c.index] = `${c.indent}* **${finalHeadline}**：${dItem.translated}${citePart}`;
    } else {
      lines[c.index] = `${c.indent}* **${finalHeadline}**${citePart}`;
    }
  }

  return lines.join("\n");
}
