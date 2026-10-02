// Topic grading for the 2026-09-29 daily.
//
// The shipped note handed 22 cards to one synthesis call. These fixtures are
// those cards, and the grades are fixed by Note/Infra/DallyReport 运维.md:
// a model is not allowed to vote. A, B are worth one investigator; C stays a
// community line; D never reaches the body.
//
// Grouping is also fixed there, and it is NOT "same URL". A CLUSTERS hit folds,
// then a vendor+product allow-list, then a normalized URL. An unknown vendor
// never folds and never gets an actor the titles did not name.

import { test } from "node:test";
import assert from "node:assert/strict";

import { topicize, gradeTopics, applyGradeCap } from "../src/topics.mjs";
import { dedupeAndNormalizeSources } from "../src/news-dedup.mjs";

const DAY = [
  card(1, "Qwen4内测：前端王朝了！？", "https://linux.do/t/topic/2959349", "linux.do"),
  card(2, "基于MIMO-V2.5微调的新国模Naive-N0.5-Flash", "https://linux.do/t/topic/2959292", "linux.do"),
  card(3, "OpenAI API 修复日志 | 2026-09-25 修复识图异常", "https://linux.do/t/topic/2959277", "linux.do", "2026-09-25"),
  card(5, "各位尊敬的 plus 会员用的什么模型", "https://www.v2ex.com/t/1245191", "v2ex"),
  card(6, "codex 回复的消息，文件改动卡片消失了", "https://www.v2ex.com/t/1245169", "v2ex"),
  card(7, "安卓充了 openai 的 plus，付款成功之后还是 free，该怎么办", "https://www.v2ex.com/t/1245136", "v2ex"),
  card(8, "World Labs Is Joining AMD", "https://www.worldlabs.ai/blog/amd-announcement", "worldlabs"),
  card(9, "The Lenfest Institute grows landmark program with expanded OpenAI support", "https://openai.com/index/lenfest-ai-collaborative-expansion", "openai"),
  card(10, "Holo4: powering generalist computer-use agents", "https://huggingface.co/blog/Hcompany/holo4", "huggingface"),
  card(11, "Watch the winning trailer from the Future Vision XPRIZE, The Gifted.", "https://blog.google/innovation-and-ai/technology/ai/winner-future-vision-xprize/", "google"),
  card(12, "Source: Inference provider Modal Labs closing in on $750M round at $15.75B valuation", "https://techcrunch.com/2026/09/28/source-inference-provider-modal-labs-closing-in-on-750m-round-at-15-75b-valuation/", "techcrunch"),
  card(14, "Imagination 发布 E 系列 GPU IP 新进展：一套架构支持图形、计算与AI", "https://www.infoq.cn/article/5Xfeqshw0hwfUD95JpWE", "infoq"),
  card(15, "Jeff – Jev-compatible 0.8B decision models, trained at home, ~30 ms", "https://github.com/firelex/jeff", "github"),
  card(17, "Shopify opens checkout to browser-based AI agents", "https://techcrunch.com/2026/09/28/shopify-opens-checkout-to-browser-based-ai-agents/", "techcrunch"),
  card(18, "AI is supercharging hacking, and your local hospitals and banks aren’t ready", "https://www.theverge.com/ai-artificial-intelligence/1001427/ai-is-supercharging-hacking-and-your-local-hospitals-and-banks-arent-ready", "theverge"),
  card(19, "MicroLLM Lab – Try 7 tiny LLM's in the browser", "https://stateofutopia.com/experiments/microllmlab/", "web"),
  card(20, "Basis completes a tax workbook 2x faster with GPT-6 Astra", "https://openai.com/index/basis-tax-workbook-with-astra", "openai"),
  card(21, "Nvidia launches new platform for reining in rogue AI agents", "https://techcrunch.com/2026/09/28/nvidia-launches-new-platform-for-reining-in-rogue-ai-agents/", "techcrunch"),
  card(22, "Florida seeks a ban on ChatGPT acting like a person", "https://www.theverge.com/ai-artificial-intelligence/1001527/chatgpt-florida-ban-first-person-human-attributes-kids", "theverge"),
];

function card(n, title, url, provider, publishedAt = null) {
  return { n, title, url, provider, publishedAt, snippet: title };
}

function graded(cards = DAY) {
  return gradeTopics(topicize(cards), { date: "2026-09-29", mode: "daily" });
}

function byTitle(topics, fragment) {
  const hit = topics.find((t) => t.title.includes(fragment) || t.cards.some((c) => c.title.includes(fragment)));
  assert.ok(hit, `no topic contains ${fragment}`);
  return hit;
}

test("2026-09-29: World Labs, Shopify, Nvidia and Modal are worth investigating", () => {
  const topics = graded();
  for (const fragment of ["World Labs", "Shopify", "Nvidia", "Modal"]) {
    const topic = byTitle(topics, fragment);
    assert.ok(topic.grade === "A" || topic.grade === "B", `${fragment} graded ${topic.grade}`);
  }
});

test("2026-09-29: Lenfest is B (partnership, one official source) and GPT-6 Astra is a product update", () => {
  const topics = graded();
  const lenfest = byTitle(topics, "Lenfest");
  assert.equal(lenfest.grade, "B", "expanded support is not a finished event");
  assert.equal(lenfest.eventKind, "partnership");
  const astra = byTitle(topics, "GPT-6 Astra");
  assert.ok(astra.grade === "A" || astra.grade === "B", `Astra graded ${astra.grade}`);
  assert.equal(astra.eventKind, "release");
  assert.ok(astra.actors.includes("OpenAI"), "the product names OpenAI even when the title does not");
});

