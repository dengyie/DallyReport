import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  questionsFor,
  investigateOne,
  investigateTopics,
  renderInvestigationInput,
  loadTopicCache,
  saveTopicCache,
} from "../src/investigate.mjs";
import { investigateIfEnabled, assembleInvestigatedBody } from "../src/sections/ai-news.mjs";
import { enforceOneTopicPerBullet, localizeEnglishBullets, driftsFromTitle } from "../src/topic-bullets.mjs";
import { tmpDirSync } from "./helpers/tmp.mjs";

const topic = {
  id: "world-labs-amd",
  grade: "A",
  eventKind: "deal",
  title: "World Labs Is Joining AMD",
  provenance: "official",
  cards: [{ url: "https://www.worldlabs.ai/blog/amd-announcement", title: "World Labs Is Joining AMD" }],
};

test("questionsFor: a deal asks who bought, for how much, and whether it closed", () => {
  const fields = questionsFor("deal");
  assert.ok(fields.length <= 5);
  assert.ok(fields.includes("buyer"));
  assert.ok(fields.includes("seller"));
  assert.ok(fields.includes("amount"));
  assert.ok(fields.includes("status"));
});

test("investigateOne: an unsupported field stays unknown instead of being invented", async () => {
  const memo = await investigateOne(topic, {
    search: async (_query, { field }) => {
      if (field === "buyer") return [{ value: "AMD", url: topic.cards[0].url, official: true }];
      return [];
    },
  });
  assert.equal(memo.claims.length, 1);
  assert.equal(memo.claims[0].value, "AMD");
  assert.equal(memo.claims[0].confidence, "official");
  assert.ok(memo.unknowns.includes("amount"));
  assert.ok(memo.unknowns.includes("valuation"));
  assert.equal(memo.searches, 3, "the per-topic search cap is 3, not one search per question");
});

test("investigateOne: a new URL is appended to the source table before it can support a claim", async () => {
  const fresh = "https://www.amd.com/en/newsroom/world-labs";
  const memo = await investigateOne(topic, {
    search: async (_query, { field }) => {
      if (field !== "buyer") return [];
      return [{ value: "AMD", url: fresh, official: true, title: "AMD to acquire World Labs" }];
    },
  });
  assert.equal(memo.claims.length, 1);
  // A page the topic did not already have is one host. official:true on the
  // hit cannot promote it; only an existing official card can.
  assert.equal(memo.claims[0].confidence, "single");
  assert.deepEqual(memo.claims[0].support, [fresh]);
  assert.ok(memo.addedSources.some((s) => s.url === fresh), "the new page must join the source table");
});

test("investigateOne: two disagreeing values are a conflict, not a silent drop", async () => {
  const memo = await investigateOne(topic, {
    search: async (_query, { field }) => {
      if (field !== "amount") return [];
      return [
        { value: "$1B", url: "https://www.worldlabs.ai/blog/amd-announcement" },
        { value: "$2B", url: "https://techcrunch.com/world-labs-amd" },
      ];
    },
  });
  assert.equal(memo.claims.filter((c) => c.field === "amount").length, 0);
  assert.equal(memo.conflicts.length, 1);
  assert.equal(memo.conflicts[0].field, "amount");
  assert.deepEqual(new Set(memo.conflicts[0].values), new Set(["$1B", "$2B"]));
});

test("investigateOne: two independent hosts are reported; a flagged press URL is still single", async () => {
  const reported = await investigateOne(topic, {
    search: async (_query, { field }) => {
      if (field !== "buyer") return [];
      return [
        { value: "AMD", url: "https://www.worldlabs.ai/blog/amd-announcement" },
        { value: "AMD", url: "https://techcrunch.com/world-labs" },
      ];
    },
  });
  assert.equal(reported.claims[0].confidence, "reported");

  const flaggedPress = await investigateOne(topic, {
    search: async (_query, { field }) => {
      if (field !== "buyer") return [];
      return [{ value: "AMD", url: "https://techcrunch.com/world-labs", official: true }];
    },
  });
  assert.equal(flaggedPress.claims[0].confidence, "single");

  const sameHost = await investigateOne(topic, {
    search: async (_query, { field }) => {
      if (field !== "buyer") return [];
      return [
        { value: "AMD", url: "https://techcrunch.com/a" },
        { value: "AMD", url: "https://techcrunch.com/b" },
      ];
    },
  });
  assert.equal(sameHost.claims[0].confidence, "single");
});

