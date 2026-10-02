// Turn source cards into topics and grade them before any investigator runs.
//
// Deterministic and offline. A model is not consulted: the 2026-09-29 daily
// showed that handing every card to one synthesis call is what produces a
// trailer, a usage poll and a four-day-old bugfix as if they were the day's
// news. Grades decide who is worth a search budget. They do not write prose.
//
// Grouping stops at the first key that exists:
//   1. a CLUSTERS fold already recorded on the card (`clusterKey`);
//   2. a vendor+product pair from the closed allow-list below;
//   3. the normalized URL;
//   4. otherwise the card is its own topic.
// An unknown vendor never folds, and never receives an actor the titles did
// not name. There is no open-ended vendor list to "be conservative" about.

const PROVENANCE_RANK = { official: 0, press: 1, community: 2, repo: 3 };

const PRESS_HOSTS = new Set([
  "techcrunch.com",
  "theverge.com",
  "www.theverge.com",
  "infoq.cn",
  "www.infoq.cn",
  "arstechnica.com",
  "www.reuters.com",
  "reuters.com",
]);

const COMMUNITY_HOSTS = new Set([
  "linux.do",
  "www.v2ex.com",
  "v2ex.com",
  "www.nodeseek.com",
  "nodeseek.com",
]);

const REPO_HOSTS = new Set(["github.com", "www.github.com"]);

// Closed. A name that is not here is not an actor, even if the host looks official.
const ACTORS = [
  { name: "OpenAI", re: /\bopenai\b|\bchatgpt\b|\bcodex\b|\bgpt-\d/i },
  { name: "Nvidia", re: /\bnvidia\b|英伟达/i },
  { name: "AMD", re: /\bamd\b/i },
  { name: "World Labs", re: /world labs/i },
  { name: "Shopify", re: /\bshopify\b/i },
  { name: "Google", re: /\bgoogle\b/i },
  { name: "Modal", re: /\bmodal\b/i },
  { name: "Imagination", re: /\bimagination\b/i },
  { name: "Qwen", re: /\bqwen\b|通义|千问/i },
  { name: "Florida", re: /\bflorida\b|佛罗里达/i },
];

// Vendor + one named product. Two cards fold only when BOTH name the same pair.
// A vendor alone is not enough: "OpenAI 发布" and "OpenAI 扩大支持" are two events.
const PRODUCTS = [
  { actor: "Shopify", product: "checkout", re: /\bcheckout\b|结账/i },
  { actor: "OpenAI", product: "gpt-6-astra", re: /gpt-6\s*astra/i },
  { actor: "Nvidia", product: "rogue-agents", re: /rogue ai agents|失控.*智能体/i },
  { actor: "Modal", product: "funding-round", re: /\$?\s?750\s?m|15\.75\s?b/i },
  { actor: "World Labs", product: "amd", re: /\bamd\b/i },
  { actor: "Imagination", product: "e-series", re: /E\s*系列/ },
];

const EVENT_KINDS = [
  ["funding", /融资|\$\s?\d|亿美元|closing in on|valuation|round\b|raises?\b/i],
  ["deal", /joining|收购|acquires?|merger|to acquire/i],
  ["regulation", /ban\b|禁止|立法|监管|seeks a ban|法案/i],
  ["security", /hacking|攻击|rogue|失控|漏洞|breach/i],
  ["partnership", /扩大.*支持|expanded support|grows landmark|合作/i],
  ["release", /发布|launches?|推出|opens?|上线|announces?|发布了|2x faster|faster with|新进展/i],
];

const HEDGED = /消息人士|据称|接近完成|据报道|source:|closing in on|reportedly/i;
const DIRECTORY = /try \d+|个小|个体验|0\.8b|tiny llm|in the browser|github\.com\//i;
const NO_FACT = /用的什么|预告片|trailer|投票|怎么选|求推荐/i;

export function topicize(cards) {
  const groups = [];
  const byKey = new Map();
  for (const card of cards || []) {
    const members = card?.clusterMembers?.length ? card.clusterMembers : [card];
    const key = topicKey(card, members);
    if (!byKey.has(key)) {
      const topic = {
        id: key,
        title: card?.title || "",
        cards: [],
        actors: [],
        publishedAt: null,
        provenance: "community",
      };
      byKey.set(key, topic);
      groups.push(topic);
    }
    const topic = byKey.get(key);
    for (const member of members) {
      if (topic.cards.some((c) => c.url && c.url === member.url)) continue;
      topic.cards.push(member);
    }
    const titles = [card?.title || "", ...topic.cards.map((c) => c.title || "")];
    topic.actors = actorsIn(titles.join("\n"));
    topic.publishedAt = topic.cards.reduce((acc, c) => newer(acc, c.publishedAt), null);
    topic.provenance = topic.cards.reduce(
      (acc, c) => harder(acc, provenanceOf(c)),
      provenanceOf(topic.cards[0]),
    );
    // A cluster fold already picked its headline. The longest member snippet
    // must not overwrite it, or the topic title drifts back to the raw forum post.
    topic.title = card?.clusterKey ? (card.title || topic.title) : (representativeTitle(topic.cards) || topic.title);
  }
  return groups;
}

