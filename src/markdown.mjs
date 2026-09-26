// Pure Markdown rendering helpers. No I/O, easy to unit test.

// Strip markdown formatting down to plain text. Scraped titles (notably v2ex
// listing extracts) sometimes arrive carrying markdown fragments — e.g.
// `标题](/t/123) **[user](/member/u)** • 34 mins ago` — which then leak into
// rendered link text as escaped `\]\(...\)` noise. Run titles through this
// BEFORE any markdown-escaping step.
export function stripMarkdown(s) {
  if (!s) return "";
  return String(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/\]\([^)]*\)/g, "") // orphan ](url) tails -> ""
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // **bold** / __bold__ -> bold
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function frontMatter(fields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    // YAML flow-sequence items are JSON-quoted so `[`, `]`, `,` and quotes inside
    // a tag can never break out of the flow sequence or inject extra items.
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((s) => JSON.stringify(String(s))).join(", ")}]`);
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

// Exported because the production reference renderer (ai-news.mjs `refLines`) is
// the one that actually ships links into the vault, and it was building them by
// hand with no URL validation at all. A scraped post's `url` is attacker-authored,
// so a `javascript:` href became a clickable link in the user's note. Keeping the
// sanitizer here — and routing BOTH renderers through it — is the whole point.
export function sanitizeUrl(value) {
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

export function escapeUrl(value) {
  return String(value).replace(/[\\<>]/g, "\\$&");
}

export function escapeMdText(value, options) {
  return escapeMarkdownText(value, options);
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