test("investigateOne: empty search invents nothing", async () => {
  const memo = await investigateOne(topic, { search: async () => [] });
  assert.deepEqual(memo.claims, []);
  assert.deepEqual(memo.conflicts, []);
  assert.ok(memo.unknowns.length > 0);
});

test("investigateOne: a memo that is not an object is invalid JSON, not a budget miss", async () => {
  const memo = await investigateOne(topic, { search: async () => "not-json" });
  assert.equal(memo.demoted, "investigate-invalid-json");
  assert.deepEqual(memo.claims, []);
});

test("investigateTopics: a topic still running when the budget ends is demoted, not fatal", async () => {
  let clock = 0;
  const result = await investigateTopics(
    [topic, { ...topic, id: "second", grade: "B" }],
    {
      now: () => clock,
      search: async () => {
        clock += 7 * 60_000;
        return [];
      },
    },
  );
  assert.equal(result.stats.demoted, 2);
  assert.ok(result.topics.every((t) => t.grade === "C"));
  assert.equal(result.topics[0].demoted, "investigate-budget");
});

test("investigateTopics: C is not searched and D is not searched", async () => {
  const calls = [];
  await investigateTopics(
    [
      { ...topic, id: "c", grade: "C" },
      { ...topic, id: "d", grade: "D" },
    ],
    { search: async (_q, ctx) => { calls.push(ctx.topic.id); return []; } },
  );
  assert.deepEqual(calls, []);
});

test("topic cache: a thrown search is not frozen, and a refused write does not sink the next topic", async () => {
  const dir = tmpDirSync("dally-topics-retry-");
  let calls = 0;
  const flaky = { ...topic, id: "flaky" };
  const other = { ...topic, id: "other", cards: [{ url: "https://www.amd.com/news/world-labs", title: "AMD" }] };
  const first = await investigateTopics([flaky, other], {
    cacheDir: dir,
    date: "2026-09-29",
    search: async (_q, ctx) => {
      calls += 1;
      if (ctx.topic.id === "flaky") throw new Error("gateway down");
      return [{ value: "AMD", url: other.cards[0].url, official: true }];
    },
  });
  assert.equal(first.topics.find((t) => t.id === "flaky").memo.unknowns.includes("buyer"), true);
  const afterFailure = calls;
  const second = await investigateTopics([flaky], {
    cacheDir: dir,
    date: "2026-09-29",
    search: async () => {
      calls += 1;
      return [{ value: "AMD", url: flaky.cards[0].url }];
    },
  });
  assert.ok(calls > afterFailure, "a failed field must be searched again the same day");
  assert.equal(second.topics[0].memo.claims.some((c) => c.value === "AMD"), true);

  const poisoned = { ...topic, id: "poison" };
  const result = await investigateTopics([poisoned, other], {
    cacheDir: dir,
    date: "2026-09-29",
    search: async (_q, ctx) => {
      if (ctx.topic.id === "poison") {
        return [{ value: "AMD", url: poisoned.cards[0].url, title: "AMD", apiKey: "nope" }];
      }
      return [{ value: "AMD", url: other.cards[0].url }];
    },
  });
  assert.equal(result.topics.find((t) => t.id === "poison").demoted, "investigate-budget");
  assert.ok(result.topics.find((t) => t.id === "other").memo);
});

test("investigateTopics: a slow search is aborted by the topic budget even when the clock is not polled", async () => {
  let aborted = false;
  const result = await investigateTopics([topic], {
    limits: { topicMs: 20 },
    search: (_q, _ctx, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve([{ value: "AMD", url: topic.cards[0].url }]), 2_000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }),
  });
  assert.equal(aborted, true);
  assert.equal(result.topics[0].demoted, "investigate-budget");
  assert.equal(result.topics[0].grade, "C");
});

