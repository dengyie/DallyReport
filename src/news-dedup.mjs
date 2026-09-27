// Deterministic semantic de-duplication + title normalization for the AI news
// synthesis input.
//
// Why: linux.do's news/34 feed is a high-signal same-day source, but a single
// event (e.g. the recurring ChatGPT/Codex free-quota reset) often spawns many
// posts with wildly different titles — "重置了重置了！", "codex 周一还会重置！",
// "奥特曼又给重置了", "Codex余额已重置，Tibo回应称明天周一会再次重置" are all the
// same story. URL-dedup (mergeSourcesPreferLinuxDo) can't see that, so all of
// them reach the synthesis model, which then has to guess they're one event —
// and the raw titles are often not self-contained ("重置了重置了！" means nothing
// to a reader who missed the context). This module folds same-event clusters
// into a single representative card with a clear, self-contained title.
//
// Deterministic, zero-LLM, fail-safe: a source that matches no cluster passes
// through untouched, and the representative keeps the richest snippet so the
// model still gets the details behind the rewritten headline.

import { sanitizeSnippet } from "./snippet-hygiene.mjs";

// --- Event clusters ---------------------------------------------------------
// Each cluster: { key, match, weakMatch?, exclude?, rewrite }.
//   match:     RegExp tested against the raw title (case-insensitive). A source
//              whose title matches carries POSITIVE evidence for this event and
//              is always folded into the cluster.
//   weakMatch: optional RegExp for titles that mention the event's action but
//              carry no evidence of its object ("重置了重置了！"). These fold
//              ONLY when the same cluster already has a positive-evidence
//              member — that is what lets the vague real posts collapse into the
//              event without a vague post ever inventing one.
//   exclude:   optional RegExp — a title matching it is NOT clustered, whatever
//              else it says (guards a broad match against a different object).
//   rewrite:   (title) => clear self-contained news title, or a plain string.
// The representative of a cluster gets the rewritten title; the other members
// are dropped. Order is preserved: the representative sits where the first
// member was.
const CLUSTERS = [
  {
    // The recurring ChatGPT/Codex free-quota reset (Tibo/OpenAI resets balances).
    // 2026-09-26 review root fix: the match used to be the bare /重置|reset/i
    // guarded only by an 8-noun blocklist, which could not bound it. It
    // deterministically REWROTE unrelated reset stories into a fabricated
    // OpenAI event — verified folding "Google 账号安全重置新流程上线",
    // "Redis 连接池 reset 后异常", "Claude 上下文窗口重置策略调整" and
    // "Mistral API rate limit reset" into "ChatGPT/Codex 额度重置", a different
    // vendor and a different event, which then reached the model as a source
    // title. A blocklist cannot constrain a match this broad, so the structure
    // changed instead of the vocabulary:
    //   - match     = reset AND a quota object (额度/配额/余额/quota). This is the
    //     only positive evidence, because it is the only thing that identifies
    //     THIS event. A vendor name alone is not: "Claude 上下文窗口重置策略调整"
    //     is a different event that happens to mention a vendor we care about.
    //     Note `limit` is deliberately NOT a quota object — "Mistral API rate
    //     limit reset" is a rate-limit reset, not a balance reset.
    //   - weakMatch = bare reset naming no foreign product. These are the real
    //     vague posts ("重置了重置了！", "codex 周一还会重置！") and they still
    //     fold — but only onto a cluster a positive-evidence title established.
    //     A day of purely vague resets leaves every card untouched.
    //   - exclude   guards the positive match, where the object can plausibly be
    //     something other than a balance (keys, prompts, routers, cloud quotas…).
    //
    // 2026-09-27 review (round 4) P1-1. "reset AND a quota object" is still not
    // enough to identify THIS event: it names no VENDOR, so "Gemini 额度重置",
    // "Claude 额度重置了新周期" and "DeepSeek 余额重置" all matched positively and
    // were rewritten into "ChatGPT/Codex 额度重置" — a different company,
    // deterministically fabricated, handed to the synthesis model as a source
    // title. `ownEntities` listed 额度/配额/余额/quota as "this event's own
    // entities", which is exactly backwards: those nouns are the *generic* half
    // of the match and appear in every vendor's announcement. So the quota nouns
    // move OUT of ownEntities and the positive path gains an explicit vendor
    // constraint: a title qualifies only if it names no AI vendor OTHER than
    // the ones this event actually is (OpenAI/Codex/ChatGPT/Gemini). A title
    // that names no vendor at all is still positive evidence — the real forum
    // posts ("重置了重置了！"'s siblings with an explicit object) frequently
    // mention no brand, and excluding them would cost the module its job.
    key: "quota-reset",
    match:
      /(?:重置|reset).*(?:额度|配额|余额|quota)|(?:额度|配额|余额|quota).*(?:重置|reset)/i,
    // Any OTHER AI vendor makes the story that vendor's, not OpenAI's.
    vendorMatch:
      /\b(?:gemini|claude|anthropic|deepseek|mistral|qwen|通义|千问|llama|豆包|智谱|混元|文心|ernie|kimi|moonshot|deepmind)\b|gemini|claude|anthropic|deepseek|mistral|qwen|千问|llama|豆包|智谱|混元|文心|ernie|kimi/i,
    weakMatch: /重置|reset/i,
    exclude:
      /密码|password|密钥|\bkeys?\b|系统提示|提示词|教程|路由器|固件|factory|会话|session|配置|settings|上下文窗口|context window|区域|region|\baws\b|\bgcp\b|\bazure\b|政策|流程|规则|制度|风控|申诉|实名/i,
    // Entity tokens that belong to THIS event: their presence in a weak title
    // does not make it a foreign story, so they are discounted before the
    // "does it name some other product?" check runs. Deliberately does NOT
    // include 额度/配额/余额/quota — see above.
    ownEntities: /chatgpt|codex|\bgpt\b|openai|gemini|奥特曼|tibo/gi,
    // 2026-09-27 review E1: the rewrite makes a factual claim about WHO reset,
    // so it may only fire when a title actually names this event's vendor. The
    // deny list above fails open on every name it has not met — xAI/Grok, Cursor,
    // Midjourney and Perplexity were all measured being rewritten into
    // "ChatGPT/Codex 额度重置", i.e. a different company, handed to the synthesis
    // model as a source title. An allow-list needs no maintenance when the next
    // vendor ships: it simply declines to claim a story it cannot attribute.
    // Applied across the whole cluster (see clusterHasOwnVendor), so a brandless
    // "额度重置了" folds onto its real sibling instead of being renamed alone.
    ownVendor: /chatgpt|codex|\bgpt\b|openai|奥特曼|tibo/i,
    rewrite: () => "ChatGPT/Codex 额度重置",
  },
  {
    // 115 网盘 API 暂停服务 — two posts, same event.
    key: "cloud-api-pause",
    match: /115.*API.*暂停/i,
    rewrite: () => "115 网盘 API 暂停服务",
  },
  {
    // Apple removed the Qwen extension from its China site — two posts, same event.
    // Real titles put the action between the two entities, either order:
    // "苹果中国官网删除 Apple 智能接入阿里千问使用手册" (苹果→删除→千问) and
    // "苹果貌似撤回了有关Apple智能的千问扩展内容" (苹果→撤回→千问). But the plain
    // combination "苹果…千问" alone must NOT match — the earlier "iPhone 接入千问"
    //合作 news is the opposite event (adding, not removing).
    key: "apple-qwen-removal",
    match: /苹果.*千问.*(?:删除|撤回|下架|移除)|苹果.*(?:删除|撤回|下架|移除).*千问/i,
    // 2026-09-27 review E2: this cluster had no evidence requirement, and its
    // match fires on 苹果…千问…删除 — which a DEBUNK also satisfies. Measured:
    // 「苹果回应：从未移除千问接入」 was rewritten into "苹果中国官网删除 Apple
    // 智能接入阿里千问使用手册", the exact opposite of the thread, asserted to
    // the synthesis model as a source title. The cluster's own comment already
    // warned that the bare pairing 苹果…千问 would catch the opposite event; the
    // negation slipped through the same way. Requires a SECOND post reporting
    // the same action (weakMatch) and rejects denials outright.
    weakMatch: /苹果.*千问.*(?:删除|撤回|下架|移除)|苹果.*(?:删除|撤回|下架|移除).*千问/i,
    exclude: /从未|未曾|否认|辟谣|没有|不存在|仍可|仍能|可正常|未删除|未撤回|未下架|未移除|依旧|仍然/i,
    requiresSibling: true,
    rewrite: () => "苹果中国官网删除 Apple 智能接入阿里千问使用手册",
  },
];

