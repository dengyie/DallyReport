// Daily hard-source fetchers (HN / 36kr / arXiv) — parse & filter logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchHackerNewsDaily,
  fetch36krDaily,
  fetchArxivDaily,
  beijingMidnightMs,
  fetchAllDailySources,
  fetchOfficialBlogRss,
  fetchOpenaiDaily,
  fetchHfDaily,
  fetchGoogleAiDaily,
  fetchGoogleResearchDaily,
  interleaveAndCap,
  fetchTechcrunchAiDaily,
  fetchVergeAiDaily,
  fetchQbitaiDaily,
  fetchInfoqCnDaily,
} from "../src/sources-daily.mjs";

const TODAY = "2026-08-10";

// A minimal RSS 2.0 body. The vendor RSS fetchers had ZERO test coverage, which
// is how a 12-day cache-key collision shipped unnoticed.
const FEED_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item>
    <title>Introducing a new model</title>
    <link>https://example.com/blog/new-model</link>
    <pubDate>Mon, 10 Aug 2026 08:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

test("beijingMidnightMs: 08-10 Beijing midnight = 08-09T16:00Z", () => {
  assert.equal(beijingMidnightMs(TODAY), Date.UTC(2026, 7, 9, 16, 0, 0));
  assert.equal(beijingMidnightMs("2026-01-01"), Date.UTC(2025, 11, 31, 16, 0, 0));
});

// --- HN ---

async function hnHarness(items, { limit = 5 } = {}) {
  // fake global fetch: topstories -> [1,2,3,4,5]; item -> items[id]
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("topstories")) {
      return { ok: true, json: async () => items.map((_, i) => i + 1) };
    }
    const id = Number(url.match(/item\/(\d+)\.json/)?.[1] || 0);
    const item = items[id - 1];
    return { ok: true, json: async () => item ?? null };
  };
  const config = { date: TODAY };
  try {
    return await fetchHackerNewsDaily(config, { limit });
  } finally {
    globalThis.fetch = original;
  }
}

test("HN: returns same-day AI-relevant stories with publishedAt", async () => {
  const todaySec = Math.floor(Date.UTC(2026, 7, 9, 20, 0, 0) / 1000); // 08-10 04:00 北京
  const items = [
    { title: "GPT-5.6 arrives", url: "https://openai.com", type: "story", time: todaySec, score: 42 },
    { title: "Random fishing blog", url: "https://example.com", type: "story", time: todaySec },
    { title: "New LLM beats benchmarks", url: "https://news.example", type: "story", time: todaySec },
    { title: "Old AI story", url: "https://x.com/old", type: "story", time: Math.floor(Date.UTC(2026, 7, 8) / 1000) },
    { title: "Comment without url", url: "", type: "comment", time: todaySec },
  ];
  const sources = await hnHarness(items);
  assert.ok(Array.isArray(sources));
  // Item 1 (GPT-5.6) + item 3 (LLM) should pass; item 2 no AI match; item 4 stale;
  // item 5 not a story.
  assert.equal(sources.length, 2);
  assert.equal(sources[0].provider, "hackernews");
  assert.ok(sources[0].publishedAt > 0);
});

test("HN: API failure -> [] (never throws)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const out = await fetchHackerNewsDaily({ date: TODAY });
    assert.deepEqual(out, []);
  } finally {
    globalThis.fetch = original;
  }
});

test("HN: limit caps output", async () => {
  const todaySec = Math.floor(Date.UTC(2026, 7, 9, 20, 0, 0) / 1000);
  const items = [
    { title: "AI story one", url: "https://a.com", type: "story", time: todaySec },
    { title: "AI story two", url: "https://b.com", type: "story", time: todaySec },
    { title: "AI story three", url: "https://c.com", type: "story", time: todaySec },
  ];
  const sources = await hnHarness(items, { limit: 2 });
  assert.equal(sources.length, 2);
});

// --- 36kr ---

