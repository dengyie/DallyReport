// Best-effort Chinese one-liners for the GitHub poster.
//
// The repository `description` is authored by whoever owns the repo, so it
// arrives in English. The previous poster pipeline handled that with a line in
// the image prompt — "把原始简介翻译成中文" — and the image model duly produced
// Chinese that was wrong at the glyph level: 网里巴巴规下 (阿里巴巴旗下),
// 榜原始文拜化 (原始文档转化), 知识开台 (知识库开放平台).
//
// A chat model translates Chinese correctly and costs a fraction of what the
// image call did, so the translation moves to where it can actually be done.
// The image model is no longer in this path at all; what remains is the small
// problem of doing it reliably.
//
// Failure policy: NEVER lose a description. A missing credential, a timeout, a
// malformed reply or a short reply all fall back to the original English text.
// An English one-liner on a Chinese poster is a cosmetic shortfall; a blank row
// or a thrown error that takes the whole poster down is not an acceptable
// trade for it.

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_INPUT_CHARS = 200;

// Same precedence the rest of the pipeline uses: a trimmed non-empty env value
// wins, anything else falls through. Credentials are read by NAME only and are
// never returned, logged, or written into any artefact.
function envOr(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

/**
 * Pull one line per input, keyed by position.
 *
 * The prompt numbers its inputs, so a numbered reply is placed by that number
 * rather than by order. This matters: a reply containing one junk line ("—",
 * a stray fence, an apology) would otherwise shift every later translation up
 * by one, and the poster would attribute description 3's Chinese to repository
 * 2 — a wrong fact in a document whose whole purpose is to be right. Numbered
 * lines are immune; an unnumbered reply falls back to positional order, which
 * is the best that can be done without the anchors.
 */
export function parseTranslationLines(text, expected) {
  const out = new Array(expected).fill(null);
  const lines = String(text || "")
    .replace(/```[a-z]*\n?/gi, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // A real translation carries at least one letter, digit or ideograph. The
  // obvious length>1 guard looked right and was not: it silently dropped every
  // one-character line (甲, 是, 无), which is a legitimate rendering of a short
  // description and which shifts every later line up by one.
  const usable = (l) => /[\u4e00-\u9fffA-Za-z0-9]/.test(l);
  let numbered = 0;
  const byNumber = [];
  for (const line of lines) {
    const m = line.match(/^(\d{1,3})[.、)]\s*(.+)$/);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (n >= 1 && n <= expected && usable(m[2].trim())) {
        byNumber[n - 1] = m[2].trim();
        numbered += 1;
      }
    }
  }
  if (numbered > 0) {
    for (let i = 0; i < expected; i += 1) if (byNumber[i]) out[i] = byNumber[i];
    return out;
  }
  const rest = lines.map((l) => l.replace(/^\d{1,3}[.、)]\s*/, "").trim()).filter(usable);
  rest.slice(0, expected).forEach((line, i) => {
    out[i] = line;
  });
  return out;
}

/**
 * Translate an array of short strings to Chinese, preserving order and length.
 * Never throws, never returns fewer entries than it was given.
 */
export async function translateToChinese(lines, { model, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl, deps = {} } = {}) {
  const input = (lines || []).map((s) => String(s ?? "").trim());
  const result = input.map((s) => s);
  const targets = input.map((s, i) => (s && /[\u4e00-\u9fff]/.test(s) ? -1 : i)).filter((i) => i >= 0);
  // Nothing to do: either empty, or every line is already Chinese.
  if (targets.length === 0) return result;

  const apiUrl = envOr("GROK_API_URL", null);
  const apiKey = envOr("GROK_API_KEY", null);
  if (!apiUrl || !apiKey) return result;

  const doFetch = fetchImpl || deps.defaultFetch;
  if (!doFetch) return result;

  const numbered = targets.map((i) => `${i + 1}. ${input[i].slice(0, MAX_INPUT_CHARS)}`).join("\n");
  const userContent = [
    `把下面 ${targets.length} 条英文项目简介逐条翻译成简体中文。`,
    "要求：每条一行，输出行数必须与输入条数完全相同，不要编号，不要添加解释，不要合并或拆分条目，保留其中的专有名词与技术名词（模型名、框架名等）原文。",
    "",
    numbered,
  ].join("\n");

  let text;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await doFetch(
        `${apiUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: model || envOr("GROK_MODEL", "gpt-5.6-luna"),
            messages: [
              { role: "system", content: "你是技术文档翻译，只输出译文，不输出任何其他内容。" },
              { role: "user", content: userContent },
            ],
            temperature: 0,
            max_tokens: 1200,
          }),
          signal: controller.signal,
        },
      );
      if (!resp || !resp.ok) return result;
      const json = await resp.json();
      text = json?.choices?.[0]?.message?.content;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Network error, abort, or a body we could not parse. The English original
    // is already in `result`; there is nothing to repair.
    return result;
  }

  const parsed = parseTranslationLines(text, targets.length);
  targets.forEach((idx, k) => {
    const candidate = parsed[k];
    // A "translation" that came back empty, or that is byte-identical to the
    // English we sent, is not a translation. Keeping the original is honest;
    // writing the candidate would just add noise.
    if (candidate && candidate !== input[idx]) result[idx] = candidate;
  });
  return result;
}

/** Map repo descriptions through translateToChinese, preserving the repos array. */
export async function localizeRepos(repos, opts = {}) {
  const list = repos || [];
  const descriptions = list.map((r) => r?.description || "");
  const translated = await translateToChinese(descriptions, opts);
  return list.map((r, i) => (translated[i] && translated[i] !== r?.description ? { ...r, description: translated[i] } : r));
}