// Score a snippet's "substance": real Chinese/English prose counts up; URLs and
// Discourse chrome count down. The representative should carry the most informative
// body, not merely the longest one — a long Cloudflare challenge URL or a
// "Topic list, column headers..." chrome line is longer but useless (observed on
// 2026-08-09: the longest reset-post snippet was a Turnstile URL, so the model got
// almost no real body behind the rewritten headline).
const CJK_RE = /[一-鿿]/gu;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9'./'-]{4,}/g;
const URL_RE = /https?:\/\/\S+/gi;
const CHROME_RE =
  /Topic list|column headers|sortable|Troubleshoot|cdn-cgi|challenges\.cloudflare|turnstile|select all|cancel selecting|linuxdo-attachments|\.(?:png|jpe?g|webp|gif)\b/i;

function snippetSubstanceScore(snippet) {
  const s = String(snippet || "");
  if (!s.trim()) return -Infinity;
  const noUrls = s.replace(URL_RE, " "); // URLs carry no prose — strip before counting
  const cjk = (noUrls.match(CJK_RE) || []).length;
  const latin = (noUrls.match(LATIN_WORD_RE) || []).length;
  const chrome = CHROME_RE.test(s) ? 1 : 0;
  return cjk + latin - chrome * 10;
}

// Among a cluster's members, keep the one with the most substantive snippet — the
// model then sees the rewritten headline plus the most informative body behind it.
function pickRepresentative(members) {
  return members.reduce((best, m) => {
    const score = snippetSubstanceScore(m?.snippet);
    const bestScore = snippetSubstanceScore(best?.snippet);
    return score > bestScore ? m : best;
  }, members[0]);
}