export function gradeTopics(topics, { date } = {}) {
  return (topics || []).map((topic) => ({ ...topic, ...gradeOne(topic, date) }));
}

export function applyGradeCap(topics, { mode } = {}) {
  const limit = mode === "weekly" ? 8 : 4;
  const ranked = topics
    .map((topic, index) => ({ topic, index }))
    .filter(({ topic }) => topic.grade === "A" || topic.grade === "B")
    .sort((a, b) => compareRank(a.topic, b.topic) || a.index - b.index);
  const keep = new Set(ranked.slice(0, limit).map(({ topic }) => topic.id));
  const capped = [];
  const out = topics.map((topic) => {
    if ((topic.grade !== "A" && topic.grade !== "B") || keep.has(topic.id)) return topic;
    const demoted = { ...topic, grade: "C", capped: "topic-cap" };
    capped.push(demoted);
    return demoted;
  });
  return { topics: out, capped };
}

function gradeOne(topic, date) {
  const text = [topic.title, ...topic.cards.map((c) => `${c.title || ""}\n${c.snippet || ""}`)].join("\n");
  const eventKind = EVENT_KINDS.find(([, re]) => re.test(text))?.[0] || null;
  const hedged = HEDGED.test(text);
  const stale = Boolean(topic.publishedAt && date && String(topic.publishedAt) < date);
  if (topic.provenance === "repo" || DIRECTORY.test(text) || NO_FACT.test(text)) {
    return { grade: "D", eventKind };
  }
  if (topic.provenance === "community" || stale) return { grade: "C", eventKind };
  if (!topic.actors.length) return { grade: "D", eventKind };
  if (!eventKind) return { grade: "D", eventKind };
  // A hedged report and a partnership name a real actor but not a finished event.
  if (hedged || eventKind === "partnership") return { grade: "B", eventKind };
  if (topic.provenance === "official" || topic.provenance === "press") return { grade: "A", eventKind };
  return { grade: "B", eventKind };
}

function topicKey(card, members) {
  if (card?.clusterKey) return `cluster:${card.clusterKey}`;
  const titles = members.map((m) => m?.title || "").join("\n");
  const pair = productPair(titles);
  if (pair) return `product:${pair.actor}:${pair.product}`;
  const url = normalizeUrl(card?.url);
  if (url) return `url:${url}`;
  return `title:${String(card?.title || "").trim()}`;
}

function productPair(text) {
  const actors = actorsIn(text);
  if (actors.length !== 1) return null;
  const hit = PRODUCTS.find((p) => p.actor === actors[0] && p.re.test(text));
  return hit ? { actor: hit.actor, product: hit.product } : null;
}

function normalizeUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|source$)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return String(url).split("?")[0];
  }
}

export function provenanceOf(card) {
  let host = "";
  try {
    host = new URL(card?.url || "").hostname.toLowerCase();
  } catch {
    host = "";
  }
  const title = card?.title || "";
  if (REPO_HOSTS.has(host) || DIRECTORY.test(title)) return "repo";
  if (COMMUNITY_HOSTS.has(host)) return "community";
  if (PRESS_HOSTS.has(host)) return "press";
  if (host) return "official";
  return "community";
}

function actorsIn(text) {
  return ACTORS.filter((actor) => actor.re.test(text || "")).map((actor) => actor.name);
}

function representativeTitle(cards) {
  return cards.reduce((best, card) => {
    const score = String(card?.snippet || card?.title || "").length;
    const bestScore = String(best?.snippet || best?.title || "").length;
    return score > bestScore ? card : best;
  }, cards[0])?.title || "";
}

function harder(a, b) {
  return PROVENANCE_RANK[a] <= PROVENANCE_RANK[b] ? a : b;
}

function newer(a, b) {
  if (!b) return a;
  if (!a) return b;
  return String(a) > String(b) ? a : b;
}

function compareRank(a, b) {
  const provenance = (topic) => (topic.provenance === "official" ? 2 : topic.provenance === "press" ? 1 : 0);
  if (provenance(a) !== provenance(b)) return provenance(b) - provenance(a);
  const dateA = a.publishedAt ? Date.parse(a.publishedAt) || 0 : 0;
  const dateB = b.publishedAt ? Date.parse(b.publishedAt) || 0 : 0;
  if (dateA !== dateB) return dateB - dateA;
  return (b.cards?.length || 0) - (a.cards?.length || 0);
}
