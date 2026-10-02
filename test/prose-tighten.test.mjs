// Post-processing for the model-written body: de-clustering over-merged bullets
// and the poster-facing bullet extractor.
//
// Red-first, like every other fix in this pass. The 2026-09-28 review was not
// "the prose could be nicer" — it was four of ten shipped bullets citing two or
// three sources each because a category headline ("公司动态", "研究进展") stood
// in for a story, plus a `（score: 125）` that reached the poster because HN's
// snippet was the title echoed with a score appended. Those are countable.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitOverMergedBullets,
  countOverMergedBullets,
  posterBullets,
} from "../src/prose-tighten.mjs";

// --- the shipped shapes, verbatim in structure ---------------------------

const ANTHROPIC_MERGED =
  "* **Anthropic 创始人寻求投票控制权与公司动态**：为即将到来的首次公开募股（IPO）做准备，Anthropic 的创始人正在积极寻求公司的投票控制权 [19]。同时，该公司的一项关于基因编辑的研究引发讨论 [4]。此外，美国上诉法院维持了将 Anthropic 指定为供应链风险的裁决 [24]。";

const WELL_FORMED =
  "* **微软重组 Copilot 并调整个人 AI 聊天机器人战略**：微软通过重启 Copilot 放弃了个人 AI 聊天机器人的直接竞争赛道 [27]。";

test("splitOverMergedBullets: a three-source bullet becomes three bullets", () => {
  const out = splitOverMergedBullets(ANTHROPIC_MERGED);
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 3, `expected 3 bullets, got ${lines.length}: ${out}`);
  assert.match(lines[0], /^\* \*\*Anthropic 创始人寻求投票控制权与公司动态\*\*：/);
  assert.match(lines[0], /\[19\]/);
  assert.match(lines[1], /基因编辑/);
  assert.match(lines[1], /\[4\]/);
  assert.match(lines[2], /上诉法院/);
  assert.match(lines[2], /\[24\]/);
});

test("splitOverMergedBullets: no citation is lost or duplicated", () => {
  // The split moves text, it must never drop a source — the body and the
  // reference list are computed from the same string, and a citation that
  // vanished in post-processing would silently unlink the note.
  const before = [...ANTHROPIC_MERGED.matchAll(/(\[\d+\])/g)].map((m) => m[1]).sort();
  const after = [...splitOverMergedBullets(ANTHROPIC_MERGED).matchAll(/(\[\d+\])/g)].map((m) => m[1]).sort();
  assert.deepEqual(after, before);
});

test("splitOverMergedBullets: only the FIRST bullet keeps the headline", () => {
  // Inventing a title for the split-off parts by cutting the sentence at a
  // comma is exactly the machine-written prose this module exists to remove.
  // The follow-up parts stay untitled and read as context.
  const lines = splitOverMergedBullets(ANTHROPIC_MERGED).split("\n").filter(Boolean);
  assert.equal(lines.filter((l) => l.includes("**")).length, 1);
  assert.ok(!/\*\*[^*]+\*\*[：:]/.test(lines[1]), "no manufactured title on the follow-up");
});

test("splitOverMergedBullets: the connective is removed with the split", () => {
  const out = splitOverMergedBullets(ANTHROPIC_MERGED);
  assert.doesNotMatch(out, /同时，/, "同时 survives only if the clause was kept");
  assert.doesNotMatch(out, /此外，/);
});

test("splitOverMergedBullets: a single-source bullet is untouched", () => {
  assert.equal(splitOverMergedBullets(WELL_FORMED), WELL_FORMED);
});

test("splitOverMergedBullets: a tacked clause with no citation of its own is NOT split", () => {
  // Without its own source this is one claim continuing across a sentence, and
  // cutting it would strand half a thought in a bullet of its own.
  const merged = "* **标题**：前半句 [1]。同时，后半句是对同一件事的补充说明。";
  assert.equal(splitOverMergedBullets(merged), merged);
});

test("splitOverMergedBullets: a connective opening the bullet has nothing to separate", () => {
  const bullet = "* **标题**：此外，某公司发布了新模型 [7]。";
  assert.equal(splitOverMergedBullets(bullet), bullet);
});

test("splitOverMergedBullets: a mid-sentence connective does not split", () => {
  // 同时 inside a sentence is ordinary prose. Only a connective that lands
  // AFTER a terminator is the over-merge signature.
  const bullet = "* **标题**：模型同时支持中英文 [3]。";
  assert.equal(splitOverMergedBullets(bullet), bullet);
});