const KR36_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>36氪</title>
<item>
<title><![CDATA[OpenAI 发布新一代推理模型]]></title>
<link>https://36kr.com/p/123</link>
<description><![CDATA[<p>今日 OpenAI 发布新模型，推理能力大幅提升。</p>]]></description>
<pubDate>Mon, 10 Aug 2026 01:00:00 +0800</pubDate>
</item>
<item>
<title><![CDATA[某公司融资 5000 万]]></title>
<link>https://36kr.com/p/456</link>
<description><![CDATA[非 AI 内容。]]></description>
<pubDate>Mon, 10 Aug 2026 02:00:00 +0800</pubDate>
</item>
<item>
<title><![CDATA[大模型落地制造业案例]]></title>
<link>https://36kr.com/p/789</link>
<description><![CDATA[AI 相关。]]></description>
<pubDate>Sun, 09 Aug 2026 10:00:00 +0800</pubDate>
</item>
</channel></rss>`;

test("36kr: parses same-day AI items, strips CDATA/HTML, drops stale", async () => {
  const config = { date: TODAY, cacheDir: "/tmp/nonexistent-cache-dir-xyz" };
  const sources = await fetch36krDaily(config, {
    runFetch: async () => ({ text: KR36_SAMPLE }),
    limit: 5,
  });
  assert.ok(sources.length >= 1);
  const openai = sources.find((s) => s.title.includes("OpenAI"));
  assert.ok(openai, "OpenAI item should pass AI filter");
  assert.equal(openai.provider, "36kr");
  assert.equal(openai.snippet.includes("<p>"), false, "HTML stripped");
  // The 大模型 item (08-09 10:00 +0800 = 08-09) is before 08-10 midnight → should
  // be excluded by the fetcher's same-day gate.
  assert.ok(!sources.some((s) => s.title.includes("大模型")), "stale item dropped");
});

test("36kr: fetch failure -> [] (never throws)", async () => {
  const config = { date: TODAY };
  const out = await fetch36krDaily(config, {
    runFetch: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(out, []);
});

// --- arXiv ---

const ARXIV_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
<title>CreativeInstruct: Teaching LLMs</title>
<id>http://arxiv.org/abs/2608.10001v1</id>
<summary>We propose a new method for LLM training.</summary>
<published>2026-08-10T04:00:00Z</published>
</entry>
<entry>
<title>Stale Paper</title>
<id>http://arxiv.org/abs/2608.09999v1</id>
<summary>Old stuff.</summary>
<published>2026-08-05T02:00:00Z</published>
</entry>
</feed>`;

test("arXiv: parses same-day papers, normalizes URL, drops stale", async () => {
  const config = { date: TODAY, cacheDir: "/tmp/nonexistent-cache-dir-xyz" };
  const sources = await fetchArxivDaily(config, {
    runFetch: async () => ({ text: ARXIV_SAMPLE }),
    limit: 5,
  });
  assert.ok(sources.length >= 1);
  const paper = sources.find((s) => s.title.includes("CreativeInstruct"));
  assert.ok(paper);
  assert.equal(paper.provider, "arxiv");
  assert.equal(paper.url, "https://arxiv.org/abs/2608.10001");
  assert.ok(!sources.some((s) => s.title.includes("Stale")), "stale paper dropped");
});

