// Pure Markdown rendering helpers. No I/O, easy to unit test.

export function frontMatter(fields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((s) => String(s).replace(/]/g, "\\]")).join(", ")}]`);
    else lines.push(`${k}: ${String(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

export function sourceCard(src) {
  if (!src) return "";
  const title = src.title || src.url || "（无标题）";
  const url = src.url || "";
  const snippet = src.snippet || "";
  const parts = [`- [${title}](${url})`];
  if (snippet) parts.push(`  > ${String(snippet).replace(/\n/g, "\n  > ")}`);
  return parts.join("\n");
}

export function sourceList(sources) {
  if (!sources || sources.length === 0) return "（暂无来源）";
  return sources.map(sourceCard).join("\n");
}

export function table(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(escapeCell).join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

function escapeCell(v) {
  if (v == null) return "";
  return String(v).replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
