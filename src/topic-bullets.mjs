import { stripMarkdown } from "./markdown.mjs";
import { clarifySnippet } from "./snippet-hygiene.mjs";

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

// 2026-10-18 §9.5.2 fallback: the deterministic safety net for title-only bullets.
//
// The synthesis prompt forbids them (rule 6), but two runs of the SAME code
// produced 8% and 32% bare bullets — the model emits them on some draws, and no
// guard can invent a body it never wrote. This is the last line, and it is
// deliberately non-generative: a bullet that is a bold headline plus a [N] with
// no body either
//   (a) takes the cited source's OWN excerpt as its body — real material the
//       model was already shown (same `clarifySnippet` hygiene as renderSources),
//       so nothing is fabricated; or
//   (b) is dropped when the source has no usable excerpt (empty, or one that only
//       echoes the title). Its [N] then stops being cited and leaves the
//       reference list — which is what rule 3 ("宁可整条略去也不要凑数") asks for.
// An English excerpt is translated with the same helper the localizer uses, so a
// backfilled body is Chinese like every other body.
const BARE_BODY_MIN = 20;
// A backfilled body should read like an authored bullet (~60-150 chars), not like
// a source card. Take a generous slice of the excerpt, then cut back to the last
// sentence end so the body never stops mid-clause.
const EXCERPT_MAX = 400;
const BODY_MAX = 240;
const SENTENCE_END = /[。！？；!?;.]/;

function clipExcerpt(s, max = BODY_MAX) {
  const text = String(s || "").trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (SENTENCE_END.test(head[i])) { cut = i; break; }
  }
  return cut >= 60 ? head.slice(0, cut + 1).trim() : `${head.trim()}…`;
}

function parseBulletHeadline(text) {
  const first = String(text).split("\n")[0];
  const m = first.match(/^(\s*)(?:[*+-]|\d+\.)\s+\*\*([\s\S]*?)\*\*([\s\S]*)$/);
  if (!m) return null;
  return { indent: m[1], headline: m[2].trim(), rest: m[3] || "" };
}

