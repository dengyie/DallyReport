// Daily hard-source fetchers (HN / 36kr / arXiv) — parse & filter logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchHackerNewsDaily,
  fetch36krDaily,
  fetchArxivDaily,
  beijingMidnightMs,
  fetchAllDailySources,
} from "../src/sources-daily.mjs";

const TODAY = "2026-08-10";

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
    kr36DailyEnabled: true,
    kr36DailyLimit: 5,
    arxivDailyEnabled: true,
    arxivDailyLimit: 5,
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