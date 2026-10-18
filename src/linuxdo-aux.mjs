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
export function renderLinuxDoPostAuxiliary(cards, date, postsById = new Map()) {
  const seen = new Set();
  const list = [];
  for (const c of Array.isArray(cards) ? cards : []) {
    const key = c?.url || c?.id;
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    list.push(c);
  }
  // Newest first; ties broken by id descending so the order never depends on the
  // order the fetch happened to return cards in.
  list.sort((a, b) => {
    const ta = Date.parse(a?.created_at) || 0;
    const tb = Date.parse(b?.created_at) || 0;
    if (tb !== ta) return tb - ta;
    return String(b?.id ?? "").localeCompare(String(a?.id ?? ""));
  });
  const newest = list
    .map((c) => c?.created_at)
    .filter(Boolean)
    .sort()
    .pop();

  const lines = [
    `# linux.do 前沿快讯 辅助资料 · ${date}`,
    "",
    `共 ${list.length} 条 linux.do 帖子（实时快照，按发布时间倒序${
      newest ? `；最新一条 ${newest}` : ""
    }；来源：https://linux.do/c/news/34）`,
    "",
  ];
  for (const c of list) {
    lines.push(`## ${c.title}`);
    lines.push(`- 链接：${c.url}`);
    if (c.created_at) lines.push(`- 时间：${c.created_at}`);
    if (c.excerpt) lines.push(`- 正文摘录：${c.excerpt}`);
    const rec = postsById.get(c.url) || postsById.get(c.id);
    if (rec?.attachments?.length) lines.push(`- 附件：${rec.attachments.length} 个已下载`);
    if (rec?.embed) {
      // The enriched post title can carry an embedded newline (seen 2026-10-18 on
      // the top card), which split the <summary> across two lines. Collapse it so
      // the summary is always one line.
      const summaryTitle = String(rec.title ?? "").replace(/\s*\n\s*/g, " ");
      lines.push("");
      lines.push(`<details><summary>展开完整帖子（${summaryTitle}）</summary>`);
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
