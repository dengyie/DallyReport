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
  repairGluedHeadings,
  dedupeBullets,
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

// --- 2026-10-07 P2: glued heading repair + duplicate bullet dedup -------------
// The shipped AI-DeepSeek.md (2026-10-07) carried a heading marker welded onto
// a sentence ("...AI 算力服务## 今日焦点") and two verbatim-duplicated bullets
// under a restarted section. Both are the mechanical signature of a
// reasoning-model truncation; both must be repaired before the note ships.

test("repairGluedHeadings: a heading marker glued onto prose becomes its own line", () => {
  const input = "* **算力基础设施初创公司 Lambda**：AI 算力服务## 今日焦点";
  const out = repairGluedHeadings(input);
  assert.match(out, /AI 算力服务\n\n## 今日焦点/, "the heading is separated from the prose onto its own block");
  // The original malformation is gone: "服务" should not be immediately
  // followed by "##" on the same line.
  assert.doesNotMatch(
    out.split("\n")[0],
    /服务## 今日/,
    "the heading no longer shares a line with the prose",
  );
});

test("repairGluedHeadings: a heading already at line start is untouched", () => {
  const input = "## 今日焦点\n\n* **要点**：正文。";
  assert.equal(repairGluedHeadings(input), input);
});

test("repairGluedHeadings: a mid-word '##' without a space is not a heading", () => {
  // "C##" and "issue##" are identifiers, not heading markers — a `#` inside a
  // URL fragment or identifier must not be split into a heading.
  assert.equal(repairGluedHeadings("C## is a preprocessor"), "C## is a preprocessor");
  assert.equal(repairGluedHeadings("见 issue##123"), "见 issue##123");
});

test("repairGluedHeadings: empty/undefined pass through", () => {
  assert.equal(repairGluedHeadings(""), "");
  assert.equal(repairGluedHeadings(undefined), "");
});

test("dedupeBullets: verbatim duplicate bullets keep only the first", () => {
  const input = [
    "* **Sharing AI Progress in Mathematics** [8]",
    "* **OpenAI drops another batch** [12]",
    "* **Sharing AI Progress in Mathematics** [8]",
    "* **OpenAI drops another batch** [12]",
  ].join("\n");
  const out = dedupeBullets(input);
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, `expected 2 bullets, got ${lines.length}`);
  assert.equal(lines[0], "* **Sharing AI Progress in Mathematics** [8]");
  assert.equal(lines[1], "* **OpenAI drops another batch** [12]");
});

test("dedupeBullets: whitespace differences do not hide a duplicate", () => {
  // Two bullets differing only in internal whitespace collapse to the same key.
  const input = "* **标题**：甲  [1]。\n* **标题**：甲 [1]。";
  const out = dedupeBullets(input);
  assert.equal(out.split("\n").filter((l) => l.trim()).length, 1, "double-space vs single-space is the same bullet");
});

test("dedupeBullets: two bullets sharing a title but different bodies are kept", () => {
  const input = "* **标题**：甲 [1]。\n* **标题**：乙 [2]。";
  const out = dedupeBullets(input);
  assert.equal(out.split("\n").filter((l) => l.trim()).length, 2, "same title + different body is NOT a duplicate");
});

