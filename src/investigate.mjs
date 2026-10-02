// One investigator per topic, never per card.
//
// The investigator does not write the note. It fills a memo from a fixed
// question list. A field it cannot support stays in `unknowns`. Two supported
// values that disagree go to `conflicts` and neither becomes a claim. A URL
// the topic did not already have is appended to `addedSources` first; only
// then may it appear in `support`.
//
// Budgets live here, not in a prompt: concurrency 2, 3 searches and 90s per
// topic, 6 minutes for the whole run. A same-day cache hit skips the search.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mapLimit } from "./linuxdo.mjs";
import { provenanceOf } from "./topics.mjs";

const QUESTIONS = {
  release: ["product", "version", "publisher", "date", "change"],
  deal: ["buyer", "seller", "amount", "valuation", "status"],
  funding: ["round", "amount", "valuation", "lead", "status"],
  regulation: ["jurisdiction", "status", "behavior", "applies-to"],
  security: ["reporter", "impact", "count", "count-source"],
  partnership: ["parties", "what-expanded", "amount"],
};

const LIMITS = {
  concurrency: 2,
  searchesPerTopic: 3,
  topicMs: 90_000,
  runMs: 6 * 60_000,
};

const SECRET_KEY = /api[_-]?key|secret|token|password|authorization|bearer|cookie/i;

export function questionsFor(eventKind) {
  return QUESTIONS[eventKind] ? [...QUESTIONS[eventKind]] : [];
}

export function buildQueries(topic) {
  const questions = questionsFor(topic.eventKind);
  const title = topic.title || topic.cards?.[0]?.title || "";
  return questions.slice(0, LIMITS.searchesPerTopic).map((field) => ({
    field,
    query: `${title} ${field}`.trim(),
  }));
}

/**
 * Investigate every A/B topic. C and D are returned untouched and are not
 * searched. A topic that blows the run budget is demoted to C with
 * `demoted: "investigate-budget"`. `search` is injected; this module never
 * opens a network itself.
 */
export async function investigateTopics(topics, {
  search,
  now = Date.now,
  date,
  cacheDir,
  limits,
} = {}) {
  const bounds = { ...LIMITS, ...limits };
  const started = now();
  const deadline = started + bounds.runMs;
  let searches = 0;
  const eligible = (topics || []).filter((t) => t.grade === "A" || t.grade === "B");
  const memos = new Map();
  const demoted = new Map();

  // mapLimit's own deadline is wall-clock Date.now(), so a test clock must not
  // be handed to it. The run budget is checked here with the injected clock.
  await mapLimit(eligible, bounds.concurrency, async (topic) => {
    if (now() >= deadline) {
      demoted.set(topic.id, "investigate-budget");
      return;
    }
    const cached = readCached(cacheDir, date, topic);
    if (cached) {
      memos.set(topic.id, cached);
      return;
    }
    const remaining = deadline - now();
    const memo = await investigateOne(topic, {
      search,
      now,
      deadline: now() + Math.min(bounds.topicMs, remaining),
      budgetMs: Math.min(bounds.topicMs, remaining),
      searchesPerTopic: bounds.searchesPerTopic,
      date,
    });
    searches += memo.searches || 0;
    if (memo.demoted) demoted.set(topic.id, memo.demoted);
    else {
      memos.set(topic.id, memo);
      if (memo.complete) {
        try {
          writeCached(cacheDir, date, topic, memo);
        } catch {
          // A cache that refuses to store the memo must not take the topic's
          // findings with it, and must not sink the topics still queued.
          demoted.set(topic.id, "investigate-budget");
          memos.delete(topic.id);
        }
      }
    }
  });

  const out = (topics || []).map((topic) => {
    if (demoted.has(topic.id)) {
      return { ...topic, grade: "C", demoted: demoted.get(topic.id) };
    }
    return memos.has(topic.id) ? { ...topic, memo: memos.get(topic.id) } : topic;
  });
  return {
    topics: out,
    stats: {
      eligible: eligible.length,
      investigated: memos.size,
      searches,
      demoted: demoted.size,
      elapsedMs: now() - started,
    },
  };
}

export async function investigateOne(topic, {
  search,
  now = Date.now,
  deadline,
  budgetMs,
  searchesPerTopic = LIMITS.searchesPerTopic,
} = {}) {
  const questions = questionsFor(topic.eventKind);
  const claims = [];
  const unknowns = [];
  const conflicts = [];
  const addedSources = [];
  const known = new Set((topic.cards || []).map((c) => c.url).filter(Boolean));
  let searches = 0;
  let failed = false;
  for (const field of questions) {
    if (deadline && now() >= deadline) {
      return {
        topicId: topic.id,
        grade: topic.grade,
        claims,
        unknowns: questions,
        conflicts,
        addedSources,
        searches,
        demoted: "investigate-budget",
      };
    }
    if (searches >= searchesPerTopic) {
      unknowns.push(field);
      continue;
    }
    const budget = budgetMs ?? (deadline ? deadline - now() : LIMITS.topicMs);
    if (budget <= 0) {
      return {
        topicId: topic.id,
        grade: topic.grade,
        claims,
        unknowns: questions,
        conflicts,
        addedSources,
        searches,
        demoted: "investigate-budget",
      };
    }
    const signal = AbortSignal.timeout(budget);
    let found;
    try {
      found = await search?.(`${topic.title} ${field}`, { topic, field }, signal);
      searches += 1;
    } catch (err) {
      // A thrown search is not a result: do not cache it. An abort is the
      // budget itself — the topic is demoted, the remaining questions are
      // not asked, and the daily continues.
      if (signal.aborted || err?.name === "TimeoutError" || err?.name === "AbortError") {
        return {
          topicId: topic.id,
          grade: topic.grade,
          claims,
          unknowns: questions,
          conflicts,
          addedSources,
          searches,
          demoted: "investigate-budget",
        };
      }
      failed = true;
      unknowns.push(field);
      continue;
    }
    if (!Array.isArray(found)) {
      return {
        topicId: topic.id,
        grade: topic.grade,
        claims: [],
        unknowns: questions,
        conflicts: [],
        addedSources: [],
        searches,
        demoted: "investigate-invalid-json",
      };
    }
    const usable = [];
    for (const hit of found) {
      if (!hit || typeof hit !== "object" || !hit.value || !hit.url) continue;
      const knownCard = (topic.cards || []).find((c) => c.url === hit.url);
      const provenance = knownCard ? provenanceOf(knownCard) : "press";
      if (!known.has(hit.url)) {
        addedSources.push({ url: hit.url, title: hit.title || hit.value, provenance });
        known.add(hit.url);
      }
      usable.push({ ...hit, provenance });
    }
    const decided = decideField(field, usable, topic);
    if (decided.conflict) conflicts.push(decided.conflict);
    else if (decided.claim) claims.push(decided.claim);
    else unknowns.push(field);
  }
  return {
    topicId: topic.id,
    grade: topic.grade,
    claims,
    unknowns,
    conflicts,
    addedSources,
    searches,
    complete: !failed,
  };
}