test("arXiv: fetch failure -> [] (never throws)", async () => {
  const config = { date: TODAY };
  const out = await fetchArxivDaily(config, {
    runFetch: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(out, []);
});

// --- aggregate ---

test("fetchAllDailySources: combines sources, per-source failure isolated", async () => {
  const original = globalThis.fetch;
  const todaySec = Math.floor(Date.UTC(2026, 7, 9, 20, 0, 0) / 1000);
  globalThis.fetch = async (url) => {
    if (url.includes("topstories")) {
      return {
        ok: true,
        json: async () => [1],
      };
    }
    if (url.includes("item/1.json")) {
      return {
        ok: true,
        json: async () => ({ title: "AI news", url: "https://x.com/1", type: "story", time: todaySec }),
      };
    }
    return { ok: true, json: async () => null };
  };
  const config = {
    date: TODAY,
    cacheDir: "/tmp/nonexistent-cache-dir-xyz",
    hnDailyEnabled: true,
    hnDailyLimit: 5,
    kr36DailyEnabled: false,
    kr36DailyLimit: 5,
    arxivDailyEnabled: true,
    arxivDailyLimit: 5,
    openaiDailyEnabled: true,
    openaiDailyLimit: 4,
    hfDailyEnabled: true,
    hfDailyLimit: 4,
  };
  try {
    const out = await fetchAllDailySources(config);
    // HN yields 1; 36kr + arXiv fail (their runFetch throws) → isolated as [].
    assert.ok(out.length >= 1);
    assert.ok(out.every((s) => s.url && s.title));
  } finally {
    globalThis.fetch = original;
  }
});
// ---- 2026-09-26 review: EFFECT-level regressions ----
// The suite previously asserted the SHAPE of the collectors (returns an array, a
// source has a url) rather than what actually landed. Four silent production
// regressions passed it: the vendor cache-key collision, the always-true AI
// filter, the unwired limits, and the invisible hard-source outage.

// P1: HuggingFace, blog.google and research.google all resolved to ONE
// `<date>-hf-feed.txt` because the cache key was inferred with
// `url.includes("openai") ? "openai" : "hf"`. The three run concurrently, so the
// last writer won and the others were re-read from a cache that no longer held
// them — 12 consecutive days of -hf-feed.txt on disk contained Google bodies.
test("fetchOfficialBlogRss: two vendors write DIFFERENT cache files", async () => {
  const seen = [];
  const runFetch = async (url, config, opts) => {
    seen.push(opts.cacheFile);
    return { text: FEED_XML };
  };
  const config = { date: TODAY, cacheDir: "/cache" };
  await fetchOfficialBlogRss("https://huggingface.co/blog/feed.xml", config, {
    site: "hf", runFetch,
  });
  await fetchOfficialBlogRss("https://blog.google/technology/ai/rss", config, {
    site: "google-ai", runFetch,
  });
  await fetchOfficialBlogRss("https://research.google/blog/rss", config, {
    site: "google-research", runFetch,
  });
  assert.equal(new Set(seen).size, 3, "three sources, three distinct cache files");
  assert.deepEqual(seen, [
    "/cache/2026-08-10-hf-feed.txt",
    "/cache/2026-08-10-google-ai-feed.txt",
    "/cache/2026-08-10-google-research-feed.txt",
  ]);
});

test("fetchOfficialBlogRss: site is required, so the key can never be inferred again", async () => {
  await assert.rejects(
    () => fetchOfficialBlogRss("https://huggingface.co/blog/feed.xml", { date: TODAY, cacheDir: "/c" }),
    /必须显式传入 site/,
    "a missing site is a loud error, not a silent collision",
  );
});

test("fetchOpenaiDaily / fetchHfDaily / Google: provider labels match their own feed", async () => {
  const runFetch = async () => ({ text: FEED_XML });
  const config = { date: TODAY, cacheDir: "/cache" };
  const openai = await fetchOpenaiDaily(config, { runFetch });
  const hf = await fetchHfDaily(config, { runFetch });
  const gAi = await fetchGoogleAiDaily(config, { runFetch });
  const gRes = await fetchGoogleResearchDaily(config, { runFetch });
  assert.equal(openai[0].provider, "openai-blog");
  assert.equal(hf[0].provider, "hf-blog");
  assert.equal(gAi[0].provider, "google-ai-blog");
  assert.equal(gRes[0].provider, "google-research-blog");
});

// P1: the AI-relevance filter's first alternative was a bare, unanchored `ai`,
// which matched inside "email", "maintain", "available", "domain", "Rainbow" —
// so it was effectively always true and HN contributed its first N stories
// regardless of subject.
test("isAiRelevant (via fetchHackerNewsDaily): unrelated HN stories are filtered OUT", async () => {
  const NON_AI = [
    "Show HN: A tiny email client",
    "Kubernetes 1.34 available now",
    "Domain modeling in Rust",
    "Understanding the daily newsletter",
    "The html spec turns 30",
    "Rainbow table attack explained",
    "A thread about mainframes",
  ];
  const out = await hnHarness(
    NON_AI.map((title, i) => ({
      title,
      url: `https://example.com/${i}`,
      type: "story",
      time: Math.floor(Date.now() / 1000),
    })),
    { limit: 12 },
  );
  assert.equal(out.length, 0, `no non-AI story may pass, got: ${out.map((s) => s.title)}`);
});

test("isAiRelevant: genuinely AI stories still pass", async () => {
  const AI = [
    "OpenAI releases a new model",
    "Anthropic ships Claude for agents",
    "大模型推理成本大幅下降",
    "Show HN: a tiny llm runtime",
  ];
  const out = await hnHarness(
    AI.map((title, i) => ({
      title,
      url: `https://example.com/${i}`,
      type: "story",
      time: Math.floor(Date.now() / 1000),
    })),
    { limit: 12 },
  );
  assert.equal(out.length, AI.length, `all AI stories pass, got: ${out.map((s) => s.title)}`);
});

// P2: the six `*DailyLimit` keys were read and validated but never passed to any
// fetcher, so every one fell back to its own hardcoded default.
test("fetchAllDailySources: the config limits actually reach the fetchers", async () => {
  const titles = Array.from({ length: 10 }, (_, i) => ({
    title: `OpenAI model update ${i}`,
    url: `https://example.com/${i}`,
    type: "story",
    time: Math.floor(Date.now() / 1000),
  }));
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("topstories")) {
      return { ok: true, json: async () => titles.map((_, i) => i + 1) };
    }
    const id = Number(url.match(/item\/(\d+)\.json/)?.[1] || 0);
    return { ok: true, json: async () => titles[id - 1] };
  };
  try {
    const out = await fetchAllDailySources({
      date: TODAY,
      cacheDir: "/tmp/nonexistent-cache-dir-xyz",
      hnDailyEnabled: true,
      hnDailyLimit: 2, // <- the knob under test
      kr36DailyEnabled: false,
      arxivDailyEnabled: false,
      openaiDailyEnabled: false,
      hfDailyEnabled: false,
      googleAiDailyEnabled: false,
      googleResearchDailyEnabled: false,
    });
    assert.equal(out.length, 2, `HN_DAILY_LIMIT=2 must yield 2, got ${out.length}`);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchAllDailySources: aggregateDailySourceLimit caps the merged pool", async () => {
  const titles = Array.from({ length: 10 }, (_, i) => ({
    title: `OpenAI model update ${i}`,
    url: `https://example.com/${i}`,
    type: "story",
    time: Math.floor(Date.now() / 1000),
  }));
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("topstories")) {
      return { ok: true, json: async () => titles.map((_, i) => i + 1) };
    }
    const id = Number(url.match(/item\/(\d+)\.json/)?.[1] || 0);
    return { ok: true, json: async () => titles[id - 1] };
  };
  try {
    const out = await fetchAllDailySources({
      date: TODAY,
      cacheDir: "/tmp/nonexistent-cache-dir-xyz",
      hnDailyEnabled: true,
      hnDailyLimit: 10,
      aggregateDailySourceLimit: 3,
      kr36DailyEnabled: false,
      arxivDailyEnabled: false,
      openaiDailyEnabled: false,
      hfDailyEnabled: false,
      googleAiDailyEnabled: false,
      googleResearchDailyEnabled: false,
    });
    assert.equal(out.length, 3, "the aggregate cap is applied to the merged result");
  } finally {
    globalThis.fetch = original;
  }
});

