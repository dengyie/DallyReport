import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLinuxDoPostAuxiliary } from "../src/linuxdo-aux.mjs";

// 2026-10-18: the aux note is a snapshot of the LIVE news/34 feed, not a fixed
// "day's posts" set. The old header claimed 当天帖子, which made a re-run's archive
// look like it contradicted the report it accompanies — two runs hours apart
// archive different windows, and the published AI.md cites no linux.do source, so
// nothing dangles. The header must now say what the file is, and the list must be
// deterministic so the same card set always renders byte-identically.

const card = (id, iso) => ({
  id,
  url: `https://linux.do/t/topic/${id}`,
  title: `帖子 ${id}`,
  created_at: iso,
  excerpt: `摘录 ${id}`,
});

test("renderLinuxDoPostAuxiliary: header states a snapshot window, not a false 当天 claim", () => {
  const cards = [card(2, "2026-10-17T20:00:00.000Z"), card(1, "2026-10-17T10:00:00.000Z")];
  const out = renderLinuxDoPostAuxiliary(cards, "2026-10-18");
  assert.match(out, /^# linux\.do 前沿快讯 辅助资料 · 2026-10-18$/m);
  assert.match(out, /共 2 条 linux\.do 帖子（实时快照，按发布时间倒序；最新一条 2026-10-17T20:00:00\.000Z/);
  assert.doesNotMatch(out, /当天帖子/);
});

test("renderLinuxDoPostAuxiliary: newest-first order and byte-identical output for the same set", () => {
  const a = [card(1, "2026-10-17T10:00:00.000Z"), card(3, "2026-10-17T22:00:00.000Z"), card(2, "2026-10-17T20:00:00.000Z")];
  const b = [card(2, "2026-10-17T20:00:00.000Z"), card(1, "2026-10-17T10:00:00.000Z"), card(3, "2026-10-17T22:00:00.000Z")];
  const out = renderLinuxDoPostAuxiliary(a, "2026-10-18");
  assert.deepEqual(out, renderLinuxDoPostAuxiliary(b, "2026-10-18"));
  const order = [...out.matchAll(/^- 链接：https:\/\/linux\.do\/t\/topic\/(\d+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["3", "2", "1"]);
});

test("renderLinuxDoPostAuxiliary: a duplicate url is archived once", () => {
  const cards = [card(7, "2026-10-17T10:00:00.000Z"), card(7, "2026-10-17T10:00:00.000Z")];
  const out = renderLinuxDoPostAuxiliary(cards, "2026-10-18");
  assert.equal(out.match(/^## 帖子 7$/gm).length, 1);
  assert.match(out, /共 1 条 linux\.do 帖子/);
});

test("renderLinuxDoPostAuxiliary: attachment count and full-thread embed are kept", () => {
  const c = card(9, "2026-10-17T10:00:00.000Z");
  const byUrl = new Map([
    [c.url, { title: "帖子 9", attachments: [{}, {}, {}], embed: "![[2026-10-18/linuxdo-posts/9-post]]" }],
  ]);
  const out = renderLinuxDoPostAuxiliary([c], "2026-10-18", byUrl);
  assert.match(out, /^- 附件：3 个已下载$/m);
  assert.match(out, /<details><summary>展开完整帖子（帖子 9）<\/summary>/);
  assert.match(out, /!\[\[2026-10-18\/linuxdo-posts\/9-post\]\]/);
});

test("renderLinuxDoPostAuxiliary: a newline in the enriched title does not split the summary", () => {
  const c = card(9, "2026-10-17T10:00:00.000Z");
  const byUrl = new Map([
    [c.url, { title: "上半句\n下半句", attachments: [], embed: "![[2026-10-18/linuxdo-posts/9-post]]" }],
  ]);
  const out = renderLinuxDoPostAuxiliary([c], "2026-10-18", byUrl);
  assert.match(out, /^<details><summary>展开完整帖子（上半句 下半句）<\/summary>$/m);
});

test("renderLinuxDoPostAuxiliary: a newline in a card title/excerpt never splits the heading or the 摘录 line", () => {
  // 2026-10-18 top card: the JSON title carried a raw "\n", so the placeholder
  // excerpt built from it printed across two lines while the heading (rendered
  // from the enriched one-line title) did not — the published file could not be
  // reproduced from its own cards.
  const out = renderLinuxDoPostAuxiliary(
    [{ ...card(9, "2026-10-17T10:00:00.000Z"), title: "上半句\n下半句", excerpt: "linux.do 前沿讨论：上半句\n下半句" }],
    "2026-10-18",
  );
  assert.match(out, /^## 上半句 下半句$/m);
  assert.match(out, /^- 正文摘录：linux\.do 前沿讨论：上半句 下半句$/m);
  assert.equal(out.split("\n").filter((l) => l.startsWith("下半句")).length, 0);
});

test("renderLinuxDoPostAuxiliary: equal timestamps tie-break on the id NUMERICALLY", () => {
  // 999 vs 3038853: numeric desc says (3038853, 999), a localeCompare on the
  // string forms says the opposite ("9" collates after "3"), so this pins the
  // intent. The tie-break must also not depend on input order.
  const iso = "2026-10-17T10:00:00.000Z";
  const desc = (out) =>
    [...out.matchAll(/^- 链接：https:\/\/linux\.do\/t\/topic\/(\d+)$/gm)].map((m) => m[1]);
  const a = renderLinuxDoPostAuxiliary([card(999, iso), card(3038853, iso)], "2026-10-18");
  const b = renderLinuxDoPostAuxiliary([card(3038853, iso), card(999, iso)], "2026-10-18");
  assert.deepEqual(desc(a), ["3038853", "999"]);
  assert.equal(a, b);
});

test("renderLinuxDoPostAuxiliary: a card with no created_at sorts last and cannot become 最新", () => {
  const stamped = card(5, "2026-10-17T10:00:00.000Z");
  const unstamped = { id: 6, url: "https://linux.do/t/topic/6", title: "帖子 6", excerpt: "摘录 6" };
  const out = renderLinuxDoPostAuxiliary([unstamped, stamped], "2026-10-18");
  const order = [...out.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["帖子 5", "帖子 6"]);
  assert.match(out, /最新一条 2026-10-17T10:00:00\.000Z/);
  // Only the stamped card gets a 时间 line, and 帖子 6's line does not follow 帖子 5's.
  assert.equal(out.match(/^- 时间：/gm).length, 1);
});

test("renderLinuxDoPostAuxiliary: cards with neither a timestamp nor an id value still render in a fixed order", () => {
  // 2026-10-19 review R3: the comparator had only (time, id). Two cards sharing
  // both — no created_at AND no numeric id — compared equal, so Array.sort kept
  // the FETCH order and the file stopped being byte-reproducible from its own card
  // set, contradicting the invariant this renderer advertises. The dedupe key is
  // the final tie-break that makes the order total.
  const x = { url: "https://linux.do/t/topic/x", title: "X", excerpt: "ex" };
  const y = { url: "https://linux.do/t/topic/y", title: "Y", excerpt: "ey" };
  const forward = renderLinuxDoPostAuxiliary([x, y], "2026-10-19");
  const reverse = renderLinuxDoPostAuxiliary([y, x], "2026-10-19");
  assert.equal(forward, reverse);
  const order = [...forward.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["X", "Y"]);
});

test("renderLinuxDoPostAuxiliary: an empty list still states a truthful 0-count header", () => {
  const out = renderLinuxDoPostAuxiliary([], "2026-10-18");
  assert.match(out, /^# linux\.do 前沿快讯 辅助资料 · 2026-10-18$/m);
  assert.match(out, /共 0 条 linux\.do 帖子（实时快照，按发布时间倒序；来源：https:\/\/linux\.do\/c\/news\/34）$/m);
  assert.doesNotMatch(out, /最新一条/);
});
