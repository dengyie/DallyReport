#!/usr/bin/env node
// Entry: orchestrate the AI + GitHub sections concurrently, write each to the
// Obsidian vault, and print a summary. One section failing never blocks the other.
//
// After each text section lands, optional poster steps generate GitHub.png and
// AI.png from vault prompts + reference images and embed them into their Markdown.
// Poster generation is independently gated and never blocks the text sections.

import path from "node:path";
import { loadConfig, validateRuntimePaths, beijingDateFor, resolveAltChannel } from "./config.mjs";
import { aiNewsSection } from "./sections/ai-news.mjs";
import { githubTrendingSection } from "./sections/github-trending.mjs";
import {
  generateGithubPoster,
  generateAiPoster,
  hasAiPosterHeadlines,
} from "./image-gen.mjs";
import {
  aiPosterFileName,
  githubPosterFileName,
  githubPosterPeriod,
  aiPosterPeriod,
} from "./poster/period.mjs";
import {
  renderGithubPoster,
  renderAiPoster,
  buildStories,
  buildStoriesFromBody,
} from "./poster/index.mjs";
import { writeSection, rescueMarkdown } from "./obsidian.mjs";
import { enrichLinuxdoPosts } from "./linuxdo.mjs";
import { acquireSingletonLock } from "./lock.mjs";
import { killAllChildren } from "./child-tracker.mjs";
import { REPORT_MODES } from "./report-window.mjs";

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
  let mode = null;
  while (args.length) {
    const a = args.shift();
    if (a === "--section") section = args.shift();
    else if (a === "--date") date = args.shift();
    else if (a === "--mode") mode = args.shift();
    else if (a === "--help" || a === "-h") return { help: true };
  }
  return { section, date, mode };
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: node src/run.mjs [--section ai|ai-alt|github] [--date YYYY-MM-DD] [--mode daily|weekly|auto]",
    );
    console.log("  --mode auto(默认)  北京时间周五自动跑周报，其余日期跑日报");
    process.exit(0);
  }

  // 2026-09-28 weekly: validate --mode BEFORE the lock, config load and any
  // section, so an operator typo costs a message and nothing else. A mode that
  // reached config.mjs would otherwise throw from deep inside loadConfig, after
  // the lock was taken.
  if (opts.mode != null && !REPORT_MODES.includes(opts.mode)) {
    console.error(`未知 mode: ${opts.mode}（可选: ${REPORT_MODES.join(", ")}）`);
    process.exit(2);
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

  // The CLI flag wins over REPORT_MODE in the environment, so a backfill or a
  // one-off weekly does not require editing .env. Omitted, loadConfig falls back
  // to the env and then to the Beijing-weekday rule (Friday = weekly).
  const config = loadConfig({ date, mode: opts.mode });

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
        // 2026-09-26 review P3: the rescue path used to overwrite `res.file` with a
        // string that mixed a path and a parenthetical, making the one field an
        // operator would copy or script against unparseable — on exactly the days
        // the fallback file is the only artifact that exists. `file` stays the
        // intended path; the rescue location gets its own field.
        res.rescueFile = rescued || null;
        res.rescueFailed = !rescued;
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
      //
      // 2026-09-28 weekly: skipped. The file is a verbatim per-post archive of
      // what the section consumed; a week's haul is hundreds of posts, which
      // would be an unreadable wall of text in the vault and would then be
      // enriched (a full-body crawl per topic) at 7x the cost, for an artifact
      // nobody reads. The cache still holds the same material.
      if (!config.isWeekly && Array.isArray(res?.linuxdoRaw) && res.linuxdoRaw.length) {
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

  // Dual-channel cross-link, phase 2: each AI note points at the other model's
  // take under its H1 (Obsidian wikilink, same folder). This MUST happen after
  // allSettled: injecting inside the per-section callback linked to a sibling
  // whose build/write might still fail, leaving a dangling [[...]] in a
  // successful note (2026-09-25 Copilot review). Only fulfilled sections whose
  // vault write succeeded participate, on both sides.
  if (altChannel && names.includes("ai") && names.includes("ai-alt")) {
    const byKey = new Map();
    results.forEach((r, i) => {
      if (r.status === "fulfilled") byKey.set(names[i], r.value);
    });
    const ai = byKey.get("ai");
    const alt = byKey.get("ai-alt");
    const writtenOk = (v) => v && !v.writeError;
    if (writtenOk(ai) && writtenOk(alt)) {
      for (const [v, otherName] of [
        [ai, alt.name],
        [alt, ai.name],
      ]) {
        v.markdown = injectCrossRef(v.markdown, otherName);
        const rewrote = await writeSection(config, v.name, v.markdown);
        if (rewrote.error) {
          // The pre-link version is already on disk; don't pretend otherwise.
          v.writeError = rewrote.error;
          v.ok = false;
        }
      }
    }
  }

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
        // POSTER_RENDERER picks the producer. Both return the same {ok, file}
        // shape, so everything below — the embed, the rewrite, the summary line
        // — is identical either way.
        const poster =
          config.posterRenderer === "image"
            ? await generateGithubPoster(config, gv.repos, {})
            : await renderGithubPoster({
                config,
                repos: gv.repos,
                deps: {
                  period: githubPosterPeriod(config),
                  outputFile: githubPosterFileName(config),
                },
              });
        if (poster.ok && poster.file) {
          // Embed the poster into GitHub.md (Obsidian embed via bare filename,
          // same-folder, so it survives vault moves). Rebuild markdown + rewrite.
          // Must be the SAME name the poster was written under — a weekly writes
          // GitHub-周报.png, and embedding [[GitHub.png]] would silently point at
          // the daily's poster instead.
          const embedded = embedPosterInMarkdown(gv.markdown, githubPosterFileName(config));
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
    // Poster input. Two candidates, and the note body wins: the cited source
    // cards carry raw third-party headlines (mostly English, often forum
    // register), while the body already states each event as a finished
    // Chinese sentence and is the text de-clustering actually shaped. The
    // source cards remain the fallback for a degraded body, which is the one
    // case where there are no bullets to render.
    const posterSources = av?.posterSources?.length ? av.posterSources : av?.sources;
    const posterPeriod = aiPosterPeriod(config);
    const bodyStories =
      config.posterRenderer === "layout" ? buildStoriesFromBody(av?.markdown, { period: posterPeriod }) : [];
    // 3 is not a tuned number: two bullets make a two-item poster that looks
    // broken next to a full note, so below that the cited cards are the better
    // artefact even though their prose is worse.
    const useBody = bodyStories.length >= 3;
    const posterStories = useBody ? bodyStories : buildStories(posterSources, { period: posterPeriod });
    if (av && av.ok && (useBody || hasAiPosterHeadlines(posterSources))) {
      try {
        const poster =
          config.posterRenderer === "image"
            ? await generateAiPoster(config, posterSources, {})
            : await renderAiPoster({
                config,
                stories: posterStories,
                deps: {
                  period: posterPeriod,
                  outputFile: aiPosterFileName(config),
                },
              });
        if (poster.ok && poster.file) {
          const embedded = embedPosterInMarkdown(av.markdown, aiPosterFileName(config));
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
  //
  // 2026-09-28 weekly: skipped entirely for the same reason the aux write is —
  // there is no aux file to enrich, and crawling a week of topics is 7x the
  // browser time for an artifact that is not produced.
  const cardSections = (config.isWeekly
    ? []
    : results
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((v) => Array.isArray(v?.linuxdoRaw) && v.linuxdoRaw.length && !v.auxError));
  let posts = [];
  if (cardSections.length) {
    try {
      // The two channels fetch news/34 independently (different timing, different
      // pagination outcomes), so their card sets can differ. Enrich the UNION
      // keyed by url/id — enriching only cardSections[0] left the other channel's
      // unique posts without full bodies/attachments forever (2026-09-25 review).
      const seen = new Set();
      const unionRaw = [];
      for (const v of cardSections) {
        for (const card of v.linuxdoRaw) {
          const key = card?.url ?? card?.id;
          if (key == null || seen.has(key)) continue;
          seen.add(key);
          unionRaw.push(card);
        }
      }
      posts = await enrichLinuxdoPosts(unionRaw, config);
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
        if (v.rescueFile) {
          line += `\n    ↩ 已抢救到：${v.rescueFile}`;
        } else if (v.rescueFailed) {
          line += `\n    ↩ 抢救失败：内容未能落盘`;
        }
      }
      if (v.auxFile) {
        line += `\n    ${tag} 辅助资料: → ${v.auxFile}${v.auxPosts ? `（完整帖子 ${v.auxPosts}）` : ""}`;
      }
      return line;
    }
    return `❌ ${n}: ${r.reason?.message || r.reason}`;
  });
  if (posterLines.length) summary.push(...posterLines);
  // 2026-09-28 weekly: the launchd log is where an operator checks "what ran".
  // A weekly headlined with the bare Friday would be indistinguishable from a
  // daily in the log tail, so the span travels with it.
  const runHeader = config.isWeekly
    ? `DallyReport 周报 ${config.windowLabel}`
    : `DallyReport ${config.date}`;
  const text = `\n${runHeader}\n` + summary.join("\n") + "\n";
  // Flush stdout, then exit(0) deterministically. Forcing the exit releases every
  // handle (undici keep-alive sockets, CDP connections, child processes) instead of
  // letting the process hang a few seconds on background connections after the
  // report is already written. The 'exit' handler reaps any in-flight children and
  // drops the lock. Writing through the callback first avoids truncating the summary.
  process.stdout.write(text, (err) => process.exit(err ? 1 : 0));
}

// Insert a cross-reference line under the H1 so the dual AI channels point at
// each other (AI.md <-> AI-Gemini.md). Obsidian wikilink, same folder.
function injectCrossRef(markdown, otherFile) {
  const line = `> 🔀 另一模型视角：[[${otherFile}]]`;
  const lines = String(markdown).split("\n");
  const out = [];
  let done = false;
  for (const l of lines) {
    out.push(l);
    if (!done && /^#\s/.test(l)) {
      out.push("");
      out.push(line);
      out.push("");
      done = true;
    }
  }
  return done ? out.join("\n") : `${line}\n\n${markdown}`;
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