test("2026-09-29: a single community complaint is C, not an investigation", () => {
  const topics = graded();
  for (const fragment of ["Qwen4", "文件改动卡片", "还是 free", "修复识图"]) {
    assert.equal(byTitle(topics, fragment).grade, "C", fragment);
  }
});

test("2026-09-29: a repo directory, a trailer and a usage poll are D", () => {
  const topics = graded();
  for (const fragment of ["Jeff", "MicroLLM", "trailer", "用的什么模型"]) {
    assert.equal(byTitle(topics, fragment).grade, "D", fragment);
  }
});

test("topicize: a CLUSTERS hit folds into one topic and keeps the rewritten title", () => {
  const folded = dedupeAndNormalizeSources([
    card(1, "重置了重置了！额度又满了", "https://linux.do/t/topic/1", "linux.do"),
    card(2, "ChatGPT 额度重置，Tibo 说明天还会再来一次", "https://linux.do/t/topic/2", "linux.do"),
  ]);
  const topics = topicize(folded);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].cards.length, 2);
  assert.equal(topics[0].title, "ChatGPT/Codex 额度重置");
  assert.ok(topics[0].actors.includes("OpenAI"));
});

test("topicize: vendor+product allow-list folds two URLs about the same product", () => {
  const topics = topicize([
    card(1, "Shopify 向浏览器智能体开放 checkout", "https://techcrunch.com/shopify-a", "techcrunch"),
    card(2, "Shopify checkout now accepts browser agents", "https://shopify.com/blog/checkout-agents", "shopify"),
  ]);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].cards.length, 2);
  assert.deepEqual(topics[0].actors, ["Shopify"]);
});

test("topicize: the same normalized URL is one topic, tracking params included", () => {
  const topics = topicize([
    card(1, "同一件事", "https://example.com/a?utm_source=rss", "infoq"),
    card(2, "同一件事的另一张卡", "https://example.com/a", "web"),
  ]);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].cards.length, 2);
});

test("topicize: an unknown vendor does not fold and is not given an actor", () => {
  const topics = topicize([
    card(1, "Cursor 发布新模型", "https://cursor.com/a", "cursor"),
    card(2, "Cursor 发布新模型的跟进", "https://techcrunch.com/cursor", "techcrunch"),
  ]);
  assert.equal(topics.length, 2);
  assert.deepEqual(topics[0].actors, []);
  assert.deepEqual(topics[1].actors, []);
});

test("topicize: two different events stay two topics even when both name a vendor", () => {
  const topics = topicize([
    card(1, "OpenAI 发布 GPT-6", "https://openai.com/a", "openai"),
    card(2, "OpenAI 扩大对研究所的支持", "https://openai.com/b", "openai"),
  ]);
  assert.equal(topics.length, 2);
});

test("grade: a press report hedged as a source is B, not A", () => {
  const [topic] = graded([
    card(1, "Source: Modal Labs closing in on a round", "https://techcrunch.com/x", "techcrunch"),
  ]);
  assert.equal(topic.grade, "B");
  assert.equal(topic.eventKind, "funding");
});

test("applyGradeCap: official before press, newer before older, more cards before fewer", () => {
  const seeded = [
    { id: "press-new", title: "press", provenance: "press", publishedAt: "2026-09-29", cards: [{}, {}], grade: "A" },
    { id: "official-old", title: "official old", provenance: "official", publishedAt: "2026-09-20", cards: [{}], grade: "A" },
    { id: "official-new-thin", title: "official new thin", provenance: "official", publishedAt: "2026-09-29", cards: [{}], grade: "A" },
    { id: "official-new-thick", title: "official new thick", provenance: "official", publishedAt: "2026-09-29", cards: [{}, {}, {}], grade: "A" },
    { id: "press-old", title: "press old", provenance: "press", publishedAt: "2026-09-01", cards: [{}, {}, {}, {}], grade: "B" },
  ];
  const { topics, capped } = applyGradeCap(seeded, { mode: "daily" });
  const kept = topics.filter((t) => t.grade === "A" || t.grade === "B").map((t) => t.id);
  kept.sort();
  const expected = ["official-new-thick", "official-new-thin", "official-old", "press-new"];
  expected.sort();
  assert.deepEqual(kept, expected);
  assert.deepEqual(capped.map((t) => t.id), ["press-old"]);
  assert.equal(capped[0].grade, "C");
  assert.equal(capped[0].capped, "topic-cap");
});

test("applyGradeCap: a daily of the 2026-09-29 A/B set keeps four, including Astra", () => {
  const fragments = ["Shopify", "Nvidia", "World Labs", "Modal", "Lenfest", "GPT-6 Astra"];
  const seeded = fragments.map((fragment) => byTitle(graded(), fragment));
  assert.equal(seeded.filter((t) => t.grade === "A" || t.grade === "B").length, 6);
  const { topics, capped } = applyGradeCap(seeded, { mode: "daily" });
  const investigating = topics.filter((t) => t.grade === "A" || t.grade === "B");
  assert.equal(investigating.length, 4);
  assert.equal(capped.length, 2);
  assert.ok(capped.every((t) => t.grade === "C" && t.capped === "topic-cap"));
});

test("applyGradeCap: a weekly keeps eight", () => {
  const seeded = Array.from({ length: 9 }, (_, i) => ({
    id: `t${i}`,
    title: `Vendor${i} launches a model`,
    provenance: "press",
    publishedAt: `2026-09-${String(20 + (i % 9)).padStart(2, "0")}`,
    cards: [{ title: `Vendor${i} launches a model` }],
    grade: "A",
  }));
  const { topics } = applyGradeCap(seeded, { mode: "weekly" });
  assert.equal(topics.filter((t) => t.grade === "A").length, 8);
});