// Lowercase and drop all whitespace/punctuation/symbols, so "title echo" is a
// comparison of content rather than of formatting.
function echoKey(s) {
  return String(s || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export async function fillBareBullets(markdown, { sources = [], translate } = {}) {
  const blocks = bulletBlocks(markdown);
  const list = Array.isArray(sources) ? sources : [];
  const filled = [];
  const english = [];
  let dropped = 0;

  for (const block of blocks) {
    if (!block.bullet) continue;
    // A bare bullet is one physical line — there is no body to wrap. A multi-line
    // "headline-only" block is actually a glued bullet (headline, then a body line
    // without a list marker), which belongs to splitOverMergedBullets; filling it
    // here would delete the glued half.
    if (block.text.includes("\n")) continue;
    const parsed = parseBulletHeadline(block.text);
    if (!parsed) continue;
    // "Bare" = no body. Whitespace, punctuation and [N] markers are not content, so
    // both "* **T**。" and "* **T** [1]" are bare; only real text counts as a body.
    if (echoKey(parsed.rest.replace(CITE_GROUP, " "))) continue;

    const cites = [...block.text.matchAll(CITE_GROUP)].map((m) => m[1]).join(",");
    const n = Number.parseInt(String(cites).split(",")[0], 10);
    const src = Number.isInteger(n) && n >= 1 ? list[n - 1] : null;
    const title = src?.title ? String(src.title).trim() : "";
    let body = src ? clarifySnippet(src.snippet || "", title, { maxChars: EXCERPT_MAX }) : "";
    // clarifySnippet prefixes the title for an "obscure" (all-codename) excerpt;
    // strip that lead-in so the body does not restate its own headline.
    if (title && body.startsWith(title)) body = body.slice(title.length).replace(/^[。.，,、；;：:\s]+/, "");
    body = clipExcerpt(body);

    const key = echoKey(body);
    const titleKey = echoKey(title);
    const usable = body.length >= BARE_BODY_MIN && key && !(titleKey && titleKey.includes(key));
    if (!usable) {
      block.drop = true; // no excerpt to stand on → omit the bullet entirely
      dropped += 1;
      continue;
    }
    const entry = { block, indent: parsed.indent, headline: parsed.headline.replace(/[：:]\s*$/, ""), cites, body };
    filled.push(entry);
    if (!/[\u4e00-\u9fff]/.test(body)) english.push(entry);
  }

  // Nothing to fill AND nothing to drop → the text is already fine; return it
  // untouched. (Checking the drop count matters: an all-dropped section must
  // still return the filtered text, not the original.)
  if (filled.length === 0 && dropped === 0) return markdown;

  if (english.length && typeof translate === "function") {
    const out = await translate(english.map((e) => e.body));
    english.forEach((e, i) => {
      const t = out && out[i];
      if (t && String(t).trim()) e.body = String(t).trim();
    });
  }

  for (const e of filled) {
    e.block.text = `${e.indent}* **${e.headline}**：${e.body}${e.cites ? ` [${e.cites}]` : ""}`;
  }
  return blocks.filter((b) => !b.drop).map((b) => b.text).join("\n");
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
  "github", "huggingface", "show", "tech", "code",
  // Document/announcement words that are capitalized in a headline but name no
  // entity (2026-10-18 review): "Apple Intelligence 接入千问" under a title about
  // 苹果智能 used to read as two fabricated names.
  "intelligence", "institute", "university", "foundation", "research",
  "center", "centre", "report", "paper", "blog", "update", "release",
  "launch", "preview", "beta", "plus", "pro", "max", "mini", "turbo", "ultra"
]);

// Known entity alias groups: if a source title mentions any name in the group,
// mentioning another alias from the same group in the summary is valid context/attribution.
//
// Each group carries BOTH scripts for entities with a common Chinese name
// (苹果/Apple, 字节/ByteDance…). The 2026-10-18 thinness review: `properNames` is
// ASCII-only by construction, so a Chinese title naming 苹果 could never satisfy a
// Latin `Apple` in the prose — every cross-script mention read as a fabricated
// entity and (before fix #1) deleted the whole bullet. The CJK members are what
// `nameMatchesTitle` substring-matches inside the title.
const ALIAS_GROUPS = [
  new Set(["google", "谷歌", "gemini", "deepmind", "waymo", "android", "alphabet"]),
  new Set(["meta", "facebook", "脸书", "instagram", "whatsapp", "llama"]),
  new Set(["microsoft", "微软", "xbox", "azure", "copilot", "windows"]),
  new Set(["openai", "chatgpt", "codex", "sora", "dall-e", "gpt"]),
  new Set(["anthropic", "claude"]),
  new Set(["liquid", "liquidai", "lfm", "lfm2", "lfm2.5"]),
  new Set(["alibaba", "阿里巴巴", "阿里", "qwen", "tongyi", "千问", "通义千问", "aliyun"]),
  new Set(["bytedance", "字节跳动", "字节", "doubao", "豆包", "tiktok"]),
  new Set(["zhipu", "智谱", "glm", "chatglm"]),
  new Set(["moonshot", "月之暗面", "kimi"]),
  new Set(["stepfun", "step", "阶跃"]),
  new Set(["deepseek", "深度求索"]),
  new Set(["xai", "grok", "twitter"]),
  new Set(["amazon", "亚马逊", "aws", "bedrock", "titan", "alexa"]),
  new Set(["apple", "苹果", "ios", "macos", "siri"]),
  new Set(["nvidia", "英伟达"]),
  new Set(["intel", "英特尔"]),
  new Set(["tesla", "特斯拉"]),
  new Set(["samsung", "三星"]),
  new Set(["huawei", "华为"]),
  new Set(["xiaomi", "小米"]),
  new Set(["meituan", "美团"]),
  new Set(["baidu", "百度", "ernie", "文心"]),
  new Set(["tencent", "腾讯", "hunyuan", "混元"]),
  new Set(["sensetime", "商汤"]),
  new Set(["iflytek", "科大讯飞", "讯飞"]),
  new Set(["kuaishou", "快手"]),
  new Set(["jd", "京东"]),
  new Set(["netease", "网易"]),
  new Set(["stability", "stabilityai"])
];

// alias token → its group, so a Latin name in the prose resolves to the Chinese
// spelling when the title is checked. One flat index beats scanning every group.
const ALIAS_INDEX = new Map();
for (const group of ALIAS_GROUPS) {
  for (const name of group) ALIAS_INDEX.set(name, group);
}

function nameMatchesTitle(name, titleNames, titleText) {
  if (GENERIC_TECH_WORDS.has(name)) return true;
  if (titleNames.has(name)) return true;
  const group = ALIAS_INDEX.get(name);
  if (!group) return false;
  for (const tn of titleNames) {
    if (group.has(tn)) return true;
  }
  // Cross-script: the same entity under its Chinese name. Only CJK aliases are
  // substring-matched; a Latin alias still has to be a whole word (titleNames).
  const lowerTitle = String(titleText || "").toLowerCase();
  for (const alias of group) {
    if (/[\u4e00-\u9fff]/.test(alias) && lowerTitle.includes(alias)) return true;
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
  const body = rest.replace(/^\s+/, "").trim();
  const claim = body ? `${headline}：${body}` : headline;
  if (!driftsFromTitle(claim, title)) return text;
  // 2026-10-18 P0 (thinness review): this used to return `* **title** [N]`,
  // deleting the elaboration outright. That produced the shipped reports where
  // 33%–91% of bullets were a bare source title. The headline is the claim that
  // has to match the source; the body is the reader's value. Correct the
  // headline, keep the body verbatim, and never degrade a bullet to a title.
  const bodyText = body.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "").trim();
  if (!bodyText) {
    // Title-only bullet (the model gave no elaboration): keep the compact shape.
    return `${indent}* **${title}** ${/\[\d+\]/.test(body) ? body : `[${cites[0]}]`}`;
  }
  const withCite = /\[\d+\]/.test(body) ? body : `${body} [${cites[0]}]`;
  return `${indent}* **${title}**：${withCite}`;
}

export function driftsFromTitle(claim, title) {
  const raw = String(claim).replace(CITE_GROUP, " ");
  // Proper-name drift is judged on the HEADLINE only (2026-10-18 review). The
  // elaboration is where the writer legitimately adds vendor/product context; a
  // body that named Apple under a title that said 苹果 used to delete the whole
  // bullet as "drift". Amount mis-scaling and Chinese-overlap still cover the
  // full claim, so a fabricated figure or an invented event is still caught.
  const colon = raw.search(/[：:]/);
  const headline = colon === -1 ? raw : raw.slice(0, colon);

  const titleAmounts = new Set(amountValues(title));
  for (const value of amountValues(raw)) {
    if (!titleAmounts.has(value)) return true;
  }
  const titleNames = new Set(properNames(title));
  for (const name of properNames(headline)) {
    if (!nameMatchesTitle(name, titleNames, title)) return true;
  }
  if (/[\u4e00-\u9fff]/.test(title) && chineseRunsDiffer(raw, title)) return true;
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
 * Detect bullets whose HEADLINE is English (raw English titles from a fallback
 * or from a corrected source title) and translate them into Simplified Chinese
 * via the provided translate function. An English body under an English headline
 * is translated too; a Chinese body is kept verbatim (it is the reader's
 * content). Preserves citations [N], list markers, indentation and existing
 * Chinese bullets.
 */
export async function localizeEnglishBullets(markdown, { translate } = {}) {
  if (typeof translate !== "function") return markdown;
  const lines = String(markdown || "").split("\n");
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(BULLET_PATTERN);
    if (!m) continue;
    const [, indent, headline, , rest = ""] = m;
    const cites = [...rest.matchAll(CITE_GROUP)].map((cm) => cm[0]).join(" ");
    const restText = rest.replace(CITE_GROUP, " ").replace(/\s{2,}/g, " ").trim();
    // 2026-10-18 (§9.4 #1 side effect): the old whole-line CJK test skipped any
    // bullet whose body was Chinese, so an English source title placed above a
    // Chinese body (a corrected headline) survived untranslated. Gate on the
    // HEADLINE only — a Chinese headline is left alone as before.
    if (/[\u4e00-\u9fff]/.test(headline)) continue;
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
      // The body is localized only when it is itself English; a Chinese body
      // stays verbatim.
      if (!/[\u4e00-\u9fff]/.test(c.restText)) {
        workItems.push({ type: "desc", text: c.restText, cand: c });
      }
    }
  }

  // A short English headline over a Chinese body queues nothing (the headline is
  // a brand name, the body is already Chinese) — do not call the translator with
  // an empty batch.
  if (workItems.length === 0) return markdown;

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
    } else if (hItem) {
      // Headline translated, body (Chinese) kept verbatim: splice only the bold
      // headline, everything after it (colon, body, citations) stays untouched.
      lines[c.index] = lines[c.index].replace(
        /^\s*(?:[*+-]|\d+\.)\s+\*\*[\s\S]*?\*\*/,
        `${c.indent}* **${finalHeadline}**`,
      );
    }
    // else: a short English headline over a Chinese body queued nothing.
  }

  return lines.join("\n");
}
