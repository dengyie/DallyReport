import path from "node:path";
import { runFetch } from "../grok-cli.mjs";
import { frontMatter, table } from "../markdown.mjs";

const TRENDING_URL = "https://github.com/trending?since=daily";
const TOP_N = 15;

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

export function parseTrending(text) {
  if (!text) return [];
  const lines = text.split("\n").map((l) => l.trim());
  const rows = [];
  let i = 0;
  let rec = null;
  // Among the two bare numbers in a block (totalStars, forks), totalStars is the
  // first. Track the last two bare numbers so "Built by" can attribute the first.
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
        rec = { repo: key, owner, name, starsToday: null, starsTotal: null, description: null };
        rows.push(rec);
      } else {
        rec = rows.find((r) => r.repo === key);
      }
      // Capture the one-line project description, which sits right under the name
      // (before the language line, if any). It's the first non-structural line:
      // not a bare number, not "Built by", not "N stars today", not an owner line.
      // A repo with no description simply has no such line; rec stays description: null.
      if (rec.description == null && i + 2 < lines.length) {
        const cand = lines[i + 2];
        if (
          cand &&
          !NUM_RE.test(cand) &&
          !BUILT_BY_RE.test(cand) &&
          !STARS_TODAY_RE.test(cand) &&
          !OWNER_LINE_RE.test(cand)
        ) {
          rec.description = cand;
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
      if (prevNumbers.length > 2) prevNumbers.shift(); // keep last two
      i++;
      continue;
    }

    if (BUILT_BY_RE.test(line) && rec) {
      // total stars = first of the last two bare numbers (the older one).
      if (rec.starsTotal == null && prevNumbers.length) {
        const cand = prevNumbers[0];
        rec.starsTotal = Number(cand.replace(/,/g, ""));
      }
      prevNumbers = [];
      i++;
      continue;
    }

    i++;
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
  try {
    // `direct` preserves the "N stars today" rows that readability extractors strip.
    const r = await runFetch(TRENDING_URL, config, {
      provider: "direct",
      maxChars: config.fetchMaxChars,
      cacheFile,
    });
    text = r.text;
    provider = r.provider;
    fromCache = r.fromCache === true;
    cacheWriteError = r.cacheWriteError || null;
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
      ["排名", "仓库", "今日新增", "总 star"],
      top.map((r, i) => [
        i + 1,
        `[${r.repo}](https://github.com/${r.repo})`,
        `+${r.starsToday}`,
        r.starsTotal != null ? r.starsTotal.toLocaleString() : "—",
      ]),
    );
    note = fetchError
      ? `> ⚠️ 实时抓取失败，使用缓存数据：${fetchError.message}\n`
      : "";
    note += `> 数据来自 github.com/trending（since=daily），抓取于 ${new Date().toISOString()} via ${provider}${fromCache ? "（缓存）" : ""}。`;
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
