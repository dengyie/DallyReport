// nodeseek.com (NodeSeek) AI-news source collector.
//
// Why this exists: NodeSeek is a high-signal same-day Chinese tech/developer forum
// (models, GPU pricing, agent/tooling chatter) that the generic Tavily/Firecrawl
// search rarely surfaces. Like linux.do it is a data-diversity source: merged ahead
// of general sources for synthesis, never written into the shipped note.
//
// Structure: custom forum, listing pages expose `[title](/post-<id>-<page>)` links.
// The homepage + /page-2 list the newest posts across all boards; we filter to
// AI-related titles and drop VPS-trade noise (NodeSeek is host/GPU heavy).

import { fetchCommunitySources } from "./community.mjs";
import { sanitizeSnippet } from "./snippet-hygiene.mjs";

export const DEFAULT_LIST_URLS = [
  "https://www.nodeseek.com/",
  "https://www.nodeseek.com/page-2",
];

// Drop non-content / trade / sticky noise even if keyword-adjacent (NodeSeek is a
// host-trading community; 收鸡/出鸡/年付/测评/TQ-NQ留档 threads are not AI news).
const EXCLUDE_TITLE_RE =
  /关于[“"「].*(类别|分类|版块)|社区准则|邀请函|办卡|运营商|学费|步枪|ddr5.*步枪|收.{0,6}鸡|出.{0,6}鸡|.{0,8}(年付|月付|季付|季续|折扣|优惠|促销|特价|活动).{0,8}(鸡|机|云|vps|服务器|机场)|留档|测评|测速|TQ|NQ|溢价|求购|出售|邀请码|纯手工|黑五|BF|闪购|秒杀|充值/i;

/**
 * Parse topic {url, title, id} entries out of a fetched NodeSeek listing page.
 * Links look like `[title](/post-859511-1)` (page suffix is the reply-page). The
 * title regex is greedy over non-newlines so titles that themselves contain `]`
 * (e.g. `[[NQ] 绿云JP…]`) are captured whole. Exported for unit tests.
 */
export function parseNodeSeekTopics(text) {
  if (!text) return [];
  const re = /\[([^\n]{2,300})\]\((\/post-(\d+)-\d+)\)/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = String(m[1] || "")
      .replace(/\\\|/g, "|")
      .replace(/\s+/g, " ")
      .trim();
    const id = Number.parseInt(m[3], 10);
    const url = `https://www.nodeseek.com/post-${id}-1`;
    if (!title || !Number.isFinite(id)) continue;
    if (seen.has(url)) continue;
    seen.set(url, { url, title, id });
  }
  return [...seen.values()];
}

// Pull a usable snippet from a topic page extract. NodeSeek extracts put the OP
// body as the first long paragraphs before replies (avatars are image links we
// strip). Exported for unit tests.
export function snippetFromNodeSeekTopicText(text, title, maxChars = 500) {
  if (!text) return "";
  let body = String(text);
  body = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // avatars / stickers
    .replace(/#\s*\[[^\]]*\]\([^)]*\)/g, "") // H1 title link
    .replace(/\[@[^\]]*\]\([^)]*\)/g, "") // @mentions
    .replace(/\[#\d+\]\([^)]*\)/g, "") // reply refs
    .replace(/\[[^\]]{0,80}\]\(https?:\/\/[^)]+\)/g, " ") // bare md links
    .replace(/\*\*|__|`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Fused chrome lines (e.g. "所有版块 快捷功能区 你好啊陌生人 登录 注册") pass the
  // length filter but carry no OP content. Reject any line that *starts* with a
  // chrome token; the whole-line form additionally catches lone tokens on their own
  // line. Both anchored so a chrome token buried mid-sentence is left intact.
  const chromeRe =
    /^(views?|likes?|users?|####|所有版块|快捷功能区|你好啊|陌生人|登录|注册|推荐阅读|管理记录|幸运抽奖|邀请好友|合作商家|友站链接|📈|🎉|(新评论|新帖子))(\s+.*)?$/i;
  const paras = body
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 12)
    .filter((p) => !/^#/.test(p))
    .filter((p) => !chromeRe.test(p));
  const candidates = paras.filter(
    (p) => p.length >= 20 && /[一-鿿]{4,}|[A-Za-z]{8,}/.test(p),
  );
  const pick = candidates[0] || paras[0] || "";
  if (!pick) return "";
  return sanitizeSnippet(pick, { maxChars });
}

/**
 * Fetch NodeSeek AI sources for the daily report.
 * @param {object} config loadConfig() output
 * @param {object} [deps] { runFetch } injected for tests
 */
export async function fetchNodeSeekAiSources(config, deps = {}) {
  return fetchCommunitySources(
    {
      key: "nodeseek",
      provider: "nodeseek",
      listUrls: DEFAULT_LIST_URLS,
      parse: parseNodeSeekTopics,
      snippetOf: snippetFromNodeSeekTopicText,
      exclude: EXCLUDE_TITLE_RE,
      topicLimit: 6,
      deepFetchLimit: 3,
    },
    config,
    deps,
  );
}