// P2: every fetcher swallowed its own error and returned [], so a full outage of
// the same-day hard sources printed a clean ✅. The diagnostics are non-enumerable
// so the array still behaves like a plain list.
test("fetchAllDailySources: a hard-source outage is reported, not silent", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error("network down"), { code: "ECONNRESET" });
  };
  try {
    const out = await fetchAllDailySources({
      date: TODAY,
      cacheDir: "/tmp/nonexistent-cache-dir-xyz",
      hnDailyEnabled: true,
      hnDailyLimit: 5,
      kr36DailyEnabled: false,
      arxivDailyEnabled: false,
      openaiDailyEnabled: false,
      hfDailyEnabled: false,
      googleAiDailyEnabled: false,
      googleResearchDailyEnabled: false,
    });
    assert.equal(out.length, 0, "no sources, as expected during an outage");
    const diag = out.dailyDiagnostics;
    assert.ok(diag, "diagnostics are attached to the returned array");
    assert.ok(diag.hackernews, `the failing provider is named, got ${JSON.stringify(diag)}`);
    assert.deepEqual(Object.keys(out), [], "diagnostics stay non-enumerable");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchAllDailySources: a healthy run carries no diagnostics", async () => {
  const out = await fetchAllDailySources({
    date: TODAY,
    cacheDir: "/tmp/nonexistent-cache-dir-xyz",
    hnDailyEnabled: false,
    kr36DailyEnabled: false,
    arxivDailyEnabled: false,
    openaiDailyEnabled: false,
    hfDailyEnabled: false,
    googleAiDailyEnabled: false,
    googleResearchDailyEnabled: false,
    // 2026-09-28 H2: the source set grew; this test enumerates all of them, so
    // the four new daily aggregators must be named here too or they run
    // unconfigured against a real network and report a spurious failure.
    techcrunchAiEnabled: false,
    vergeAiEnabled: false,
    qbitaiEnabled: false,
    infoqCnEnabled: false,
  });
  assert.equal(out.dailyDiagnostics, undefined, "a clean run reports nothing");
});

