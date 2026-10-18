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
  const byId = new Map([
    [c.url, { title: "帖子 9", attachments: [{}, {}, {}], embed: "![[2026-10-18/linuxdo-posts/9-post]]" }],
  ]);
  const out = renderLinuxDoPostAuxiliary([c], "2026-10-18", byId);
  assert.match(out, /^- 附件：3 个已下载$/m);
  assert.match(out, /<details><summary>展开完整帖子（帖子 9）<\/summary>/);
  assert.match(out, /!\[\[2026-10-18\/linuxdo-posts\/9-post\]\]/);
});

test("renderLinuxDoPostAuxiliary: a newline in the enriched title does not split the summary", () => {
  const c = card(9, "2026-10-17T10:00:00.000Z");
  const byId = new Map([
    [c.url, { title: "上半句\n下半句", attachments: [], embed: "![[2026-10-18/linuxdo-posts/9-post]]" }],
  ]);
  const out = renderLinuxDoPostAuxiliary([c], "2026-10-18", byId);
  assert.match(out, /^<details><summary>展开完整帖子（上半句 下半句）<\/summary>$/m);
});