test("topic cache: same key is not searched twice, and the file holds no secret", async () => {
  const dir = tmpDirSync("dally-topics-");
  const key = { topicId: topic.id, url: topic.cards[0].url, date: "2026-09-29" };
  let calls = 0;
  const search = async () => {
    calls += 1;
    return [{ value: "AMD", url: topic.cards[0].url, official: true }];
  };
  const first = await investigateTopics([topic], { search, cacheDir: dir, date: "2026-09-29" });
  assert.equal(calls, 3);
  const cached = loadTopicCache(dir, "2026-09-29", key);
  assert.equal(cached.claims[0].value, "AMD");
  const raw = readFileSync(cached.file, "utf8");
  assert.doesNotMatch(raw, /GROK_API_KEY|sk-|Bearer /);
  const second = await investigateTopics([topic], { search, cacheDir: dir, date: "2026-09-29" });
  assert.equal(calls, 3, "a same-day rerun must not search again");
  assert.equal(second.topics[0].memo.claims[0].value, "AMD");
  assert.equal(first.stats.searches, 3);
  assert.equal(second.stats.searches, 0);
});

test("saveTopicCache refuses to persist a field named like a credential", () => {
  const dir = tmpDirSync("dally-topics-secret-");
  assert.throws(() => saveTopicCache(dir, "2026-09-29", {
    topicId: "x",
    url: "https://example.com/a",
    memo: { claims: [], apiKey: "should-not-land" },
  }));
});