test("splitOverMergedBullets: paragraphs, headings and blank lines pass through", () => {
  const doc = [
    "## 本周焦点",
    "",
    WELL_FORMED,
    "",
    "---",
    "",
    "### 参考来源",
    "",
    "- [1] 某来源",
  ].join("\n");
  assert.equal(splitOverMergedBullets(doc), doc);
});

test("splitOverMergedBullets: non-bullet text is never touched", () => {
  for (const input of ["", "普通段落。", "* 无粗体标题的要点 [1]。", "```\ncode\n```"]) {
    assert.equal(splitOverMergedBullets(input), input);
  }
});

test("splitOverMergedBullets: a bullet with no body does not become empty", () => {
  const input = "* **只有标题**：\n* 下一条 [2]。";
  const out = splitOverMergedBullets(input);
  assert.ok(out.includes("* **只有标题**："), "the titled bullet is preserved verbatim");
});

// --- counting -------------------------------------------------------------

test("countOverMergedBullets: counts bullets citing more than one source", () => {
  const doc = [ANTHROPIC_MERGED, WELL_FORMED, "* **两条**：甲 [1]。乙 [2]。"].join("\n");
  assert.equal(countOverMergedBullets(doc), 2);
});

test("countOverMergedBullets: the shipped weekly shape is 4 of 10", () => {
  // The measured fact this module exists for. If the prompt fix (rule 12)
  // works, a future weekly should report a smaller number here.
  const doc = [
    ANTHROPIC_MERGED,
    WELL_FORMED,
    "* **两条 A**：甲 [1]。乙 [2]。",
    "* **三条 B**：甲 [1]。乙 [2]。丙 [3]。",
    "* **单条 C**：甲 [1]。",
    "* **单条 D**：甲 [2]。",
    "* **单条 E**：甲 [3]。",
    "* **单条 F**：甲 [4]。",
    "* **单条 G**：甲 [5]。",
    "* **单条 H**：甲 [6]。",
  ].join("\n");
  assert.equal(countOverMergedBullets(doc), 3, "Anthropic + the two- and three-source bullets");
});

// --- poster extraction ----------------------------------------------------

test("posterBullets: reads the titled form", () => {
  const out = posterBullets("* **标题**：正文内容 [4]。");
  // The returned field is `body`, not `summary`, and there is a `titled` flag:
  // an untitled bullet has no headline to keep, so the poster layer has to know
  // which shape it is holding before it can decide where the headline comes
  // from. Collapsing both into one field is what let a whole paragraph be
  // handed to the poster as a "title".
  assert.deepEqual(out, [{ titled: true, title: "标题", body: "正文内容。" }]);
});

test("posterBullets: an untitled follow-up bullet still reaches the poster", () => {
  // scripts/verify-poster.mjs rebuilds the poster from the note body, so if this
  // shape were skipped the verifier would under-report the stories the pipeline
  // actually renders — the check would silently cover less than it claims.
  const out = posterBullets(splitOverMergedBullets(ANTHROPIC_MERGED));
  assert.equal(out.length, 3, "all three parts must be poster-visible");
  assert.equal(out[0].title, "Anthropic 创始人寻求投票控制权与公司动态", "the headline is used as-is");
  assert.ok(out[1].body.startsWith("该公司的一项关于基因编辑"), `follow-up text is kept, got ${out[1].body}`);
  assert.ok(out[2].body.startsWith("美国上诉法院维持了"), `follow-up text is kept, got ${out[2].body}`);
  assert.deepEqual(
    out.map((b) => b.titled),
    [true, false, false],
    "only the bullet the model gave a headline to carries one"
  );
  for (const b of out) assert.doesNotMatch(b.title + b.body, /\[\d+\]/, "no source number is rendered as prose");
});

test("posterBullets: citation markers are stripped from the visible text", () => {
  const out = posterBullets("* **标题**：正文 [12]。");
  assert.doesNotMatch(out[0].body, /\[\d+\]/, "a source number is not prose");
});

test("posterBullets: the reference list is not mistaken for content", () => {
  const doc = ["* **正文要点**：真的内容 [1]。", "", "### 参考来源", "", "- [1] [A](<https://a.test>)"].join("\n");
  const out = posterBullets(doc);
  assert.equal(out.length, 1, "only the real bullet counts");
  assert.equal(out[0].title, "正文要点");
});