// ---------------------------------------------------------------------------
// 2026-09-27 review (round 4) P2-2: the aggregate cap was a FLAT slice, so
// whole sources vanished.
//
// `parts.flat().slice(0, cap)` takes the first N in array order. With the
// shipped defaults (hn 5 + kr36 5 + arxiv 5 + openai 4 + hf 4 + googleAi 4 +
// googleResearch 4 = 31) against AGGREGATE_DAILY_SOURCE_LIMIT=15, the first
// three sources consume the entire budget and openai, huggingface and both
// Google feeds contribute NOTHING — on every run, silently. Each has its own
// enable switch and its own *_DAILY_LIMIT in .env, and an operator watching
// those feeds fail would see no error at all.
//
// The test above asserts only `out.length >= 1`, i.e. shape, not effect — the
// same class of assertion that let this ship.
// ---------------------------------------------------------------------------

// Unit for the interleave itself: the effect under test is the SHAPE of the
// capped pool, not each collector's HTTP behaviour (which these tests do not
// mock faithfully — an all-seven mock is a second, unrelated test suite).
function part(provider, n) {
  return Array.from({ length: n }, (_, i) => ({ provider, title: `${provider}-${i}`, url: `https://x/${provider}/${i}` }));
}

test("interleaveAndCap: a source never starves because an earlier one filled the budget", () => {
  // The shipped shape: 5+5+5+4+4+4+4 = 31 against the default cap of 15.
  const parts = [
    part("hn", 5), part("kr36", 5), part("arxiv", 5), part("openai", 4),
    part("hf", 4), part("googleAi", 4), part("googleResearch", 4),
  ];
  const out = interleaveAndCap(parts, 15);
  assert.equal(out.length, 15, "the cap itself must still hold");
  const byProvider = {};
  for (const s of out) byProvider[s.provider] = (byProvider[s.provider] || 0) + 1;
  assert.deepEqual(
    Object.keys(byProvider).sort(),
    ["arxiv", "googleAi", "googleResearch", "hf", "hn", "kr36", "openai"],
    `a whole source was starved by the flat slice: ${JSON.stringify(byProvider)}`,
  );
});

test("interleaveAndNormalisation: a short part does not waste a turn", () => {
  // A source that produced nothing must be skipped, not consume a slot — that is
  // the whole point of interleaving over even-share.
  const parts = [part("hn", 2), [], part("openai", 2), [], part("hf", 2)];
  const out = interleaveAndCap(parts, 10);
  assert.equal(out.length, 6, "everything from every non-empty part must survive");
  assert.deepEqual([...new Set(out.map((s) => s.provider))].sort(), ["hf", "hn", "openai"]);
});

test("interleaveAndCap: a single source larger than the cap still fills it", () => {
  const out = interleaveAndCap([part("hn", 30), part("openai", 2)], 15);
  assert.equal(out.length, 15);
  assert.equal(out[0].provider, "hn", "order within a source is preserved");
});

