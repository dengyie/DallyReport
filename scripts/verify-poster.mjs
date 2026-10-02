// Render both posters from real vault data and read them BACK with OCR.
//
// The unit suite asserts on the markup, which is the right level for "did we
// print the right number". It cannot answer the only question that matters for
// a PNG: did the right number SURVIVE rasterisation? That is what this script
// is for. It renders, OCRs, and diffs the recognised text against the strings
// the poster was built from.
//
// Why OCR is the check and not a human eye: the failure this project shipped
// was invisible to everyone and obvious to a machine. The 2026-09-25 weekly
// posters had 官方布 (宣布), 60 葵元 (美元), 颌奖盛典在抗州 (颁奖…杭州) — all
// wrong, all confident, all reading as plausible Chinese to a reader who does
// not know the source text. A reviewer comparing against the note catches it;
// a reviewer glancing at a pretty picture does not. Running this script is
// cheaper and more reliable than either.
//
//   node scripts/verify-poster.mjs [--date 2026-09-25] [--mode weekly]
//
// Exits non-zero if any expected string is missing from the OCR output.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../src/config.mjs";
import { parseTrending, briefDescription } from "../src/sections/github-trending.mjs";
import { githubPosterHtml, GITHUB_POSTER_SIZE } from "../src/poster/github.mjs";
import { aiPosterHtml, buildStoriesFromBody, AI_POSTER_SIZE } from "../src/poster/ai.mjs";
import { renderHtmlToPng } from "../src/poster/shot.mjs";
import { githubPosterPeriod, aiPosterPeriod } from "../src/poster/period.mjs";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--date") out.date = argv[++i];
    if (argv[i] === "--mode") out.mode = argv[++i];
  }
  return out;
}

/** Build the OCR binary once; returns its path, or null when Swift is absent. */
async function ensureOcr() {
  const bin = path.join(os.tmpdir(), "dally-ocr");
  if (existsSync(bin)) return bin;
  const src = path.join(import.meta.dirname, "ocr.swift");
  try {
    await execFileAsync("swiftc", ["-O", src, "-o", bin], { timeout: 180_000 });
    return bin;
  } catch (err) {
    console.log(`⚠️  未编译 OCR 工具（${err.code || err.message}），跳过文字回读校验。`);
    return null;
  }
}

