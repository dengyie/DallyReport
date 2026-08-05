// v2ex.com 人工智能/OpenAI 板块 AI-news source collector.
//
// Why this exists: V2EX's `/go/openai` node is a high-signal same-day Chinese tech
// community feed on OpenAI/Claude/agents/models that the generic search rarely
// surfaces cleanly. Data-diversity source like linux.do / NodeSeek — merged ahead
// of general sources for synthesis, never written into the shipped note.
//
// Structure: listing page exposes `[title](/t/<id>#replyN)` links (the #replyN is
// the reply-count anchor). We fetch page 1 (newest ~20) and filter AI titles.

import { fetchCommunitySources } from "./community.mjs";
import { sanitizeSnippet } from "./snippet-hygiene.mjs";

export const DEFAULT_LIST_URLS = ["https://www.v2ex.com/go/openai"];

// Drop pure noise/off-topic even if keyword-adjacent.
const EXCLUDE_TITLE_RE =
  /关于[“"「].*(类别|分类|版块)|社区准则|邀请函|.{0,10}(合租|拼车|车位|年付|月付|折扣|优惠|促销).{0,10}(账号|号|车|会员|chatgpt|gpt)|邀请码|出售.*账号|求购|纯手工/i;

/**
 * Parse topic {url, title, id} entries out of a V2EX listing extract.
 * Links look like `[title](/t/1232147#reply58)` or `[title](/t/1232147)`.
 * Exported for unit tests.
 */
export function parseV2exTopics(text) {
  if (!text) return [];
  const re = /\[([^\n]{2,300})\]\(\/t\/(\d+)(?:#\w+)?\)/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = String(m[1] || "")
      .replace(/\\\|/g, "|")
      .replace(/\s+/g, " ")
      .trim();
    const id = Number.parseInt(m[2], 10);
    const url = `https://www.v2ex.com/t/${id}`;
    if (!title || !Number.isFinite(id)) continue;
    if (seen.has(url)) continue;
    seen.set(url, { url, title, id });
  }
  return [...seen.values()];
}

// Pull a usable snippet from a topic extract. V2EX extracts render each reply as a
// markdown table row; the OP body usually appears as the first substantive cell.
// We collapse the table rows and take the first CJK-prose row. Exported for tests.
export function snippetFromV2exTopicText(text, title, maxChars = 400) {
  if (!text) return "";
  const rows = String(text)
    .split(/\n+/)
    .map((p) => p.replace(/^\s*\|/, "").replace(/\|\s*$/, ""))
    .map((p) => p.split("|").map((c) => c.trim()).filter(Boolean))
    .filter((cells) => cells.length >= 2)
    .map((cells) => cells[cells.length - 1]) // content is usually the last cell
    .map((p) => p.replace(/\[@[^\]]*\]\([^)]*\)/g, "").replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 20)
    .filter((p) => /[一-鿿]{4,}/.test(p))
    .filter((p) => !/^(登录|注册|回复|关于|❤️)/.test(p));
  const pick = rows[0] || "";
  if (!pick) return "";
  return sanitizeSnippet(pick, { maxChars });
}

/**
 * Fetch V2EX OpenAI-node AI sources for the daily report.
 * @param {object} config loadConfig() output
 * @param {object} [deps] { runFetch } injected for tests
 */
export async function fetchV2exAiSources(config, deps = {}) {
  return fetchCommunitySources(
    {
      key: "v2ex",
      provider: "v2ex",
      listUrls: DEFAULT_LIST_URLS,
      parse: parseV2exTopics,
      snippetOf: snippetFromV2exTopicText,
      exclude: EXCLUDE_TITLE_RE,
      topicLimit: 6,
      deepFetchLimit: 3,
    },
    config,
    deps,
  );
}