test("interleaveAndCap: a cap at or above the pool returns everything", () => {
  const parts = [part("hn", 2), part("openai", 2)];
  assert.equal(interleaveAndCap(parts, 4).length, 4);
  assert.equal(interleaveAndCap(parts, 99).length, 4);
});

// ---------------------------------------------------------------------------
// 2026-09-27 review C1: `recencyGraceDays` was DEAD CODE on both graced fetchers.
//
// Both sites filtered with a strict `publishedAt < todayStart -> continue` and
// only THEN attached `recencyGraceDays`, a field the downstream filterByRecency
// honours. Anything the grace was written to rescue had already been dropped, so
// the option silently did nothing and the comment describing it was false.
// Measured: a Beijing-yesterday official-blog post (grace 1) and a two-Beijing-
// days-ago arXiv paper (grace 2) both came back empty.
//
// The gate must be expressed in terms of the window this source is given.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

test("official blog RSS: a Beijing-yesterday post survives the declared 1-day grace", async () => {
  // A 09:00 Beijing run on 2026-09-27. The previous Beijing day began at
  // 2026-09-25T16:00Z, so a post published then is "yesterday" in the report's
  // own calendar — the case the grace of 1 exists for.
  const feed = `<?xml version="1.0"?><rss><channel><item>` +
    `<title>OpenAI ships a new model</title>` +
    `<link>https://openai.test/1</link>` +
    `<pubDate>${new Date("2026-09-25T20:00:00Z").toUTCString()}</pubDate>` +
    `</item></channel></rss>`;
  const out = await fetchOfficialBlogRss(
    "https://openai.test/feed",
    { cacheDir: null, date: "2026-09-27" },
    { site: "openai", runFetch: async () => ({ text: feed, fromCache: false, provider: "t" }) },
  );
  assert.equal(out.length, 1, "grace 1 must actually admit yesterday");
  assert.equal(out[0].recencyGraceDays, 1);
});

test("official blog RSS: a 3-day-old post is still excluded", async () => {
  // The contrast direction — widening the window must not let real staleness in.
  const feed = `<?xml version="1.0"?><rss><channel><item>` +
    `<title>Ancient OpenAI post</title>` +
    `<link>https://openai.test/2</link>` +
    `<pubDate>${new Date("2026-09-22T12:00:00Z").toUTCString()}</pubDate>` +
    `</item></channel></rss>`;
  const out = await fetchOfficialBlogRss(
    "https://openai.test/feed",
    { cacheDir: null, date: "2026-09-27" },
    { site: "openai", runFetch: async () => ({ text: feed, fromCache: false, provider: "t" }) },
  );
  assert.equal(out.length, 0);
});

test("arxiv: a two-Beijing-days-ago paper survives the declared 2-day grace", async () => {
  // A 09:00 Beijing run on 2026-09-27: the previous Beijing day began at
  // 2026-09-25T16:00Z, so an arXiv submit at 2026-09-25T20:00Z is one Beijing day
  // back and the declared grace of 2 must admit it.
  const atom = `<feed><entry><title>Attention study</title>` +
    `<id>http://arxiv.org/abs/2509.01234v1</id><summary>s</summary>` +
    `<published>2026-09-25T20:00:00Z</published></entry></feed>`;
  const out = await fetchArxivDaily(
    { cacheDir: null, date: "2026-09-27" },
    { runFetch: async () => ({ text: atom, fromCache: false, provider: "t" }) },
  );
  assert.equal(out.length, 1, "grace 2 must actually admit the previous Beijing day");
  assert.equal(out[0].recencyGraceDays, 2);
});

