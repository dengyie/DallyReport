import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAndNormalizeSources } from "../src/news-dedup.mjs";

// Real linux.do news/34 titles from 2026-08-09 — eight posts all about the same
// ChatGPT/Codex free-quota reset, with wildly different (and mostly not
// self-contained) titles. This is the exact shape the module exists to fold.
const RESET_TITLES = [
  "明天还会有一次重置",
  "重置了重置了！",
  "codex 周一还会重置！",
  "gpt今天重置了。周一还要重置。赶紧起床玩命的蹬。",
  "奥特曼又给重置了",
  "Codex重置了。",
  "Codex余额已重置，Tibo回应称明天周一会再次重置",
];

function card(title, snippet = "") {
  return { url: `https://linux.do/t/topic/${Math.random().toString(36).slice(2)}`, title, snippet };
}

test("dedupeAndNormalizeSources: 8 reset posts fold into one 'ChatGPT/Codex 额度重置' card", () => {
  const sources = RESET_TITLES.map((t) => card(t));
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 1, "all 8 reset posts collapse to a single card");
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置", "representative gets the clear rewritten title");
});

test("dedupeAndNormalizeSources: representative keeps the richest snippet", () => {
  const sources = [
    card("重置了重置了！", "短"),
    card("Codex余额已重置，Tibo回应称明天周一会再次重置", "这是最详细的一条正文，包含重置时间、Tibo 回应、资格到期提示等完整信息"),
    card("奥特曼又给重置了", "中"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
  assert.match(out[0].snippet, /最详细/, "keeps the member with the richest snippet");
});

test("dedupeAndNormalizeSources: non-reset sources pass through untouched, in order", () => {
  const sources = [
    card("OpenAI 收购 AI 演示文稿初创公司 NextSlide", "s1"),
    card("重置了重置了！", "s2"),
    card("宇树科技明天申购，发行价格为150.80元/股", "s3"),
    card("Codex重置了。", "s4"),
    card("苹果中国官网删除 Apple 智能接入阿里千问使用手册", "s5"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 4, "2 reset posts fold to 1, 3 non-reset stay");
  assert.equal(out[0].title, "OpenAI 收购 AI 演示文稿初创公司 NextSlide");
  assert.equal(out[1].title, "ChatGPT/Codex 额度重置", "representative sits at the first member's position");
  assert.equal(out[2].title, "宇树科技明天申购，发行价格为150.80元/股");
  assert.equal(out[3].title, "苹果中国官网删除 Apple 智能接入阿里千问使用手册");
});

test("dedupeAndNormalizeSources: a single reset post is still normalized", () => {
  const out = dedupeAndNormalizeSources([card("重置了重置了！", "8月9日中午 12点40 全部重置了")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
  assert.equal(out[0].snippet, "8月9日中午 12点40 全部重置了", "snippet preserved");
});

test("dedupeAndNormalizeSources: reset + password (different event) is NOT folded", () => {
  const sources = [
    card("重置了重置了！", "s1"),
    card("账号密码重置通知", "s2"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 2, "password-reset is a different event, stays separate");
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
  assert.equal(out[1].title, "账号密码重置通知");
});

test("dedupeAndNormalizeSources: empty / non-array input is safe", () => {
  assert.deepEqual(dedupeAndNormalizeSources([]), []);
  assert.deepEqual(dedupeAndNormalizeSources(undefined), []);
  assert.deepEqual(dedupeAndNormalizeSources(null), []);
});

test("dedupeAndNormalizeSources: does not mutate the input array", () => {
  const sources = [card("重置了重置了！", "s1"), card("OpenAI 收购 NextSlide", "s2")];
  const before = sources.map((s) => s.title);
  dedupeAndNormalizeSources(sources);
  assert.deepEqual(sources.map((s) => s.title), before, "input untouched");
});
