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
<title>Yesterday's Paper</title>
<id>http://arxiv.org/abs/2608.09999v1</id>
<summary>Old stuff.</summary>
<published>2026-08-09T02:00:00Z</published>
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
  assert.ok(!sources.some((s) => s.title.includes("Yesterday")), "stale paper dropped");
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
  });
  assert.equal(out.dailyDiagnostics, undefined, "a clean run reports nothing");
});