test("investigateIfEnabled: off does not search and returns the cards unchanged", async () => {
  let calls = 0;
  const cards = [{ title: "Shopify opens checkout", url: "https://techcrunch.com/shopify", provider: "techcrunch" }];
  const result = await investigateIfEnabled(cards, { topicInvestigation: false, date: "2026-09-29" }, {
    search: async () => {
      calls += 1;
      return [];
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.sources, cards);
  assert.equal(result.preamble, "");
  assert.equal(result.topics?.length, 1, "off still groups by URL so a merged bullet can be split");
});

test("investigateIfEnabled: on keeps C, drops D, and a thrown search is not a clean success", async () => {
  const cards = [
    { title: "Shopify opens checkout to agents", url: "https://techcrunch.com/shopify", provider: "techcrunch" },
    { title: "Qwen4内测：前端王朝了！？", url: "https://linux.do/t/topic/1", provider: "linux.do" },
    { title: "MicroLLM Lab – Try 7 tiny LLM's in the browser", url: "https://stateofutopia.com/x", provider: "web" },
  ];
  const ok = await investigateIfEnabled(cards, { topicInvestigation: true, date: "2026-09-29", reportMode: "daily" }, {
    search: async () => [],
  });
  assert.equal(ok.sources.length, 2);
  assert.ok(ok.sources.some((s) => /Qwen4/.test(s.title)), "C stays in the synthesis input");
  assert.ok(!ok.sources.some((s) => /MicroLLM/.test(s.title)), "D leaves the body");
  assert.match(ok.preamble, /未知，禁止填写/);
  assert.match(ok.note, /topics:/);

  const failed = await investigateIfEnabled(cards, { topicInvestigation: true, date: "2026-09-29", reportMode: "daily" }, {
    search: async () => { throw new Error("gateway down"); },
    investigate: async () => { throw new Error("scheduler down"); },
  });
  assert.equal(failed.sources, cards);
  assert.match(failed.note, /主题调查失败/);
  assert.equal(failed.ok, false);
});

test("renderInvestigationInput: names unknowns and both sides of a conflict", () => {
  const text = renderInvestigationInput([
    {
      ...topic,
      memo: {
        claims: [{ field: "buyer", value: "AMD", support: [topic.cards[0].url], confidence: "single" }],
        unknowns: ["amount"],
        conflicts: [{ field: "valuation", values: ["$1B", "$2B"] }],
        searches: 1,
      },
    },
  ]);
  assert.match(text, /buyer: AMD/);
  assert.match(text, /仅一家来源/);
  assert.match(text, /未知，禁止填写: amount/);
  assert.match(text, /冲突/);
  assert.match(text, /\$1B/);
  assert.match(text, /\$2B/);
});

test("assembleInvestigatedBody: [1] stays the first card the model was shown, not the dropped D", () => {
  const shopify = { title: "Shopify opens checkout", url: "https://techcrunch.com/shopify", provider: "techcrunch" };
  const directory = { title: "MicroLLM Lab", url: "https://stateofutopia.com/x", provider: "web" };
  const qwen = { title: "Qwen4内测", url: "https://linux.do/t/1", provider: "linux.do" };
  const collected = [shopify, directory, qwen];
  const investigation = {
    sources: [shopify, qwen],
    topics: [
      { id: "shopify", grade: "A", cards: [shopify] },
      { id: "qwen", grade: "C", cards: [qwen] },
    ],
    droppedBullets: 0,
  };
  const body = "* **Shopify**：结账开放。[1]";
  const assembled = assembleInvestigatedBody({
    collected,
    investigation,
    body,
    date: "2026-09-29",
  });
  assert.match(assembled.ref, /\[1\].*techcrunch\.com\/shopify/);
  assert.doesNotMatch(assembled.ref, /stateofutopia/);
  assert.equal(assembled.posterSources[0].url, shopify.url);
  assert.equal(assembled.dailyCount, 0);
});

test("assembleInvestigatedBody: a newly appended URL is citable at its new index", () => {
  const shopify = { title: "Shopify opens checkout", url: "https://techcrunch.com/shopify" };
  const fresh = { title: "Shopify blog", url: "https://shopify.com/blog/agents", provider: "topic-investigation" };
  const investigation = {
    sources: [shopify, fresh],
    topics: [{ id: "shopify", grade: "A", cards: [shopify] }],
    droppedBullets: 0,
  };
  const assembled = assembleInvestigatedBody({
    collected: [shopify],
    investigation,
    body: "* **Shopify**：官方博客确认了范围。[2]",
    date: "2026-09-29",
  });
  assert.match(assembled.ref, /\[2\].*shopify\.com\/blog\/agents/);
});

test("investigateIfEnabled: a full daily cap is topic-cap, not a budget miss", async () => {
  const result = await investigateIfEnabled([
    { title: "Shopify opens checkout to agents", url: "https://techcrunch.com/s", provider: "techcrunch" },
    { title: "Nvidia launches a platform for rogue agents", url: "https://techcrunch.com/n", provider: "techcrunch" },
    { title: "World Labs Is Joining AMD", url: "https://www.worldlabs.ai/blog/amd", provider: "worldlabs" },
    { title: "Source: Modal Labs closing in on a round", url: "https://techcrunch.com/m", provider: "techcrunch" },
    { title: "The Lenfest Institute grows landmark program with expanded OpenAI support", url: "https://openai.com/lenfest", provider: "openai" },
    { title: "Florida seeks a ban on ChatGPT acting like a person", url: "https://www.theverge.com/florida", provider: "theverge" },
  ], {
    topicInvestigation: true,
    date: "2026-09-29",
    reportMode: "daily",
  }, { search: async () => [] });
  assert.match(result.note, /topic-cap: 2/);
  assert.doesNotMatch(result.note, /investigate-budget/);
  assert.match(result.note, /（A\d B\d C2 D0）/);
});

test("enforceOneTopicPerBullet: a multi-line bullet is one bullet, and the next one survives", async () => {
  const topics = [
    { id: "shopify", cards: [{ url: "https://techcrunch.com/shopify" }] },
    { id: "qwen", cards: [{ url: "https://linux.do/t/1" }] },
  ];
  const sources = [
    { url: "https://techcrunch.com/shopify" },
    { url: "https://linux.do/t/1" },
  ];
  const markdown = [
    "* **两件事**：Shopify 开放结账。",
    "  社区又在讨论 Qwen。[1, 2]",
    "* **只剩 Shopify**：结账范围限于浏览器。[1]",
  ].join("\n");
  let attempts = 0;
  const out = await enforceOneTopicPerBullet(markdown, {
    topics,
    sources,
    retry: async () => {
      attempts += 1;
      return "* **两件事**：还是两件事。[1, 2]";
    },
  });
  assert.equal(attempts, 1);
  assert.doesNotMatch(out, /两件事/);
  assert.match(out, /只剩 Shopify/);
});

test("enforceOneTopicPerBullet: a bullet citing two topics is retried once, then dropped", async () => {
  const topics = [
    { id: "shopify", cards: [{ url: "https://techcrunch.com/shopify" }] },
    { id: "qwen", cards: [{ url: "https://linux.do/t/1" }] },
  ];
  const sources = [
    { url: "https://techcrunch.com/shopify", title: "Shopify" },
    { url: "https://linux.do/t/1", title: "Qwen" },
    { url: "https://linux.do/t/2", title: "识图" },
    { url: "https://www.v2ex.com/t/3", title: "模型选择" },
  ];
  const merged = "* **四件事**：Qwen4 内测、识图修复、Plus 付款和模型选择被写进同一条。[1, 2, 3, 4]";
  let attempts = 0;
  const out = await enforceOneTopicPerBullet(merged, { topics, sources, retry: async () => {
    attempts += 1;
    return merged;
  } });
  assert.equal(attempts, 1);
  assert.equal(out.includes("[1, 2"), false);
  assert.doesNotMatch(out, /四件事/);
  assert.match(out, /\*\*Shopify\*\* \[1\]/);
  assert.match(out, /\*\*Qwen\*\* \[2\]/);
  assert.match(out, /\*\*识图\*\* \[3\]/);
  assert.match(out, /\*\*模型选择\*\* \[4\]/);
});

test("enforceOneTopicPerBullet: three different posts in one sentence are split, not kept as one discussion", async () => {
  const posts = [
    { id: "poll", title: "各位尊敬的 plus 会员用的什么模型", url: "https://www.v2ex.com/t/5" },
    { id: "card", title: "codex 回复的消息，文件改动卡片消失了", url: "https://www.v2ex.com/t/6" },
    { id: "pay", title: "安卓充了 openai 的 plus，付款成功之后还是 free", url: "https://www.v2ex.com/t/7" },
  ];
  const topics = posts.map((p) => ({ id: p.id, cards: [{ url: p.url, title: p.title }] }));
  const sources = [
    { url: "https://linux.do/t/1" },
    { url: "https://linux.do/t/2" },
    { url: "https://linux.do/t/3" },
    { url: "https://linux.do/t/4" },
    ...posts.map((p) => ({ url: p.url, title: p.title })),
  ];
  const merged = "* **社区用户近期围绕 Plus 会员所用模型、充值未到账以及文件改动卡片消失展开了交流** [5, 6, 7]";
  const out = await enforceOneTopicPerBullet(merged, { topics, sources });
  assert.equal(out.includes("[5, 6, 7]"), false);
  assert.doesNotMatch(out, /展开了交流/);
  for (const [i, post] of posts.entries()) {
    assert.match(out, new RegExp(`\\*\\*${post.title}\\*\\* \\[${i + 5}\\]`));
  }
});

test("enforceOneTopicPerBullet: a translated amount that matches the title stays, a shifted one is replaced", async () => {
  const sources = [
    { url: "https://www.theverge.com/amd", title: "AMD is acquiring AI company World Labs in a deal worth more than $8 billion" },
    { url: "https://techcrunch.com/modal", title: "Source: Modal Labs closing in on $750M round at $15.75B valuation" },
  ];
  const topics = sources.map((s, i) => ({ id: `t${i}`, cards: [s] }));
  const ok = await enforceOneTopicPerBullet(
    "* **AMD将以超过80亿美元的交易规模收购人工智能公司World Labs** [1]",
    { topics, sources },
  );
  assert.match(ok, /80亿美元/);
  const shifted = await enforceOneTopicPerBullet(
    "* **Modal Labs 的估值将达到 15.75 亿美元** [2]",
    { topics, sources },
  );
  assert.match(shifted, /\*\*Source: Modal Labs closing in on \$750M round at \$15\.75B valuation\*\* \[2\]/);
  assert.doesNotMatch(shifted, /15\.75 亿美元/);
});

test("enforceOneTopicPerBullet: a name or a Chinese fact the title does not contain is replaced by the title", async () => {
  const sources = [
    { url: "https://openai.com/lenfest", title: "The Lenfest Institute grows landmark program with expanded OpenAI support" },
    { url: "https://linux.do/t/sand", title: "窃贼为盗取英伟达人工智能芯片，却卷走了18吨沙子" },
  ];
  const topics = sources.map((s, i) => ({ id: `t${i}`, cards: [s] }));
  const named = await enforceOneTopicPerBullet(
    "* **Anthropic、OpenAI 及其他相关动态**：伦费斯特研究所扩大了项目 [1]",
    { topics, sources },
  );
  assert.match(named, /\*\*The Lenfest Institute grows landmark program with expanded OpenAI support\*\* \[1\]/);
  assert.doesNotMatch(named, /Anthropic/);
  const sand = await enforceOneTopicPerBullet(
    "* **有用户在社区中分享了一起涉及自动驾驶公司卡车与沙子搬运的奇特盗窃案** [2]",
    { topics, sources },
  );
  assert.match(sand, /\*\*窃贼为盗取英伟达人工智能芯片，却卷走了18吨沙子\*\* \[2\]/);
  assert.doesNotMatch(sand, /自动驾驶/);
});

test("enforceOneTopicPerBullet: investigation off still splits three different URLs", async () => {
  const posts = [
    { title: "各位尊敬的 plus 会员用的什么模型", url: "https://www.v2ex.com/t/5" },
    { title: "codex 回复的消息，文件改动卡片消失了", url: "https://www.v2ex.com/t/6" },
    { title: "安卓充了 openai 的 plus，付款成功之后还是 free", url: "https://www.v2ex.com/t/7" },
  ];
  const { topics } = await investigateIfEnabled(posts, { topicInvestigation: false, date: "2026-09-29" });
  const merged = "* **社区用户近期围绕 Plus 会员所用模型、充值未到账以及文件改动卡片消失展开了交流** [1, 2, 3]";
  const out = await enforceOneTopicPerBullet(merged, { topics, sources: posts });
  assert.equal(out.includes("[1, 2, 3]"), false);
  assert.doesNotMatch(out, /展开了交流/);
  for (const [i, post] of posts.entries()) {
    assert.match(out, new RegExp(`\\*\\*${post.title}\\*\\* \\[${i + 1}\\]`));
  }
});

test("enforceOneTopicPerBullet: citations that all belong to one topic stay", async () => {
  const topics = [
    { id: "shopify", cards: [{ url: "https://a.example/1" }, { url: "https://a.example/2" }] },
  ];
  const sources = [
    { url: "https://a.example/1" },
    { url: "https://a.example/2" },
  ];
  const body = "* **Shopify**：结账开放给浏览器智能体。[1, 2]";
  let attempts = 0;
  const out = await enforceOneTopicPerBullet(body, { topics, sources, retry: async () => { attempts += 1; return body; } });
  assert.equal(attempts, 0);
  assert.equal(out, body);
});

test("enforceOneTopicPerBullet: strips markdown markup and control characters from source titles", async () => {
  const sources = [
    { url: "https://v2ex.com/t/1", title: "**加粗标题** 与 [链接](https://foo.bar)\n新行" },
  ];
  const topics = [{ id: "t0", cards: [sources[0]] }];
  const out = await enforceOneTopicPerBullet(
    "* **偏离事实的假想标题**：内容 [1]",
    { topics, sources },
  );
  assert.equal(out.includes("**加粗标题**"), false);
  assert.equal(out.includes("[链接]"), false);
  assert.equal(out.includes("\n新行"), false);
  assert.match(out, /\* \*\*加粗标题 与 链接 新行\*\* \[1\]/);
});

test("driftsFromTitle: allows entity aliases and common tech vocabulary without false positive drift", () => {
  // Brand / alias matching
  const tFb = "Facebook will let you customize your feed algorithm using AI";
  const cFb = "Facebook 允许通过 AI 自定义信息流推荐算法：Meta 旗下 Facebook 宣布开启测试";
  assert.equal(driftsFromTitle(cFb, tFb), false);

  const tGem = "Gemini 4 Argon: Built to solve your hardest problems";
  const cGem = "谷歌发布 Gemini 4 Argon 前沿模型：Google 正式推出专为复杂推理打造的模型";
  assert.equal(driftsFromTitle(cGem, tGem), false);

  const tXbox = "Xbox is officially embracing the chaos of AI-powered game ports";
  const cXbox = "Xbox 官方探索基于 AI 的游戏逆向与移植：微软 Xbox 团队公布最新进展";
  assert.equal(driftsFromTitle(cXbox, tXbox), false);

  // Common technical abbreviations (GPU, LLM, API, CEO, etc.)
  const tCerebras = "Cerebras CEO says we’re nearing a future where everyone has a personal AI assistant at home";
  const cCerebras = "Cerebras CEO 称个人 AI 助手即将普及：芯片公司高管表示未来每个家庭都将拥有专属智能体，降低推理 GPU 成本";
  assert.equal(driftsFromTitle(cCerebras, tCerebras), false);

  // Genuine cross-entity hallucination must still be caught
  const tOpenAi = "The Lenfest Institute grows landmark program with expanded OpenAI support";
  const cAnthropic = "Anthropic、OpenAI 及其他相关动态：伦费斯特研究所扩大了项目";
  assert.equal(driftsFromTitle(cAnthropic, tOpenAi), true);

  // Natural Chinese expansion must not be rejected as drift
  const tScion = "Anthropic 五个月自研版本控制系统 Scion，全面替代 Git";
  const cScion = "Anthropic 自研版本控制系统 Scion 替代 Git：据社区讨论，Anthropic 用五个月时间自研了版本控制系统 Scion，并全面替代 Git";
  assert.equal(driftsFromTitle(cScion, tScion), false);

  const tMuse = "Meta 新模型杀回AI第一梯队，Alexandr Wang 亲述 Muse 7个月翻身内幕";
  const cMuse = "Meta 新模型杀回AI第一梯队：Alexandr Wang 亲述 Muse 7个月翻身内幕，详细回顾了研发过程";
  assert.equal(driftsFromTitle(cMuse, tMuse), false);
});

test("enforceOneTopicPerBullet: preserves natural Chinese translation for English source without bare title degradation", async () => {
  const sources = [
    { url: "https://theverge.com/fb", title: "Facebook will let you customize your feed algorithm using AI" },
  ];
  const topics = [{ id: "t0", cards: [sources[0]] }];
  const naturalBullet = "* **Facebook 允许使用 AI 自定义推荐算法**：Meta 旗下 Facebook 宣布允许用户通过 AI 自定义信息流 [1]";
  const out = await enforceOneTopicPerBullet(naturalBullet, { topics, sources });
  assert.equal(out, naturalBullet);
  assert.doesNotMatch(out, /will let you customize/);
});

test("localizeEnglishBullets: translates bare English bullets and preserves existing Chinese bullets and citations", async () => {
  const markdown = [
    "## 今日焦点",
    "* **Gemini 4 Argon: Built to solve your hardest problems** [12]",
    "* **Character.ai 申请破产保护**：互动 AI 平台正式启动重组程序 [35]",
    "* **Spotatui**：A Spotify TUI/GUI without web API rate limits [23]",
  ].join("\n");

  const mockTranslate = async (texts) => {
    return texts.map((t) => {
      if (t.includes("Gemini 4 Argon")) return "Gemini 4 Argon 发布：专为解决最棘手问题打造";
      if (t.includes("Spotify")) return "一款无 API 速率限制的 Spotify 终端界面客户端";
      return `【译】${t}`;
    });
  };

  const out = await localizeEnglishBullets(markdown, { translate: mockTranslate });

  // Untouched Chinese bullet
  assert.match(out, /\* \*\*Character\.ai 申请破产保护\*\*：互动 AI 平台正式启动重组程序 \[35\]/);

  // Translated bare English title
  assert.match(out, /\* \*\*Gemini 4 Argon 发布：专为解决最棘手问题打造\*\* \[12\]/);
  assert.doesNotMatch(out, /Built to solve your hardest problems/);

  // Translated brand title with English description
  assert.match(out, /\* \*\*Spotatui\*\*：一款无 API 速率限制的 Spotify 终端界面客户端 \[23\]/);
  assert.doesNotMatch(out, /without web API rate limits/);
});
