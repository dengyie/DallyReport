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
  const rawUrl = sanitizeUrl(src.url);
  const rawTitle = src.title || src.url || "（无标题）";
  const title = escapeMarkdownText(rawTitle);
  const link = rawUrl ? `- [${title}](<${escapeUrl(rawUrl)}>)` : `- ${title}`;
  const snippet = escapeMarkdownText(src.snippet, { multiline: true });
  const parts = [link];
  if (snippet) parts.push(`  > ${snippet.replace(/\n/g, "\n  > ")}`);
  return parts.join("\n");
}

function cleanText(value, { multiline = false } = {}) {
  let text = String(value ?? "").replace(/\r/g, "");
  if (!multiline) text = text.replace(/[\n\r]+/g, " ");
  // Keep ordinary whitespace and line breaks, but never emit control characters.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

function escapeMarkdownText(value, options) {
  return cleanText(value, options).replace(/[\\`*_[\]<>#+.!|()-]/g, "\\$&");
}

function sanitizeUrl(value) {
  const raw = cleanText(value);
  if (!raw || /[\s\u0000-\u001f\u007f]/.test(raw)) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function escapeUrl(value) {
  return String(value).replace(/[\\<>]/g, "\\$&");
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