test("dedupeBullets: headings and blank lines are never dropped", () => {
  const input = ["## 今日焦点", "", "* **A**：甲 [1]。", "", "## 产品与模型更新", "", "* **A**：甲 [1]。"].join("\n");
  const out = dedupeBullets(input);
  assert.match(out, /## 今日焦点/, "heading survives");
  assert.match(out, /## 产品与模型更新/, "heading survives");
  const bullets = out.split("\n").filter((l) => /^\* /.test(l));
  assert.equal(bullets.length, 1, "the duplicate bullet is dropped");
});

test("dedupeBullets: the reference-list shape is not treated as a duplicate bullet", () => {
  const input = "- [3] [美国AI初创公司](<https://linux.do/t/topic/2987952>)\n- [4] [高通](<https://linux.do/t/topic/2987858>)";
  assert.equal(dedupeBullets(input), input);
});

test("dedupeBullets: non-bullet lines pass through", () => {
  const input = "普通段落。\n\n* **仅有一条**：甲 [1]。\n\n```\ncode\n```";
  assert.equal(dedupeBullets(input), input);
});

test("dedupeBullets: a duplicated WRAPPED bullet loses its continuation line too", () => {
  // 2026-10-30 P2, runtime-verified: the line-based key dropped the duplicate's
  // headline but left its body line behind as a stray paragraph — partial
  // duplicates still shipped on truncation days. The key is now the block.
  const md = [
    "- **同一事件**：正文内容完全一致 [1]。",
    "续行内容也是重复块的一部分 [1]。",
    "- **同一事件**：正文内容完全一致 [1]。",
    "续行内容也是重复块的一部分 [1]。",
  ].join("\n");
  const out = dedupeBullets(md);
  assert.equal(out.split("\n").filter((l) => l.trim()).length, 2, "the whole duplicate block goes, continuation included");
  assert.equal((out.match(/续行内容/g) || []).length, 1);
});

test("dedupeBullets: a heading directly after a bullet survives that bullet's dedupe", () => {
  // Deliberate divergence from topic-bullets' block model: a following heading
  // must NOT be folded into the bullet's block, or deduping the bullet would
  // swallow the heading with it.
  const md = "- **重复事件**：内容 [1]。\n续行 [1]。\n## 下一节\n- **重复事件**：内容 [1]。\n续行 [1]。";
  const out = dedupeBullets(md);
  assert.match(out, /## 下一节/, "a heading after a duplicate bullet is never dropped");
  assert.equal((out.match(/重复事件/g) || []).length, 1);
  assert.equal((out.match(/续行/g) || []).length, 1);
});

// --- multi-source citations [1, 2] / [22, 25] -----------------------------

test("splitOverMergedBullets: splits when a tacked clause carries multi-source citations", () => {
  const merged =
    "* **AI 基础设施动态**：某云厂商升级了集群架构 [1]。同时，另外两家开源机构联合发布了新权重 [2, 3]。";
  const out = splitOverMergedBullets(merged);
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, `expected 2 bullets, got ${lines.length}`);
  assert.match(lines[0], /^\* \*\*AI 基础设施动态\*\*：/);
  assert.match(lines[0], /\[1\]/);
  assert.match(lines[1], /另外两家开源机构联合发布了新权重/);
  assert.match(lines[1], /\[2, 3\]/);
});

test("countOverMergedBullets: multi-source citations [1, 2] count as multiple sources", () => {
  const doc = [
    "* **单源单标**：甲 [1]。",
    "* **双源单标**：甲 [1, 2]。",
    "* **双源双标**：甲 [1]。乙 [2]。",
    "* **跨段双标**：甲 [22, 25]。",
  ].join("\n");
  assert.equal(countOverMergedBullets(doc), 3, "bullets citing [1, 2], [1]...[2], and [22, 25] count as over-merged");
});

test("posterBullets: multi-source citations [1, 2] / [22, 25] are cleanly stripped", () => {
  const input = [
    "* **Anthropic 发布 Claude 3.7 [1]**：支持混合推理能力 [1, 2]。",
    "* 未命名要点也支持多引用 [22, 25]。",
  ].join("\n");
  const out = posterBullets(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "Anthropic 发布 Claude 3.7", "citation stripped from title");
  assert.equal(out[0].body, "支持混合推理能力。", "multi-citation stripped from titled body");
  assert.equal(out[1].body, "未命名要点也支持多引用。", "multi-citation stripped from plain body");
  for (const b of out) {
    assert.doesNotMatch(b.title + b.body, /\[\d+(?:\s*,\s*\d+)*\]/, "no citation remains");
  }
});