// Does this weak title name a product/entity that has nothing to do with the
// cluster's event? Strips the cluster's own entities first, then looks for any
// other Latin product token or a known foreign CJK subject. This is what stops a
// vague "reset" post from joining a quota cluster when it is plainly about
// something else (Redis, SQLite, AWS regions, password flows…).
const FOREIGN_ENTITY_RE = /\b[\w-]*(?:redis|sqlite|postgres|mysql|kafka|rabbit|mongo|docker|kube\w*|linux|windows|aws|azure|gcp|nginx|apache|node|npm|react|vue|java|rust|golang|python|django|flask|git|github|gitlab|systemd|journald|router|firmware|token|session|cookie|password|login|captcha|turnstile|cloudflare|rate[\s_-]?limit|throttl\w*|quota[\s_-]?policy)\b/i;
// 2026-09-27 review (round 4) P1-2. Added: mistral and the CJK policy/flow/
// account vocabulary. This list is the ONLY thing standing between a vague
// "重置" post about a different subject and the ChatGPT/Codex cluster, and it
// was missing exactly the subjects that were being folded.
const FOREIGN_CJK_RE = /路由器|固件|密码|密钥|系统提示|提示词|教程|配置|会话|注册|刷机|越狱|破解|政策|流程|规则|制度|账号|账户|帐号|安全|风控|申诉|实名|认证/;

function namesForeignEntity(title, cluster) {
  const stripped = cluster.ownEntities
    ? title.replace(new RegExp(cluster.ownEntities.source, "gi"), " ")
    : title;
  return FOREIGN_ENTITY_RE.test(stripped) || FOREIGN_CJK_RE.test(stripped);
}

// A title is a positive-evidence cluster member when it states BOTH the action
// (reset) and the object (a balance/quota) and is not excluded. Weak titles need
// a positive-evidence sibling before they may fold — see the CLUSTERS comment for
// why that two-tier rule exists.
function clusterMatchFor(title, cluster, hasPositiveMember) {
  if (cluster.exclude && cluster.exclude.test(title)) return null;
  // P1-1: a positive match must not merely state a quota reset, it must not
  // state ANOTHER VENDOR's quota reset. This runs BEFORE `match` so a foreign
  // vendor's announcement can never become positive evidence in the first place
  // — otherwise it would establish the evidence a later vague post folds onto.
  if (cluster.vendorMatch && cluster.vendorMatch.test(title)) return null;
  if (cluster.match.test(title)) {
    // 2026-09-27 review E2: a cluster whose rewrite asserts an EVENT happened
    // (`requiresSibling`) needs a second post reporting it, so one forum claim
    // is never published as fact on the module's own authority. The verdict stays
    // "positive" — it is a real report of the action, which is exactly what
    // sibling evidence is made of; COUNTING the cluster is where the requirement
    // lives. Demoting it to the weak tier instead would make a two-post fold
    // impossible: neither member could ever be positive.
    return "positive";
  }
  if (!cluster.weakMatch) return null;
  if (!cluster.weakMatch.test(title)) return null;
  // P1-2: co-presence. `exclude` covers the object when a title is read on its
  // own, but this check is the only guard once a real quota card has put the
  // cluster in play. A foreign story is just as foreign here.
  if (namesForeignEntity(title, cluster)) return null;
  return hasPositiveMember ? "weak" : null;
}

