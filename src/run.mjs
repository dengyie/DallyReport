#!/usr/bin/env node
// Entry: orchestrate the AI + GitHub sections concurrently, write each to the
// Obsidian vault, and print a summary. One section failing never blocks the other.
//
// After each text section lands, optional poster steps generate GitHub.png and
// AI.png from vault prompts + reference images and embed them into their Markdown.
// Poster generation is independently gated and never blocks the text sections.

import { loadConfig, validateRuntimePaths, beijingDateFor, resolveAltChannel } from "./config.mjs";
import { aiNewsSection } from "./sections/ai-news.mjs";
import { githubTrendingSection } from "./sections/github-trending.mjs";
import {
  generateGithubPoster,
  generateAiPoster,
  hasAiPosterHeadlines,
} from "./image-gen.mjs";
import { writeSection, rescueMarkdown } from "./obsidian.mjs";
import { enrichLinuxdoPosts } from "./linuxdo.mjs";
import { acquireSingletonLock } from "./lock.mjs";
import { killAllChildren } from "./child-tracker.mjs";

// Render the raw linux.do news/34 posts (all of today's, verbatim) as a self-contained
// 辅助资料 (auxiliary materials) note. Pure markdown, no pollution: it lists titles,
// URLs, Beijing timestamps, and the Discourse excerpts — the raw input that fed the
// AI synthesis. Kept separate from the shipped AI report so the brief stays clean.
// postsById (optional) comes from enrichLinuxdoPosts: full body + attachments for
// this post were crawled to <date>/linuxdo-posts & linuxdo-attachments. When present
// we surface the attachment count and embed the full thread so Obsidian lazy-embeds
// the whole post instead of a giant inline note.
function renderLinuxDoPostAuxiliary(cards, date, postsById = new Map()) {
  const lines = [
    `# linux.do 前沿快讯 辅助资料 · ${date}`,
    "",
    `共 ${cards.length} 条当天帖子（来源：https://linux.do/c/news/34）`,
    "",
  ];
  for (const c of cards) {
    lines.push(`## ${c.title}`);
    lines.push(`- 链接：${c.url}`);
    if (c.created_at) lines.push(`- 时间：${c.created_at}`);
    if (c.excerpt) lines.push(`- 正文摘录：${c.excerpt}`);
    const rec = postsById.get(c.url) || postsById.get(c.id);
    if (rec?.attachments?.length) lines.push(`- 附件：${rec.attachments.length} 个已下载`);
    if (rec?.embed) {
      lines.push("");
      lines.push(`<details><summary>展开完整帖子（${rec.title}）</summary>`);
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

// The report and posters label their timestamp as 北京时间, so config.date must be
// the Beijing (UTC+8) calendar date — not the host machine's local date, which on
// a UTC/CI box would be off by up to a day and disagree with the {date} rendered on
// the posters.
function todayBeijing() {
  return beijingDateFor(Date.now());
}

function parseArgs(argv) {
  const args = [...argv];
  let section = null;
  let date = null;
  while (args.length) {
    const a = args.shift();
    if (a === "--section") section = args.shift();
    else if (a === "--date") date = args.shift();
    else if (a === "--help" || a === "-h") return { help: true };
  }
  return { section, date };
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node src/run.mjs [--section ai|ai-alt|github] [--date YYYY-MM-DD]");
    process.exit(0);
  }

  // Default to today's Beijing date; --date overrides it for backfill — e.g. run
  // yesterday's report on a machine that was off, or regenerate a specific day.
  // The date stamps the output dir, front-matter, H1, poster {date}, and the
  // AI_QUERY {date} placeholder, so an explicit date keeps all four in agreement.
  let date = todayBeijing();
  if (opts.date) {
    // Format must be YYYY-MM-DD AND round-trip through the calendar: a regex like
    // /^\d{4}-\d{2}-\d{2}$/ would accept 2026-99-99 and then stamp an impossible
    // directory/query date. Rebuild the components from UTC so 2026-02-30 etc.
    // are rejected too.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(opts.date);
    const ok = m && (() => {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const dt = new Date(Date.UTC(y, mo - 1, d));
      return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
    })();
    if (!ok) {
      console.error(`无效日期: ${opts.date}（应为合法的 YYYY-MM-DD）`);
      process.exit(2);
    }
    date = opts.date;
  }

  const config = loadConfig({ date });

  // Single-instance guard: refuse to start if another run is already in flight (a
  // double-fired cron, or a manual run while the scheduled one is in image-gen).
  // The lock also gives every exit path a single place to drop the lock and reap
  // in-flight children, so an interrupted run leaves no orphan processes and no
  // stale lock that would block the next run.
  const lockPath = path.join(config.cacheDir, "run.lock");
  const lock = acquireSingletonLock(lockPath);
  if (lock.error) {
    console.error(`⏭️ 已有实例在运行，本次退出：${lock.error}`);
    process.exit(0);
  }
  // Single cleanup path: the 'exit' handler reaps children (SIGKILL) and drops the
  // lock. SIGINT/SIGTERM just exit — process.exit() fires 'exit', so cleanup runs
  // exactly once instead of being duplicated (and double-fired) in each handler.
  process.on("exit", () => {
    killAllChildren();
    lock.release();
  });
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  const pathWarnings = validateRuntimePaths(config);
  if (pathWarnings.length) {
    console.warn(`⚠️ 运行路径提醒：\n${pathWarnings.map((warning) => `  - ${warning}`).join("\n")}`);
  }

  const builders = {
    ai: () => aiNewsSection(config),
    github: () => githubTrendingSection(config),
  };
  // Second AI channel: reuses the whole aiNewsSection pipeline (independent search
  // + community merge + synthesis) with a different writer model. Registered only
  // when enabled. It deliberately gets no poster — the AI poster prompt file is
  // main-channel specific, and a duplicate poster per channel adds noise.
  const altChannel = resolveAltChannel(config);
  if (altChannel) {
    builders["ai-alt"] = () => aiNewsSection(config, altChannel);
  }

  let names;
  if (opts.section) {
    if (!builders[opts.section]) {
      console.error(`未知 section: ${opts.section}（可选: ai, ai-alt, github）`);
      process.exit(2);
    }
    names = [opts.section];
  } else {
    names = ["ai", "github"];
    if (altChannel) names.splice(1, 0, "ai-alt");
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
      // Dump the raw linux.do news/34 posts (auxiliary materials) that fed this
      // section into a sibling <name>-辅助资料.md, so every forum post that went
      // into synthesis is recorded verbatim. Best-effort: never blocks the section.
      // Full-body enrichment runs once, after the poster steps, in the shared
      // post-pass below — not here, so a dual-channel day crawls each topic once.
      if (Array.isArray(res?.linuxdoRaw) && res.linuxdoRaw.length) {
        const aux = renderLinuxDoPostAuxiliary(res.linuxdoRaw, config.date);
        const auxWritten = await writeSection(config, `${res.name}-辅助资料`, aux);
        if (auxWritten.error) {
          res.auxError = auxWritten.error;
        } else {
          res.auxFile = auxWritten.file;
        }
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
    } else if (gr.status === "rejected") {
      posterLines.push("⏭️ GitHubPoster: 跳过（GitHub 板块执行失败，未生成海报）");
    }
  } else if (config.imageEnabled && !names.includes("github")) {
    // running a non-github section with image enabled — the AI poster block
    // (guarded by names.includes("ai")) handles its own section; nothing to do here.
  }

  // AI poster follows the same isolation rule as GitHub poster: AI.md is first
  // written without the image, and only rewritten with the embed after PNG
  // generation succeeds. A failed poster never removes or corrupts AI.md.
  if (config.imageEnabled && config.aiImageEnabled && names.includes("ai")) {
    const aiIndex = names.indexOf("ai");
    const ar = results[aiIndex];
    const av = ar.status === "fulfilled" ? ar.value : null;
    if (av && av.ok && hasAiPosterHeadlines(av.sources)) {
      try {
        const poster = await generateAiPoster(config, av.sources, {});
        if (poster.ok && poster.file) {
          const embedded = embedPosterInMarkdown(av.markdown, "AI.png");
          const written2 = await writeSection(config, av.name, embedded);
          if (written2.error) {
            poster.embedError = written2.error;
          }
          posterLines.push(`${poster.ok ? "✅" : "⚠️"} AIPoster: ${poster.summary} → ${poster.file}${poster.embedError ? "（嵌入失败，PNG 已落地）" : ""}`);
        } else {
          posterLines.push(`⚠️ AIPoster: ${poster.summary}${poster.error ? `（${poster.error.code}）` : ""}`);
        }
      } catch (e) {
        posterLines.push(`❌ AIPoster: ${e?.message || e}`);
      }
    } else if (av && !av.ok) {
      posterLines.push("⏭️ AIPoster: 跳过（AI 板块失败，未生成海报）");
    } else if (av) {
      posterLines.push("⏭️ AIPoster: 跳过（无有效新闻标题）");
    } else if (ar.status === "rejected") {
      posterLines.push("⏭️ AIPoster: 跳过（AI 板块执行失败，未生成海报）");
    }
  }

  // Post-report enrichment (best-effort, non-blocking): crawl COMPLETE post
  // bodies (OP + replies) via the Discourse topic JSON API and download
  // attachments into the vault. Runs ONCE across all sections (ai + ai-alt share
  // today's linux.do posts, so a dual-channel day crawls each topic a single
  // time), and AFTER the poster steps so image generation is never delayed. On
  // success each linux.do-carrying section's 辅助资料 is re-rendered with a
  // per-post attachment count + a collapsed embed of the full thread, so the aux
  // file stays small while Obsidian lazy-loads the full posts. enrichLinuxdoPosts
  // bounds itself to LINUXDO_ENRICH_BUDGET_MS and RETURNS the partial results
  // instead of throwing, so a slow browser can't stall the summary and everything
  // archived is linked (nothing on disk goes unreferenced).
  const cardSections = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v) => Array.isArray(v?.linuxdoRaw) && v.linuxdoRaw.length && !v.auxError);
  let posts = [];
  if (cardSections.length) {
    try {
      posts = await enrichLinuxdoPosts(cardSections[0].linuxdoRaw, config);
    } catch (e) {
      // Enrichment is additive; the base aux (and the report) already went out.
      console.warn(`⚠ 完整帖补全跳过：${e?.message || String(e)}`);
    }
  }
  if (posts.length) {
    const byUrl = new Map(posts.map((p) => [p.url, p]));
    for (const v of cardSections) {
      const aux2 = renderLinuxDoPostAuxiliary(v.linuxdoRaw, config.date, byUrl);
      const w2 = await writeSection(config, `${v.name}-辅助资料`, aux2);
      if (!w2.error) {
        v.auxFile = w2.file;
        v.auxPosts = posts.length;
      }
    }
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
      if (v.auxFile) {
        line += `\n    ${tag} 辅助资料: → ${v.auxFile}${v.auxPosts ? `（完整帖子 ${v.auxPosts}）` : ""}`;
      }
      return line;
    }
    return `❌ ${n}: ${r.reason?.message || r.reason}`;
  });
  if (posterLines.length) summary.push(...posterLines);
  const text = `\nDallyReport ${config.date}\n` + summary.join("\n") + "\n";
  // Flush stdout, then exit(0) deterministically. Forcing the exit releases every
  // handle (undici keep-alive sockets, CDP connections, child processes) instead of
  // letting the process hang a few seconds on background connections after the
  // report is already written. The 'exit' handler reaps any in-flight children and
  // drops the lock. Writing through the callback first avoids truncating the summary.
  process.stdout.write(text, (err) => process.exit(err ? 1 : 0));
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
