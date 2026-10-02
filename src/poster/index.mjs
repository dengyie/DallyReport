// Poster entry points. This is the module run.mjs talks to.
//
// The contract is deliberately the same shape the diffusion path used —
// generate a PNG, write it beside the note, report {ok, name, summary, error}
// — so switching the pipeline did not also mean rewriting the caller. What
// changed is where the pixels come from: a real typesetting engine that can be
// asked to print a column header once instead of ten times, and that renders
// 美元 as 美元 every single time.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderHtmlToPng, PosterRenderError } from "./shot.mjs";
import { githubPosterHtml, GITHUB_POSTER_SIZE, GITHUB_POSTER_MAX_ROWS } from "./github.mjs";
import {
  aiPosterHtml,
  buildStories,
  buildStoriesFromBody,
  AI_POSTER_SIZE,
} from "./ai.mjs";
import { resolveStoryCap } from "./period.mjs";
import { localizeRepos } from "./translate.mjs";

export { PosterRenderError, GITHUB_POSTER_MAX_ROWS };
export {
  githubPosterHtml,
  aiPosterHtml,
  renderHtmlToPng,
  buildStories,
  buildStoriesFromBody,
};

function fail(name, error) {
  return {
    ok: false,
    name,
    summary: `海报渲染失败（${error?.code || error?.name || "ERROR"}）`,
    error: error?.message || String(error),
    usedFallback: false,
  };
}

/**
 * Render the GitHub trending poster.
 *
 * A refusal here is loud on purpose. The diffusion path could be handed a
 * template with no rows in it and would cheerfully paint a ranking from
 * training memory; `hasGithubPosterRows` exists to stop that. Here an empty
 * list is still refused, because an empty poster and a poster full of invented
 * repositories are the same failure from the reader's side.
 */
export async function renderGithubPoster({ config, repos, deps = {} }) {
  const name = "GitHubPoster";
  try {
    if (!Array.isArray(repos) || repos.length === 0) {
      return { ok: false, name, summary: "skipped (无仓库数据)", error: "IMG_NO_ROWS", usedFallback: false };
    }
    // Descriptions are third-party English. Translating them is a courtesy, not
    // a requirement: localizeRepos never throws and never drops a row, so a
    // missing credential yields an English poster rather than no poster.
    const localized = deps.skipTranslation ? repos : await localizeRepos(repos, { fetch: deps.fetch });
    const html = githubPosterHtml({
      repos: localized,
      period: deps.period,
      maxRows: GITHUB_POSTER_MAX_ROWS,
    });
    const png = await renderHtmlToPng(html, { ...GITHUB_POSTER_SIZE, deps });
    const outFile = path.join(config.obsidianDir, config.date, deps.outputFile);
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, png);
    return {
      ok: true,
      name,
      // `file` is the field the caller has always read; the summary is now a
      // statement about CONTENT ("10 of 18 rows") rather than about transport
      // ("375058 bytes, edits with reference image"), because that is the part
      // a reader of the log can act on.
      summary: `success (${Math.min(repos.length, GITHUB_POSTER_MAX_ROWS)}/${repos.length} 行, ${png.length} bytes, 确定性渲染)`,
      file: outFile,
      error: null,
    };
  } catch (err) {
    return fail(name, err);
  }
}

/** Render the AI news poster. Same contract as above. */
export async function renderAiPoster({ config, stories, deps = {} }) {
  const name = "AIPoster";
  try {
    const usable = (stories || []).filter((s) => s && s.title);
    if (usable.length === 0) {
      return { ok: false, name, summary: "skipped (无有效新闻标题)", error: "IMG_NO_HEADLINES", usedFallback: false };
    }
    const html = aiPosterHtml({ stories: usable, period: deps.period });
    const png = await renderHtmlToPng(html, { ...AI_POSTER_SIZE, deps });
    const outFile = path.join(config.obsidianDir, config.date, deps.outputFile);
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, png);
    const cap = resolveStoryCap(deps.period);
    return {
      ok: true,
      name,
      summary: `success (${Math.min(usable.length, cap)}/${usable.length} 条, ${png.length} bytes, 确定性渲染)`,
      file: outFile,
      error: null,
    };
  } catch (err) {
    return fail(name, err);
  }
}
