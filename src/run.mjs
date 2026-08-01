#!/usr/bin/env node
// Entry: orchestrate the AI + GitHub sections concurrently, write each to the
// Obsidian vault, and print a summary. One section failing never blocks the other.
//
// After the GitHub section lands, an extra step generates a GitHub 日榜简报 poster
// image (vault prompt + reference image -> CPA /images/edits) and embeds it into
// GitHub.md. The poster step is opt-out (IMAGE_ENABLED) and never blocks the
// text sections.

import { loadConfig, validateRuntimePaths } from "./config.mjs";
import { aiNewsSection } from "./sections/ai-news.mjs";
import { githubTrendingSection } from "./sections/github-trending.mjs";
import { generateGithubPoster } from "./image-gen.mjs";
import { writeSection, rescueMarkdown } from "./obsidian.mjs";

function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseArgs(argv) {
  const args = [...argv];
  let section = null;
  while (args.length) {
    const a = args.shift();
    if (a === "--section") section = args.shift();
    else if (a === "--help" || a === "-h") return { help: true };
  }
  return { section };
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node src/run.mjs [--section ai|github]");
    process.exit(0);
  }

  const config = loadConfig({ date: todayLocal() });
  const pathWarnings = validateRuntimePaths(config);
  if (pathWarnings.length) {
    console.warn(`⚠️ 运行路径提醒：\n${pathWarnings.map((warning) => `  - ${warning}`).join("\n")}`);
  }

  const builders = {
    ai: () => aiNewsSection(config),
    github: () => githubTrendingSection(config),
  };

  let names;
  if (opts.section) {
    if (!builders[opts.section]) {
      console.error(`未知 section: ${opts.section}（可选: ai, github）`);
      process.exit(2);
    }
    names = [opts.section];
  } else {
    names = ["ai", "github"];
  }

  const results = await Promise.allSettled(
    names.map(async (n) => {
      const res = await builders[n]();
      // writeSection returns { file, error } and never throws: a vault write
      // failure (iCloud mid-sync, vault moved, disk full) is rescued to a
      // fallback cache file so the built markdown isn't lost.
      const written = await writeSection(config, res.name, res.markdown);
      if (written.error) {
        const rescued = await rescueMarkdown(config, res.name, res.markdown);
        res.writeError = written.error;
        res.file = rescued
          ? `${rescued}（vault 写入失败，已抢救到缓存）`
          : `${written.file}（写入失败且抢救失败）`;
        // A write failure on an otherwise-ok section is a degradation, not success.
        res.ok = false;
      } else {
        res.file = written.file;
      }
      return res;
    }),
  );

  // Poster step: only relevant after the GitHub section, only when enabled, and
  // isolated so a poster failure never downgrades the already-written GitHub.md.
  // We rewrite GitHub.md with the embed only on success; on failure we leave the
  // text report intact and surface the poster error in the summary.
  const posterLines = [];
  if (config.imageEnabled && names.includes("github")) {
    const gi = names.indexOf("github");
    const gr = results[gi];
    const gv = gr.status === "fulfilled" ? gr.value : null;
    if (gv && gv.ok && gv.repos && gv.repos.length > 0) {
      try {
        const poster = await generateGithubPoster(config, gv.repos, {});
        if (poster.ok && poster.file) {
          // Embed the poster into GitHub.md (Obsidian embed via bare filename,
          // same-folder, so it survives vault moves). Rebuild markdown + rewrite.
          const embedded = embedPosterInMarkdown(gv.markdown, "GitHub.png");
          const written2 = await writeSection(config, gv.name, embedded);
          if (written2.error) {
            // Text report is already on disk from the first write; embedding just
            // failed to persist. Note it but keep poster.ok true (the PNG exists).
            poster.embedError = written2.error;
          }
          posterLines.push(`${poster.ok ? "✅" : "⚠️"} GitHubPoster: ${poster.summary} → ${poster.file}${poster.embedError ? "（嵌入失败，PNG 已落地）" : ""}`);
        } else {
          posterLines.push(`⚠️ GitHubPoster: ${poster.summary}${poster.error ? `（${poster.error.code}）` : ""}`);
        }
      } catch (e) {
        // generateGithubPoster shouldn't throw (it returns errors), but guard anyway.
        posterLines.push(`❌ GitHubPoster: ${e?.message || e}`);
      }
    } else if (gv && (!gv.ok || !gv.repos || gv.repos.length === 0)) {
      posterLines.push("⏭️ GitHubPoster: 跳过（GitHub 板块无仓库数据）");
    }
  } else if (config.imageEnabled && !names.includes("github")) {
    // running a non-github section with image enabled — nothing to do
  }

  const summary = names.map((n, i) => {
    const r = results[i];
    if (r.status === "fulfilled") {
      const v = r.value;
      const tag = v.ok ? "✅" : "⚠️";
      let line = `${tag} ${v.name}: ${v.summary} → ${v.file}`;
      if (v.writeError) {
        line += `\n    ⚠️ vault 写入失败：${v.writeError.message}`;
      }
      return line;
    }
    return `❌ ${n}: ${r.reason?.message || r.reason}`;
  });
  if (posterLines.length) summary.push(...posterLines);
  console.log(`\nDallyReport ${config.date}\n` + summary.join("\n") + "\n");
}

// Insert a poster embed into the GitHub section markdown. Placed right under the
// H1 title (before the data note) so the poster is the first thing seen.
function embedPosterInMarkdown(markdown, imageFilename) {
  const lines = markdown.split("\n");
  const out = [];
  let insertedH1 = false;
  for (const line of lines) {
    out.push(line);
    if (!insertedH1 && /^#\s/.test(line)) {
      out.push("");
      out.push(`![[${imageFilename}]]`);
      out.push("");
      insertedH1 = true;
    }
  }
  if (!insertedH1) {
    // No H1 found — prepend the embed at the very top.
    return `![[${imageFilename}]]\n\n${markdown}`;
  }
  return out.join("\n");
}

run().catch((e) => {
  console.error("运行失败:", e?.message || e);
  process.exit(1);
});
