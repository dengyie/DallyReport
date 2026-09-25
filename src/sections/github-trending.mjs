import path from "node:path";
import { runFetch } from "../grok-cli.mjs";
import { frontMatter, table } from "../markdown.mjs";

const TRENDING_URL = "https://github.com/trending?since=daily";
const TOP_N = 15;

// One concise line for the 简介 column: cut at the first *real* sentence
// terminator, then hard-cap length so the table stays compact (a trending
// description can be a long paragraph). A terminator only counts if it starts a
// new sentence (next word uppercased / quoted) or ends the line — a decimal
// point in a version ("3.11") or an abbreviation ("Node.js") is NOT a split
// point. The repo's own English tagline is shown verbatim (the poster already
// renders Chinese one-liners via image-gen); markdown-significant characters are
// escaped so a tagline can never restructure the table cell.
const TERMINATOR_RE = /^.*?[.!?。！？](?=\s+[A-Z0-9"'(（【]|$)/;
const CELL_ESCAPE_RE = /([\\`*_[\]])/g;
export function briefDescription(s) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(TERMINATOR_RE);
  const first = (m ? m[0] : t).trim();
  const capped = first.length > 100 ? first.slice(0, 99) + "…" : first;
  return capped.replace(CELL_ESCAPE_RE, "\\$1");
}

// Parses GitHub trending "direct" fetch text into structured rows.
// Block layout per repo (one token per line in the ``direct`` readable output):
//   owner /
//   name
//   description…
//   <language>
//   <totalStars>      ← e.g. "14,430"
//   <forks>           ← e.g. "3,903"
//   Built by
//   <NNN> stars today
// So an owner is a bare line, the next line is the name, total stars is the
// last bare number before "Built by", and "N stars today" closes the block.
const OWNER_LINE_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?)\s+\/$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const STARS_TODAY_RE = /^([\d,]+)\s+stars?\s+today$/i;
const BUILT_BY_RE = /^Built by\s*$/;
const NUM_RE = /^([\d,]{1,15})$/;
// The <language> line sits right after the description (or right after the
// name when there's no description). Usually a single token like "Python" /
// "C++", but a few real GitHub labels contain spaces ("Jupyter Notebook",
// "Visual Basic"). Those go in an explicit allowlist rather than a
// space-allowing pattern: a loose multi-word pattern would also match short
// two-word descriptions and steal them out of the description slot
// (descriptions are detected by the presence of whitespace, 2026-09-25
// Copilot review).
const LANGUAGE_RE = /^[A-Za-z][A-Za-z0-9+#.+-]{0,29}$/;
const MULTIWORD_LANGUAGES = new Set([
  "Jupyter Notebook",
  "Visual Basic",
  "Common Lisp",
  "Emacs Lisp",
  "AGS Script",
]);
export function isLanguageLabel(s) {
  return LANGUAGE_RE.test(s) || MULTIWORD_LANGUAGES.has(s);
}

export function parseTrending(text) {
  if (!text) return [];
  const lines = text.split("\n").map((l) => l.trim());
  const rows = [];
  let i = 0;
  let rec = null;
  // In a canonical block the two bare numbers are (totalStars, forks) in that
  // order. Track the recent bare numbers so "Built by" can attribute them — and
  // so a block with the WRONG count of numbers can be refused (see BUILT_BY).
  let prevNumbers = [];

  while (i < lines.length) {
    const line = lines[i];

    const ownerMatch = line.match(OWNER_LINE_RE);
    if (
      ownerMatch &&
      i + 1 < lines.length &&
      NAME_RE.test(lines[i + 1]) &&
      !STARS_TODAY_RE.test(lines[i + 1])
    ) {
      const owner = ownerMatch[1];
      const name = lines[i + 1];
      const key = `${owner}/${name}`;
      if (!rows.some((r) => r.repo === key)) {
        rec = { repo: key, owner, name, starsToday: null, starsTotal: null, forks: null, description: null, language: null };
        rows.push(rec);
      } else {
        rec = rows.find((r) => r.repo === key);
      }
      // Capture the one-line project description, which sits right under the name
      // (before the language line, if any). It's the first non-structural line:
      // not a bare number, not "Built by", not "N stars today", not an owner line,
      // and — critically — must contain whitespace. A repo with no description
      // puts its <language> line (a single token like "Python") right under the
      // name; a real description is a sentence. Requiring /\s/ keeps the language
      // from being mislabeled as the project's tagline on the poster. A repo with
      // no description simply has no such line; rec stays description: null.
      let descHere = false;
      if (rec.description == null && i + 2 < lines.length) {
        const cand = lines[i + 2];
        if (
          cand &&
          /\s/.test(cand) &&
          !isLanguageLabel(cand) &&
          !NUM_RE.test(cand) &&
          !BUILT_BY_RE.test(cand) &&
          !STARS_TODAY_RE.test(cand) &&
          !OWNER_LINE_RE.test(cand)
        ) {
          rec.description = cand;
          descHere = true;
        }
      }
      // Capture the <language> line: the single-token line right after the
      // description captured above (or right after the name when this block
      // has no description line). descHere (not rec.description) decides the
      // offset, because a reused rec may carry a description from an earlier
      // duplicate block.
      if (rec.language == null) {
        const langIdx = descHere ? i + 3 : i + 2;
        if (langIdx < lines.length) {
          const cand = lines[langIdx];
          if (
            cand &&
            isLanguageLabel(cand) &&
            !NUM_RE.test(cand) &&
            !BUILT_BY_RE.test(cand) &&
            !STARS_TODAY_RE.test(cand) &&
            !OWNER_LINE_RE.test(cand)
          ) {
            rec.language = cand;
          }
        }
      }
      prevNumbers = [];
      i += 1;
      continue;
    }

    const t = line.match(STARS_TODAY_RE);
    if (t) {
      if (rec && rec.starsToday == null) rec.starsToday = Number(t[1].replace(/,/g, ""));
      rec = null;
      prevNumbers = [];
      i++;
      continue;
    }

    if (NUM_RE.test(line) && rec) {
      prevNumbers.push(line);
      // Keep the last three: a block can carry stray page numbers, and the
      // "Built by" branch needs to see 3+ buffered numbers to refuse a guess.
      if (prevNumbers.length > 3) prevNumbers.shift();
      i++;
      continue;
    }

    if (BUILT_BY_RE.test(line) && rec) {
      // total stars = first of EXACTLY two bare numbers (the older one), forks
      // = the second. Any other count — one stray number, or 3+ numbers from a
      // noisy page fragment — means the layout is not the canonical block, so
      // attributing prevNumbers[0] would guess; leave starsTotal/forks null
      // instead (the table renders "—"). The poster prompt asserts Star/Fork
      // figures, so both must come from parsed data, never invented
      // (2026-09-25 Copilot review).
      if (rec.starsTotal == null && rec.forks == null && prevNumbers.length === 2) {
        rec.starsTotal = Number(prevNumbers[0].replace(/,/g, ""));
        rec.forks = Number(prevNumbers[1].replace(/,/g, ""));
      }
      prevNumbers = [];
      i++;
      continue;
    }

    i++;
  }

  // Sanity guard: total stars can never be lower than the same-day delta. If
  // the parse produced that impossible combination, the attribution is wrong —
  // publish null (the table renders "—") instead of a bogus number. Runs after
  // the scan because starsToday is only known at the "N stars today" line,
  // which closes the block after "Built by".
  for (const r of rows) {
    if (r.starsTotal != null && r.starsToday != null && r.starsTotal < r.starsToday) {
      r.starsTotal = null;
    }
  }

  const filtered = rows.filter((o) => o.starsToday != null);
  filtered.sort((a, b) => (b.starsToday || 0) - (a.starsToday || 0));
  return filtered;
}

export async function githubTrendingSection(config) {
  const cacheFile = path.join(
    config.cacheDir,
    `${config.date}-github-trending.txt`,
  );

  let text;
  let fetchError = null;
  let provider;
  let fromCache = false;
  let cacheWriteError = null;
  let cacheSkipped = false;
  try {
    // `direct` preserves the "N stars today" rows that readability extractors strip.
    // cachePredicate gates the cache write: only cache a body that actually parses
    // into trending rows. This stops a transient HTML error page (CF interstitial,
    // gateway 200+HTML) from being written as the day's cache and then silently
    // replayed as "successful" on every rerun that day.
    const r = await runFetch(TRENDING_URL, config, {
      provider: "direct",
      maxChars: config.fetchMaxChars,
      cacheFile,
      cachePredicate: (t) => parseTrending(t).length > 0,
    });
    text = r.text;
    provider = r.provider;
    fromCache = r.fromCache === true;
    cacheWriteError = r.cacheWriteError || null;
    cacheSkipped = r.cacheSkipped === true;
  } catch (e) {
    // last-resort: reuse a prior cache even if live fetch dies
    try {
      const fs = await import("node:fs/promises");
      text = await fs.readFile(cacheFile, "utf8");
      fromCache = true;
      provider = "cache(stale)";
    } catch {
      fetchError = e;
      text = "";
    }
  }

  const rows = parseTrending(text);
  const top = rows.slice(0, TOP_N);

  const fm = frontMatter({
    date: config.date,
    updated: new Date().toISOString(),
    tags: ["日报", "GitHub", "trending"],
  });

  let mdTable = "";
  let note = "";
  if (top.length === 0) {
    note = fetchError
      ? `> ⚠️ 抓取 github.com/trending 失败：${fetchError.message}（无可用缓存）`
      : "> 未能从抓取结果解析出 star 增量数据，可能页面结构变化或抓取为空。";
  } else {
    mdTable = table(
      ["排名", "仓库（地址）", "简介", "语言", "今日新增", "总 star"],
      top.map((r, i) => [
        i + 1,
        `[github.com/${r.repo}](https://github.com/${r.repo})`,
        briefDescription(r.description) || "—",
        r.language || "—",
        `+${r.starsToday}`,
        r.starsTotal != null ? r.starsTotal.toLocaleString() : "—",
      ]),
    );
    if (fetchError) {
      note = `> ⚠️ 实时抓取失败，使用缓存数据：${fetchError.message}\n`;
    } else if (cacheSkipped) {
      note = "> ⚠️ 实时抓取响应格式异常（疑似错误页），未写入缓存，本次以实时结果渲染。\n";
    }
    const cacheTag = fromCache ? "（缓存）" : "";
    note += `> 数据来自 github.com/trending（since=daily），抓取于 ${new Date().toISOString()} via ${provider}${cacheTag}。`;
    if (cacheWriteError) {
      note += `\n> ⚠️ 实时数据已获取，但缓存写入失败：${cacheWriteError.message || cacheWriteError.code || "未知错误"}`;
    }
  }

  const body = [
    fm,
    "",
    `# GitHub Trending · ${config.date}`,
    "",
    note,
    "",
    mdTable || "",
    "",
  ].join("\n");

  return {
    ok: top.length > 0,
    name: "GitHub",
    markdown: body,
    summary: top.length > 0 ? `success (${top.length} repos)${fromCache ? " [缓存]" : ""}` : "failed",
    repoCount: top.length,
    // Exposed for the poster step: the parsed top-N rows so image-gen can render
    // the real owner/repo + star counts onto the GitHub 日榜简报 poster.
    repos: top,
  };
}