async function ocr(bin, pngPath, scale = 2) {
  const { stdout } = await execFileAsync(bin, [pngPath, String(scale)], {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

// OCR inserts spaces between a Latin run and a CJK run, and may split a long
// string across boxes. Comparing on "every non-space character is present in
// order" is the robust form; an exact-substring check would fail on trivia.
//
// Two further equivalences, and they are narrow on purpose.
//
// 1. In the poster's sans face "I" and "l" are the same 6px stem with no
//    crossbars, and Vision reads one as the other at 1x, 2x and 4x alike — the
//    recogniser being ambiguous about a genuinely ambiguous glyph, not the
//    pixels being wrong. The HTML says "AI 编程代理".
// 2. "…" comes back as ".". Folded because the alternative is to stop marking a
//    headline as abridged, which would be worse: a label cut off with no
//    signal reads as a whole one.
//
// Neither can hide what this gate is for. A CJK glyph the renderer got wrong
// (美元 read back as 葵元) is not in either set and still fails, as does any
// dropped, invented or duplicated content.
//
// The residual blind spot, stated so nobody mistakes this for a proof: because
// both sides are folded, a GENUINE Latin typo of the same shape slips through.
// A poster that rendered "lnfra" for "Infra" passes. That is a second-order
// cost of a first-order fix — the alternative was a gate that reports a
// correct poster as broken, which is how a gate gets switched off. If a
// headline is ever important enough to need exact Latin spelling, assert it on
// the HTML in test/poster.test.mjs instead of here, where no OCR is involved.
function normalise(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/…/g, ".")
    .replace(/[A-Za-z0-9]+/g, (run) => run.replace(/[Il]/g, "l"));
}

function containsLoose(haystack, needle) {
  return normalise(haystack).includes(normalise(needle));
}

const results = [];
// `forbid` flips the assertion: the string must be ABSENT. Needed for the
// regressions that are additions rather than omissions — "score:" is not
// missing from the AI poster, it is very much present in it.
function check(label, expected, haystack, forbid = false) {
  const present = containsLoose(haystack, expected);
  const ok = forbid ? !present : present;
  results.push({ ok, label, expected, forbid });
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ date: args.date || null, mode: args.mode || null });
  const outDir = await mkdtemp(path.join(os.tmpdir(), "dally-verify-"));
  const ocrBin = await ensureOcr();

  console.log(`\n验证目标：${config.date} ${config.reportMode}（${config.windowLabel}）`);
  console.log(`产物目录：${outDir}\n`);

  // ---- GitHub poster ----------------------------------------------------
  const cacheFile = path.join(config.cacheDir, `${config.date}-${config.reportMode}-github-trending.txt`);
  if (!existsSync(cacheFile)) {
    console.log(`⏭️  跳过 GitHub 海报：没有缓存 ${path.basename(cacheFile)}`);
  } else {
    const text = await readFile(cacheFile, "utf8");
    const repos = parseTrending(text)
      .filter((r) => r.starsToday != null)
      .map((r) => ({ repo: r.repo, starsToday: r.starsToday, starsTotal: r.starsTotal, description: briefDescription(r.description) }));
    const period = githubPosterPeriod(config);
    const html = githubPosterHtml({ repos, period });
    const pngPath = path.join(outDir, "github.png");
    await writeFile(pngPath, await renderHtmlToPng(html, GITHUB_POSTER_SIZE));
    const seen = ocrBin ? await ocr(ocrBin, pngPath) : "";

    check("GitHub 海报 · 标题按周期", period.weekly ? "本周热门仓库" : "今日热门仓库", seen);
    check("GitHub 海报 · 日期区间", config.windowLabel, seen);
    check("GitHub 海报 · star 列按周期", period.starWord, seen);
    const shown = repos.slice(0, 10);
    for (const r of shown) {
      check(`GitHub 海报 · 仓库名 ${r.repo}`, r.repo, seen);
      check(`GitHub 海报 · 本期新增 ${r.repo}`, `+${Number(r.starsToday).toLocaleString("en-US")}`, seen);
    }
    if (repos.length > shown.length) {
      check("GitHub 海报 · 截断已声明", `另有 ${repos.length - shown.length} 个见笔记`, seen);
    }
    check("GitHub 海报 · 页脚存在", "数据源", seen);
    console.log(`  GitHub 海报：${pngFileLine(outDir, "github.png")}`);
  }

  // ---- AI poster --------------------------------------------------------
  const noteName = config.reportMode === "weekly" ? "AI-周报.md" : "AI.md";
  const notePath = path.join(config.obsidianDir, config.date, noteName);
  if (!existsSync(notePath)) {
    console.log(`⏭️  跳过 AI 海报：找不到 ${notePath}`);
  } else {
    const md = await readFile(notePath, "utf8");
    // The very call run.mjs makes, so this script measures the delivered
    // artefact and not a cleaner reconstruction of it. Building the poster from
    // the note body by hand once hid a real clipping bug, because the
    // reconstruction shaped its titles differently from the pipeline.
    const period = aiPosterPeriod(config);
    const stories = buildStoriesFromBody(md, { period });
    const html = aiPosterHtml({ stories, period });
    const pngPath = path.join(outDir, "ai.png");
    await writeFile(pngPath, await renderHtmlToPng(html, AI_POSTER_SIZE));
    const seen = ocrBin ? await ocr(ocrBin, pngPath) : "";

    check("AI 海报 · 标题按周期", period.weekly ? "本周 AI 要闻" : "今日 AI 要闻", seen);
    check("AI 海报 · 日期区间", config.windowLabel, seen);
    for (const s of stories.slice(0, 10)) {
      check(`AI 海报 · 标题「${s.title.slice(0, 18)}」`, s.title, seen);
    }
    check("AI 海报 · 页脚存在", "完整正文见笔记", seen);
    check("AI 海报 · 无生图模型残留 score 字段", "score:", seen, true);
    console.log(`  AI 海报：${pngFileLine(outDir, "ai.png")}`);
  }

  await rm(outDir, { recursive: true, force: true }).catch(() => {});

  const failed = results.filter((r) => !r.ok);
  console.log(`\n检查 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const f of failed) {
    console.log(`  ✗ ${f.label}${f.forbid ? `（不应出现：${f.expected}）` : `（未找到：${f.expected}）`}`);
  }
  console.log(failed.length === 0 ? "\nRESULT=OK" : "\nRESULT=FAIL");
  process.exit(failed.length === 0 ? 0 : 1);
}

function pngFileLine(dir, name) {
  return path.join(dir, name);
}

main().catch((err) => {
  console.error(`verify-poster 失败：${err?.message || err}`);
  process.exit(2);
});