function decideField(field, hits, topic) {
  if (!hits.length) return {};
  const byValue = new Map();
  for (const hit of hits) {
    if (!byValue.has(hit.value)) byValue.set(hit.value, []);
    byValue.get(hit.value).push(hit);
  }
  if (byValue.size > 1) {
    return {
      conflict: {
        field,
        values: [...byValue.keys()],
        support: hits.map((h) => h.url),
        // The raw hits stay on the memo so a credential field is still
        // visible to the cache refusal. The claim itself only keeps the
        // fields the synthesizer is allowed to read.
        hits,
      },
    };
  }
  const [value, group] = [...byValue.entries()][0];
  const hosts = new Set(group.map((h) => hostOf(h.url)).filter(Boolean));
  const officialCard = group.length === 1 && isTopicOfficialCard(group[0], topic);
  // Two hosts agreeing is `reported` even when one of them is the vendor's
  // own card. `official` is only that card standing alone. A search result
  // cannot grant itself official by setting a flag.
  const confidence = hosts.size > 1
    ? "reported"
    : officialCard
      ? "official"
      : "single";
  return {
    claim: {
      field,
      value,
      support: group.map((h) => h.url),
      confidence,
      hits: group,
    },
  };
}

function isTopicOfficialCard(hit, topic) {
  const card = (topic?.cards || []).find((c) => c.url === hit.url);
  return Boolean(card) && provenanceOf(card) === "official";
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function renderInvestigationInput(topics) {
  const lines = [];
  const investigated = (topics || []).filter((t) => t.memo);
  if (investigated.length) {
    lines.push("已调查主题（焦点只能从这些里面选，一条要点只写一个主题）：");
    for (const topic of investigated) {
      lines.push(`- ${topic.id} [${topic.grade}] ${topic.title}`);
      for (const claim of topic.memo.claims || []) {
        const hedge = claim.confidence === "single" ? "（仅一家来源，正文必须保留限定语）" : "";
        lines.push(`  - ${claim.field}: ${claim.value}${hedge} 来源 ${(claim.support || []).join(" ")}`);
      }
      for (const conflict of topic.memo.conflicts || []) {
        lines.push(`  - 冲突 ${conflict.field}: ${(conflict.values || []).join(" / ")}，两边都要写，不能选一边`);
      }
      if (topic.memo.unknowns?.length) lines.push(`  - 未知，禁止填写: ${topic.memo.unknowns.join(", ")}`);
    }
  } else {
    lines.push("当日没有可核的重大发布。");
  }
  return lines.join("\n");
}

export function cacheKey(topicOrKey) {
  const topicId = topicOrKey.topicId || topicOrKey.id || "";
  const url = topicOrKey.url || topicOrKey.cards?.[0]?.url || "";
  return `${slug(topicId)}__${slug(url)}`.slice(0, 180);
}

export function loadTopicCache(cacheDir, date, key) {
  const file = cacheFile(cacheDir, date, key);
  if (!file) return null;
  try {
    const memo = JSON.parse(readFileSync(file, "utf8"));
    if (!memo || typeof memo !== "object" || Array.isArray(memo)) return null;
    return { ...memo, file };
  } catch {
    return null;
  }
}

export function saveTopicCache(cacheDir, date, { topicId, url, memo }) {
  assertNoSecrets(memo);
  const file = cacheFile(cacheDir, date, { topicId, url });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(memo, null, 2)}\n`);
  return file;
}

function readCached(cacheDir, date, topic) {
  if (!cacheDir || !date) return null;
  const memo = loadTopicCache(cacheDir, date, topic);
  if (!memo) return null;
  const { file: _file, ...rest } = memo;
  return rest;
}

function writeCached(cacheDir, date, topic, memo) {
  if (!cacheDir || !date) return;
  saveTopicCache(cacheDir, date, {
    topicId: topic.id,
    url: topic.cards?.[0]?.url || "",
    memo,
  });
}

function cacheFile(cacheDir, date, key) {
  if (!cacheDir || !date) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : "undated";
  return path.join(cacheDir, "topics", day, `${cacheKey(key)}.json`);
}

function assertNoSecrets(value, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      const err = new Error(`topic cache refused a credential field: ${key}`);
      err.code = "TOPIC_CACHE_SECRET";
      throw err;
    }
    assertNoSecrets(child, seen);
  }
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