test("arxiv: a five-day-old paper is still excluded", async () => {
  const atom = `<feed><entry><title>Stale paper</title>` +
    `<id>http://arxiv.org/abs/2501.00001v1</id><summary>s</summary>` +
    `<published>2026-09-01T12:00:00Z</published></entry></feed>`;
  const out = await fetchArxivDaily(
    { cacheDir: null, date: "2026-09-27" },
    { runFetch: async () => ({ text: atom, fromCache: false, provider: "t" }) },
  );
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------------------
// 2026-09-28 review H1: a hard source that FETCHES but yields nothing after the
// recency window was reported as a healthy run.
//
//   // A feed that parsed fine but yielded nothing for today is a normal quiet
//   // day on these blogs — not a failure. Only transport/parse problems are
//   // reported.
//   return sources;                       // <- 0 items, no diagnostic
//
// That is true for ONE blog on a quiet day and false as an aggregate. Measured
// 2026-09-28: every hard source returned 0, `dailyDiagnostics` was null, and
// the report still printed "✅ 综合成功" on 9 sources of which 6 were forum
// chatter. The P2 fix caught transport failure; it left the far more common
// case — fetched fine, filtered to zero — completely silent.
//
// Both directions are asserted: a source that yields nothing is NAMED, and a
// source that yields something is not.
// ---------------------------------------------------------------------------

// A well-formed feed whose only item is 30 days old: it parses, then the
// recency window drops it. This is the exact shipped shape.
const STALE_RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>A real AI announcement</title><link>https://x.test/1</link>
<pubDate>${new Date(Date.parse("2026-09-28T00:00:00+08:00") - 30 * 86400000).toUTCString()}</pubDate>
<description>d</description></item></channel></rss>`;

const FRESH_RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>OpenAI ships a new model today</title><link>https://x.test/2</link>
<pubDate>${new Date(Date.parse("2026-09-28T00:00:00+08:00") - 3600000).toUTCString()}</pubDate>
<description>d</description></item></channel></rss>`;

// These two drive `fetchOfficialBlogRss` with an injected runFetch rather than
// mocking globalThis.fetch: the real runFetch shells out to
// `config.grokSearchDir/scripts/fetch.js`, so a fetch-level mock never reaches
// the RSS path and every source would report ERR_INVALID_ARG_TYPE — a test that
// passes for the wrong reason. (That is exactly how the first version of this
// test failed.)
test("H1: a hard source that fetches fine but filters to zero IS reported", async () => {
  const out = await fetchOfficialBlogRss(
    "https://openai.com/news/rss.xml",
    { date: "2026-09-28", cacheDir: null },
    { limit: 5, site: "openai", provider: "openai-blog", runFetch: async () => ({ text: STALE_RSS }) },
  );
  assert.equal(out.length, 0, "a 30-day-old story is not same-day material");
  const diag = out.dailyDiagnostics;
  assert.ok(diag, "a source that yielded nothing must carry diagnostics");
  assert.equal(diag.provider, "openai");
  assert.match(
    String(diag.failures[0].reason),
    /window|stale|no-fresh|empty/i,
    "the reason must say the window dropped it, not that it failed to fetch",
  );
});

test("H1: a hard source that yields items is NOT reported as starved", async () => {
  const out = await fetchOfficialBlogRss(
    "https://openai.com/news/rss.xml",
    { date: "2026-09-28", cacheDir: null },
    { limit: 5, site: "openai", provider: "openai-blog", runFetch: async () => ({ text: FRESH_RSS }) },
  );
  assert.equal(out.length, 1, "the fresh story must survive");
  assert.equal(
    out.dailyDiagnostics,
    undefined,
    `a source that produced a source card must stay silent, got ${JSON.stringify(out.dailyDiagnostics)}`,
  );
});

// ---------------------------------------------------------------------------
// 2026-09-28 review H2: the hard-source baseline was 5 feeds that all publish
// weekly-ish, so the "≥10 same-day sources" contract was never met.
//
// Measured 2026-09-28 against the live feeds: openai/hf/google-ai/
// google-research/arxiv each returned 0 items inside the window (newest
// openai post 45h old, newest arXiv paper 4 days old), while four feeds that
// publish DAILY were not connected at all:
//
//   techcrunch-ai  4 fresh items   verge-ai      3
//   qbitai         3 fresh items   infoq-cn      3
//
// These four are the new baseline. Each is a real vendor/aggregator feed, and
// two of them are Chinese-language, which matters for a Chinese daily.
// ---------------------------------------------------------------------------

const ATOM = (title, link, iso) => `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<title>${title}</title><link href="${link}"/><id>${link}</id>
<published>${iso}</published><updated>${iso}</updated>
<summary>sum</summary></entry></feed>`;

const HOUR_AGO = new Date(Date.parse("2026-09-28T00:00:00+08:00") - 3600000).toISOString();

test("H2: the TechCrunch AI feed yields same-day items", async () => {
  const out = await fetchTechcrunchAiDaily(
    { date: "2026-09-28", cacheDir: null },
    {
      limit: 5,
      runFetch: async () => ({
        text: ATOM("OpenAI pauses training of its most capable models", "https://tc.test/1", HOUR_AGO),
      }),
    },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "OpenAI pauses training of its most capable models");
  assert.equal(out[0].url, "https://tc.test/1");
  assert.equal(out[0].provider, "techcrunch-ai", "the provider label must name the real feed");
  assert.ok(out[0].publishedAt >= Date.parse("2026-09-28T00:00:00+08:00") - 86400000);
});

test("H2: the Verge AI feed yields same-day items", async () => {
  const out = await fetchVergeAiDaily(
    { date: "2026-09-28", cacheDir: null },
    {
      limit: 5,
      runFetch: async () => ({
        text: ATOM("Engram turns broken AI hallucinations into music", "https://verge.test/1", HOUR_AGO),
      }),
    },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].provider, "verge-ai");
  assert.equal(out[0].url, "https://verge.test/1");
});

test("H2: 量子位 (qbitai) yields same-day Chinese items", async () => {
  const out = await fetchQbitaiDaily(
    { date: "2026-09-28", cacheDir: null },
    {
      limit: 5,
      runFetch: async () => ({
        text: `<?xml version="1.0"?><rss version="2.0"><channel><item>
<title>又快又能打！匿名模型玉兔模型杀上双榜第一</title>
<link>https://www.qbitai.com/1</link>
<pubDate>${new Date(Date.parse("2026-09-28T00:00:00+08:00") - 7200000).toUTCString()}</pubDate>
<description>d</description></item></channel></rss>`,
      }),
    },
  );
  assert.equal(out.length, 1, "a Chinese feed must not be dropped for being CJK");
  assert.equal(out[0].provider, "qbitai");
  assert.match(out[0].title, /玉兔模型/);
});

test("H2: InfoQ 中文 yields same-day Chinese items", async () => {
  const out = await fetchInfoqCnDaily(
    { date: "2026-09-28", cacheDir: null },
    {
      limit: 5,
      runFetch: async () => ({
        text: `<?xml version="1.0"?><rss version="2.0"><channel><item>
<title>阿里巴巴开源 AI 辅助代码评审工具 OpenCodeReview</title>
<link>https://www.infoq.cn/1</link>
<pubDate>${new Date(Date.parse("2026-09-28T00:00:00+08:00") - 7200000).toUTCString()}</pubDate>
<description>d</description></item></channel></rss>`,
      }),
    },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].provider, "infoq-cn");
  assert.match(out[0].title, /OpenCodeReview/);
});

test("H2: a non-AI story on these feeds is filtered out", async () => {
  // TechCrunch's AI category still carries the occasional non-AI story; the
  // same relevance gate the vendor feeds use must apply, or the new baseline
  // imports the same padding the review is trying to remove.
  const out = await fetchTechcrunchAiDaily(
    { date: "2026-09-28", cacheDir: null },
    {
      limit: 5,
      runFetch: async () => ({
        text: ATOM("Best kitchen sink picks for 2026", "https://tc.test/9", HOUR_AGO),
      }),
    },
  );
  assert.equal(out.length, 0, "a story with no AI signal must not enter the baseline");
});

test("H2: an old story on these feeds is filtered out by the window", async () => {
  const old = new Date(Date.parse("2026-09-28T00:00:00+08:00") - 9 * 86400000).toISOString();
  const out = await fetchTechcrunchAiDaily(
    { date: "2026-09-28", cacheDir: null },
    { limit: 5, runFetch: async () => ({ text: ATOM("Old OpenAI story", "https://tc.test/8", old) }) },
  );
  assert.equal(out.length, 0, "a 9-day-old story is not same-day material");
});
