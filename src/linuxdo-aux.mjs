// The linux.do 辅助资料 (auxiliary archive) renderer.
//
// Extracted from run.mjs so it is unit-testable: run.mjs self-executes, so a test
// cannot import the renderer from there without running the whole pipeline.
//
// 2026-10-18: this file is a SNAPSHOT of the live news/34 feed taken at run time —
// it is not a fixed "day's posts" set. The header used to claim 当天帖子, which
// made a re-run's archive look like it contradicted the report it accompanies:
// two runs hours apart legitimately archive different windows (the feed gains
// posts in between), and the published AI.md cites no linux.do source, so nothing
// dangles — but the claim was simply wrong, and it is what made the pair look
// inconsistent. The header now states what the file actually is, and the list is
// deduped by id/url and sorted newest-first so the same card set always renders
// byte-identically.
// Numeric sort key for a card id. Non-numeric / missing ids sort last (a card
// with a real id outranks one without). Number() rather than parseInt so "1e3"
// and "  12 " behave like the values they denote.
function idValue(card) {
  const n = Number(card?.id);
  return Number.isFinite(n) ? n : -1;
}

// A scraped title/excerpt is a single-line field; collapse any whitespace run
// around an embedded newline to one space.
function oneLine(s) {
  return String(s ?? "").replace(/\s*\n\s*/g, " ");
}

export function renderLinuxDoPostAuxiliary(cards, date, postsByUrl = new Map()) {
  const seen = new Set();
  const list = [];
  for (const c of Array.isArray(cards) ? cards : []) {
    const key = c?.url || c?.id;
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    list.push(c);
  }
  // Newest first; ties broken by id DESCENDING NUMERICALLY so the order never
  // depends on the order the fetch happened to return cards in. A numeric compare,
  // not localeCompare on the string forms: localeCompare is locale-dependent and
  // collates "999" after "3038853".
  list.sort((a, b) => {
    const ta = Date.parse(a?.created_at) || 0;
    const tb = Date.parse(b?.created_at) || 0;
    if (tb !== ta) return tb - ta;
    const byId = idValue(b) - idValue(a);
    if (byId !== 0) return byId;
    // Final tie-break so the comparator is a TOTAL order and can never fall back
    // to the fetch order: two cards sharing a timestamp AND an id value (both
    // missing, or both non-numeric) would otherwise render in whatever order the
    // fetch returned them, and the file would stop being reproducible from its own
    // card set. Ordered by the dedupe key for determinism only — it means nothing.
    // Compared with < / >, not localeCompare, for the reason above.
    const ka = String(a?.url ?? a?.id ?? "");
    const kb = String(b?.url ?? b?.id ?? "");
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  // list is sorted, so the newest stamp is the first card that carries one. (A
  // lexicographic max over the raw strings also worked for ISO-UTC, but it would
  // pick the wrong card for any other stamp format.)
  const newest = list.find((c) => c?.created_at)?.created_at || "";

  const lines = [
    `# linux.do 前沿快讯 辅助资料 · ${date}`,
    "",
    `共 ${list.length} 条 linux.do 帖子（实时快照，按发布时间倒序${
      newest ? `；最新一条 ${newest}` : ""
    }；来源：https://linux.do/c/news/34）`,
    "",
  ];
  for (const c of list) {
    // A scraped title or excerpt can carry an embedded newline (the 2026-10-18 top
    // card's title did, and the placeholder excerpt built from it kept the raw
    // "\n" even after enrichment gave the card a one-line title). A title and an
    // excerpt are single-line fields: a newline splits the "## heading" or the
    // "- 正文摘录：" list item in two, and it also made the published file
    // unreproducible from its own cards. Collapse any whitespace around a newline
    // to one space — the same treatment the <summary> title below already got.
    lines.push(`## ${oneLine(c.title)}`);
    lines.push(`- 链接：${c.url}`);
    if (c.created_at) lines.push(`- 时间：${c.created_at}`);
    if (c.excerpt) lines.push(`- 正文摘录：${oneLine(c.excerpt)}`);
    // Keyed by url: the only caller (run.mjs) builds this map from the enriched
    // posts' own `url`, which is copied verbatim from the card. The old
    // `|| postsByUrl.get(c.id)` fallback could never fire and its parameter name
    // (postsById) described a key nothing ever used.
    const rec = postsByUrl.get(c.url);
    if (rec?.attachments?.length) lines.push(`- 附件：${rec.attachments.length} 个已下载`);
    if (rec?.embed) {
      lines.push("");
      lines.push(`<details><summary>展开完整帖子（${oneLine(rec.title)}）</summary>`);
      lines.push("");
      lines.push(rec.embed);
      lines.push("");
      lines.push(`</details>`);
      lines.push("");
      continue;
    }
    lines.push("");
  }
  return lines.join("\n");
}