// Pass 1 is run twice on purpose. Whether a title may fold as a weak member
// depends on whether ANY title in the same cluster carries positive evidence —
// which is a whole-input question, not a left-to-right one. So pass 1 records
// every title's tentative strength, and pass 2 resolves the weak ones against
// the final evidence. A single left-to-right pass would let the last title decide
// what the first one was allowed to do.
function scanClusterStrength(sources) {
  const tentative = new Map(); // cluster key -> { positive: bool, weakIdx: number[] }
  for (let i = 0; i < sources.length; i++) {
    const title = String(sources[i]?.title || "");
    for (const c of CLUSTERS) {
      const verdict = clusterMatchFor(title, c, true); // pass 1: admit weak tentatively
      if (!verdict) continue;
      if (!tentative.has(c.key)) tentative.set(c.key, { positive: false, weakIdx: [] });
      const entry = tentative.get(c.key);
      if (verdict === "positive") entry.positive = true;
      else entry.weakIdx.push(i);
      break; // first matching cluster claims the title
    }
  }
  return tentative;
}

/**
 * Fold same-event sources into a single representative card and rewrite its
 * title to a clear, self-contained news headline. Non-cluster sources pass
 * through unchanged, in order. Returns a NEW array; the input is not mutated.
 *
 * @param {Array<{url:string,title?:string,snippet?:string,provider?:string}>} sources
 * @returns {Array<{url:string,title?:string,snippet?:string,provider?:string}>}
 */
export function dedupeAndNormalizeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return sources || [];

  const tentative = scanClusterStrength(sources);
  const clusters = new Map(); // key -> { members: [], slots: [], positive: bool }
  const out = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const title = String(s?.title || "");
    let matched = null;
    let weak = false;
    for (const c of CLUSTERS) {
      const verdict = clusterMatchFor(title, c, true);
      if (!verdict) continue;
      matched = c;
      weak = verdict === "weak";
      break;
    }
    if (!matched) {
      out.push(s);
      continue;
    }
    const evidence = tentative.get(matched.key);
    // Pass 2: a weak title only folds if the cluster survived with positive
    // evidence. Without it this cluster is discarded entirely below and the card
    // is restored untouched.
    if (weak && !evidence?.positive) {
      out.push(s);
      continue;
    }
    if (!clusters.has(matched.key)) {
      clusters.set(matched.key, { members: [], slots: [], positive: false });
    }
    const entry = clusters.get(matched.key);
    entry.members.push(s);
    entry.slots.push(out.length);
    out.push(null); // placeholder, rewritten below (or restored if discarded)
    if (!weak) entry.positive = true;
  }

  for (const [key, { members, slots, positive }] of clusters) {
    // A cluster that only ever collected weak titles never had evidence for its
    // own event — restore those cards untouched instead of inventing a headline.
    if (!positive) {
      members.forEach((m, idx) => {
        out[slots[idx]] = m;
      });
      continue;
    }
    const cluster = CLUSTERS.find((c) => c.key === key);
    // 2026-09-27 review E2: some rewrites assert that an EVENT happened, which is
    // a stronger claim than "these posts are about one topic" and needs a second
    // post reporting it before the module speaks for the fact. One forum claim —
    // or a refutation that happens to name the same action — is not enough.
    if (cluster.requiresSibling && members.length < 2) {
      members.forEach((m, idx) => {
        out[slots[idx]] = m;
      });
      continue;
    }
    // 2026-09-27 review E1: the rewrite is a factual claim about a specific
    // actor, so it requires that SOME title in the cluster actually names it.
    // Checked across the whole cluster, not per-title, so the brandless forum
    // posts ("重置了重置了！") still fold onto their real sibling.
    if (cluster.ownVendor && !members.some((m) => cluster.ownVendor.test(String(m?.title || "")))) {
      members.forEach((m, idx) => {
        out[slots[idx]] = m;
      });
      continue;
    }
    const rep = pickRepresentative(members);
    const rewritten =
      typeof cluster.rewrite === "function" ? cluster.rewrite(rep?.title) : cluster.rewrite;
    // A fold must UNION provenance, not inherit the representative's. The
    // representative is chosen by snippet richness, which is usually the forum
    // card — so a same-day hard-source card folded into it silently lost the
    // `fromDaily` flag and stopped counting toward 当日素材, which could push an
    // adequately-stocked day under the low-material threshold. The surviving card
    // still represents the whole cluster, so it counts if ANY member was fromDaily.
    const fromDaily = members.some((m) => m?.fromDaily === true);
    out[slots[0]] = {
      ...rep,
      ...(fromDaily ? { fromDaily: true } : {}),
      title: sanitizeSnippet(rewritten, { maxChars: 200 }),
    };
    // The representative keeps its own slot; the other members collapse into it.
    for (let idx = 1; idx < slots.length; idx++) out[slots[idx]] = null;
  }
  return out.filter((s) => s !== null);
}
