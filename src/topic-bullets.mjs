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

function faithfulSingle(text, sources) {
  const cites = citedNumbers(text);
  if (cites.length !== 1) return text;
  const source = (sources || [])[cites[0] - 1];
  const title = String(source?.title || "").trim();
  if (!title) return text;
  const titled = text.match(/^(\s*)(?:[*+-]|\d+\.)\s+\*\*([\s\S]*?)\*\*(?:[：:]\s*)?([\s\S]*)$/);
  if (!titled) return text;
  const [, indent, headline, rest = ""] = titled;
  const claim = `${headline} ${rest}`;
  if (!driftsFromTitle(claim, title)) return text;
  return `${indent}* **${title}** [${cites[0]}]`;
}

function driftsFromTitle(claim, title) {
  const prose = String(claim).replace(CITE_GROUP, " ");
  const titleAmounts = new Set(amountValues(title));
  for (const value of amountValues(prose)) {
    if (!titleAmounts.has(value)) return true;
  }
  const titleNames = new Set(properNames(title));
  for (const name of properNames(prose)) {
    if (!titleNames.has(name)) return true;
  }
  if (/[\u4e00-\u9fff]/.test(title) && chineseRunsDiffer(prose, title)) return true;
  return false;
}

function chineseRunsDiffer(claim, title) {
  const compactTitle = String(title).replace(/\s+/g, "");
  const runs = String(claim).match(/[\u4e00-\u9fff]{2,}/g) || [];
  return runs.some((run) => !compactTitle.includes(run));
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
      const title = String(source?.title || "").trim();
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
