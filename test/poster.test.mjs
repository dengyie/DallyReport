// Deterministic poster rendering.
//
// These tests assert on the MARKUP, not on pixels. That is the whole point of
// the change: the previous pipeline produced a PNG by asking a diffusion model
// to typeset it, so the only possible check was a human looking at the image —
// which is how a poster shipped with ten repeated "今日 Star" headers, an
// invented Fork column, a 10-of-15 list presented as complete, and Chinese
// glyphs that OCR identically wrong at 2x and 4x (教据源, 记亿系统, 框织).
//
// Rendering to pixels is covered separately by scripts/verify-poster.mjs, which
// renders both posters from real vault data and OCRs the result back. That step
// needs a browser, so it is not part of the unit suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { escapeHtml, posterShell, POSTER_WIDTH, POSTER_HEIGHT } from "../src/poster/html.mjs";
import { githubPosterHtml, GITHUB_POSTER_MAX_ROWS, formatCount } from "../src/poster/github.mjs";
import { aiPosterHtml, buildStories, buildStoriesFromBody, BODY_TITLE_MAX, AI_POSTER_MAX_STORIES, AI_WEEKLY_POSTER_MAX_STORIES } from "../src/poster/ai.mjs";
import { buildChromeArgs, renderHtmlToPng, PosterRenderError } from "../src/poster/shot.mjs";
import { parseTranslationLines, translateToChinese } from "../src/poster/translate.mjs";

const WEEKLY = {
  weekly: true,
  label: "2026-09-19 ~ 2026-09-25",
  starWord: "本周新增",
  sortNote: "按本周新增 Star 排序",
  sourceNote: "GitHub Trending Weekly",
  maxRows: 10,
};

function repos(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    repo: `owner${i}/repo${i}`,
    starsToday: 1000 - i,
    starsTotal: 100000 - i,
    description: `Description number ${i}`,
    ...over,
  }));
}

// --- escaping -------------------------------------------------------------

test("escapeHtml: neutralises every character that could open a tag", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("a & b"), "a &amp; b", "the ampersand must be escaped FIRST or it double-escapes");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("a repo description is data, never markup", () => {
  // The `description` field is authored verbatim by whoever owns the repository.
  // It reaches the poster through HTML now, so it is the one field where an
  // escaping regression would be a real injection rather than a layout bug.
  const hostile = repos(1, { description: `<img src=x onerror="alert(1)">`, repo: `o/r"onload="x` })[0];
  const html = githubPosterHtml({ repos: [hostile], period: WEEKLY });
  assert.ok(!html.includes("<img src=x"), "raw tag must not survive into the document");
  assert.ok(!html.includes('onload="x'), "an attribute break-out must not survive");
  assert.ok(html.includes("&lt;img src=x"), "it is still SHOWN, as text");
});

test("a story title is data, never markup", () => {
  const html = aiPosterHtml({
    stories: [{ title: `<b>粗体</b>`, summary: "x" }],
    period: WEEKLY,
  });
  assert.ok(!html.includes("<b>粗体</b>"), "no markup from a headline");
  assert.ok(html.includes("&lt;b&gt;粗体&lt;/b&gt;"));
});

// --- GitHub poster --------------------------------------------------------

test("githubPosterHtml: no grid track has an auto minimum, so a long name cannot push a column out of the row", () => {
  // `1fr` is `minmax(auto, 1fr)`, and that auto minimum is the CONTENT's
  // min-content width. A long owner/repo therefore widens the middle track and
  // shoves both fixed numeric columns past the row's right edge, where
  // `.row { overflow: hidden }` silently eats them. Measured at 90 characters:
  // the TOTAL column began at x=1575 in a row box that ends at x=1528, so the
  // whole column was gone while the log still said success.
  const html = githubPosterHtml({ repos: repos(10, { repo: "x".repeat(90) }), period: WEEKLY });
  const declarations = [...html.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(declarations.length >= 2, `expected the head and row rules, found ${declarations.length}`);
  for (const decl of declarations) {
    assert.ok(!/(?:^|\s)1fr(?:\s|$)/.test(decl), `bare 1fr carries an auto minimum: ${decl}`);
  }
  // The middle track has to be allowed to reach zero, or there is nothing for
  // the clip below to clip against.
  assert.match(html, /minmax\(0, 1fr\)/, "the flexible track must be minmax(0, 1fr)");
  assert.match(
    html,
    /\.repo \{[^}]*text-overflow: ellipsis;/,
    "an over-long repo name must be marked with an ellipsis, not sliced off at the row edge",
  );
});

test("githubPosterHtml: the star column header appears exactly ONCE", () => {
  // The specific regression this replaces: the old template asked for a
  // 今日 Star / 总 Star / Fork card on every row, and the delivered 2026-09-25
  // poster printed 今日 Star ten times.
  const html = githubPosterHtml({ repos: repos(10), period: WEEKLY });
  const count = (html.match(/本周新增/g) || []).length;
  assert.equal(count, 1, `column header must appear once, found ${count}`);
  assert.equal((html.match(/>总 Star</g) || []).length, 1, "and so must the total column");
});

test("githubPosterHtml: every row shares one height, so type cannot collapse", () => {
  // The old template's "1–5 big cards, 6–10 compact list" produced 30px numerals
  // on rows 1–5 and 15px on rows 6–10. One .row rule, no per-index variant.
  const html = githubPosterHtml({ repos: repos(10), period: WEEKLY });
  assert.equal((html.match(/class="row"/g) || []).length, 10);
  assert.ok(!html.includes("row top"), "no first-five variant class exists");
  assert.ok(!html.includes("compact"), "no compact variant class exists");
});

test("githubPosterHtml: a weekly says 本周 everywhere and 今日 nowhere", () => {
  const html = githubPosterHtml({ repos: repos(10), period: WEEKLY });
  assert.match(html, /本周新增/);
  assert.match(html, /本周热门仓库/);
  assert.match(html, /2026-09-19 ~ 2026-09-25/);
  assert.doesNotMatch(html, /今日/, "a weekly poster must never say 今日");
  assert.doesNotMatch(html, /DAILY|Daily/, "nor carry daily branding");
});

test("githubPosterHtml: a daily poster is unchanged in wording", () => {
  const html = githubPosterHtml({
    repos: repos(3),
    period: { weekly: false, label: "2026-09-27", starWord: "今日 Star", sourceNote: "GitHub Trending Daily" },
  });
  assert.match(html, /今日 Star/);
  assert.match(html, /今日热门仓库/);
  assert.match(html, /GitHub Trending Daily/);
});

test("githubPosterHtml: a truncated list says so, with both counts", () => {
  // 18 repos collected, 10 rendered. A footer claiming "Top 10" with no
  // acknowledgement of the other 8 is indistinguishable from a complete list.
  const html = githubPosterHtml({ repos: repos(18), period: WEEKLY });
  assert.match(html, /共 18 个项目/);
  assert.match(html, /显示前 10 名/);
  assert.match(html, /另有 8 个见笔记/);
});

test("githubPosterHtml: a list that fits does not claim a truncation", () => {
  const html = githubPosterHtml({ repos: repos(4), period: WEEKLY });
  assert.doesNotMatch(html, /另有|显示前/);
  assert.match(html, /共 4 个项目/);
});

test("githubPosterHtml: rows are capped at GITHUB_POSTER_MAX_ROWS", () => {
  const html = githubPosterHtml({ repos: repos(40), period: WEEKLY });
  assert.equal((html.match(/class="row"/g) || []).length, GITHUB_POSTER_MAX_ROWS);
});

test("githubPosterHtml: a missing total-star count prints no cell", () => {
  // An empty numeric cell is a slot for the renderer to fill. The diffusion
  // path printed "—" there and the poster duly grew Fork figures GitHub never
  // published; the deterministic path simply has nothing to print.
  const html = githubPosterHtml({
    repos: [{ repo: "a/b", starsToday: 5, starsTotal: null, description: null }],
    period: WEEKLY,
  });
  assert.match(html, /a\/b/);
  const cells = [...html.matchAll(/<div class="total">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.equal(cells.length, 1, "one data cell for the row");
  assert.equal(cells[0], "", "it is empty — there is nothing to put in it");
  // Scoped to the rendered rows, not the whole file: an em-dash inside a CSS
  // comment is prose, an em-dash inside a data cell is a placeholder waiting to
  // be invented into.
  const rowsBlock = html.slice(html.indexOf('<div class="rows">'), html.indexOf("</div>\n      <div class=\"rule\""));
  assert.doesNotMatch(rowsBlock, /\u2014/, "no em-dash placeholder in any rendered row");
});

test("formatCount: null in, null out — never a zero or a dash", () => {
  assert.equal(formatCount(1234), "1,234");
  assert.equal(formatCount(null), null);
  assert.equal(formatCount(undefined), null);
  assert.equal(formatCount(0), "0", "a real zero is data, not a missing value");
});

// --- AI poster ------------------------------------------------------------

test("aiPosterHtml: a weekly carries the week's own branding", () => {
  const html = aiPosterHtml({ stories: [{ title: "甲" }], period: WEEKLY });
  assert.match(html, /本周 AI 要闻/);
  assert.match(html, /2026-09-19 ~ 2026-09-25/);
  assert.doesNotMatch(html, /日报|每日|DAILY|Daily/);
});

test("aiPosterHtml: the story cap fits the frame, and is the same in HTML and code", () => {
  // 12 stories is what the diffusion poster nominally carried, and it is how
  // that poster ended up reprinting some stories while dropping Copilot and
  // WSO2 entirely. The cap here is set by what fits at a readable size.
  assert.equal(AI_WEEKLY_POSTER_MAX_STORIES, 10);
  assert.equal(AI_POSTER_MAX_STORIES, 8);
  const weekly = aiPosterHtml({ stories: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}` })), period: WEEKLY });
  assert.equal((weekly.match(/class="story"/g) || []).length, AI_WEEKLY_POSTER_MAX_STORIES);
  const daily = aiPosterHtml({
    stories: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}` })),
    period: { weekly: false, label: "2026-09-27" },
  });
  assert.equal((daily.match(/class="story"/g) || []).length, AI_POSTER_MAX_STORIES);
});

test("aiPosterHtml: no invented section headings", () => {
  // The delivered poster carried panels titled 定价与性价比动态 and
  // 知识库更新记录 — neither is a news category, and neither had a story in
  // it. Here the only headings are the ones the data implies.
  const html = aiPosterHtml({ stories: [{ title: "甲", summary: "乙" }], period: WEEKLY });
  assert.ok(!html.includes("定价"), "no pricing panel without a pricing story");
  assert.ok(!html.includes("知识库更新"), "no changelog panel at all");
});

test("aiPosterHtml: a story with no summary simply has no summary line", () => {
  const html = aiPosterHtml({ stories: [{ title: "只有标题" }], period: WEEKLY });
  assert.match(html, /只有标题/);
  assert.equal((html.match(/class="story-sum"/g) || []).length, 0, "the CSS rule is not a rendered summary");
});

test("aiPosterHtml: stories fill column-first, so the left column is the top of the list", () => {
  const stories = Array.from({ length: 4 }, (_, i) => ({ title: `T${i}` }));
  const html = aiPosterHtml({ stories, period: WEEKLY });
  const order = [...html.matchAll(/T(\d)/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [0, 1, 2, 3], "reading order down the columns is the ranked order");
});

test("aiPosterHtml: an empty story list still produces a valid document", () => {
  const html = aiPosterHtml({ stories: [], period: WEEKLY });
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.match(html, /本期没有可渲染的新闻/);
});

// --- shell ----------------------------------------------------------------

test("posterShell: emits a complete, UTF-8, fixed-size document", () => {
  const html = posterShell({ title: "标题", bodyHtml: "<p>x</p>" });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.ok(html.includes(`${POSTER_WIDTH}px`), "the frame width is declared, not assumed");
  assert.ok(html.includes(`${POSTER_HEIGHT}px`));
  assert.match(html, /<title>标题<\/title>/);
});

// --- shot.mjs -------------------------------------------------------------

test("buildChromeArgs: renders headless, at 2x, at an explicit size", () => {
  const args = buildChromeArgs({ htmlPath: "/tmp/a.html", outPath: "/tmp/a.png", width: 1600, height: 900 });
  assert.ok(args.includes("--headless=new"), "must not need a display");
  assert.ok(args.includes("--force-device-scale-factor=2"), "2x keeps CJK glyphs on whole pixels");
  assert.ok(args.includes("--window-size=1600,900"));
  assert.equal(args.at(-1), pathToFileURL("/tmp/a.html").href);
  assert.ok(!args.some((a) => a.startsWith("--user-data-dir")), "no profile is touched");
});

test("buildChromeArgs: a Windows path becomes a file URL Chrome can load", () => {
  const htmlPath = "C:\\Users\\mango\\AppData\\Local\\Temp\\dally-poster-x\\poster.html";
  const args = buildChromeArgs({ htmlPath, outPath: "C:\\Temp\\poster.png", width: 1600, height: 900 });
  const url = args.at(-1);
  assert.equal(url, pathToFileURL(htmlPath).href);
  assert.ok(!url.includes("\\"), "a backslash in a file URL is not a path separator");
  assert.ok(!args.some((a) => a.startsWith("--user-data-dir")), "must not lock the 9222 login profile");
  if (process.platform === "win32") {
    assert.equal(url, "file:///C:/Users/mango/AppData/Local/Temp/dally-poster-x/poster.html");
  }
});

test("buildChromeArgs: no cross-file permission is granted, because nothing is loaded", () => {
  // The generated document has no subresource — no url(), no @import, no
  // script, no link. `--allow-file-access-from-files` would relax the browser's
  // file:// boundary for a page that reads nothing.
  const args = buildChromeArgs({ htmlPath: "/tmp/a.html", outPath: "/tmp/a.png", width: 1600, height: 900 });
  assert.ok(
    !args.includes("--allow-file-access-from-files"),
    "no permission may be granted that no part of the document needs",
  );
});

// A PNG header is 33 bytes: 8-byte signature, then an IHDR chunk whose width
// and height live at fixed big-endian offsets 16..20 and 20..24.
function pngHeader(w, h) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

function chromeWriting(bytes) {
  return async (_bin, args) => {
    const shot = args.find((a) => a.startsWith("--screenshot="));
    if (shot) await writeFile(shot.slice("--screenshot=".length), bytes);
  };
}

test("renderHtmlToPng: a PNG of the wrong size is a loud failure, not a shipped poster", () => {
  // The failure this prevents: 100x100 was asked for, 200x50 came back. Every
  // other check passed — it is a real PNG, just not the one we specified — so it
  // used to be written into the vault stretched, with the log still reading
  // "success (... bytes, 确定性渲染)".
  const deps = { chromeBin: "/bin/true", spawnFn: chromeWriting(pngHeader(200, 50)) };
  return assert.rejects(
    () => renderHtmlToPng("<html></html>", { width: 100, height: 100, scale: 1, deps }),
    (err) => err instanceof PosterRenderError && err.code === "POSTER_BAD_DIM",
  );
});

test("renderHtmlToPng: the expected pixel size is width x height x scale", () => {
  // 1600x900 at 2x is the whole point of DEVICE_SCALE: a 1x poster looks soft
  // next to itself in Obsidian, so a silently dropped scale must fail too.
  const deps = { chromeBin: "/bin/true", spawnFn: chromeWriting(pngHeader(3200, 1800)) };
  return renderHtmlToPng("<html></html>", { width: 1600, height: 900, scale: 2, deps }).then((buf) => {
    assert.equal(buf.length, 33);
  });
});

test("renderHtmlToPng: a buffer too short to hold a header is classified, not a RangeError", () => {
  // Reading the IHDR offsets of a 4-byte file throws ERR_OUT_OF_RANGE out of
  // node:buffer, which would escape as a non-PosterRenderError and land in the
  // log as a stack rather than a code.
  const deps = { chromeBin: "/bin/true", spawnFn: chromeWriting(Buffer.from([0x89, 0x50, 0x4e, 0x47])) };
  return assert.rejects(
    () => renderHtmlToPng("<html></html>", { width: 100, height: 100, scale: 1, deps }),
    (err) => err instanceof PosterRenderError && err.code === "POSTER_TRUNCATED_PNG",
  );
});

test("renderHtmlToPng: rejects a nonsense size before spawning anything", () => {
  return assert.rejects(
    () => renderHtmlToPng("<html></html>", { width: 0, height: 900, deps: { chromeBin: "/bin/true" } }),
    (err) => err instanceof PosterRenderError && err.code === "POSTER_BAD_SIZE",
  );
});

test("renderHtmlToPng: a browser that produces nothing is a loud failure", () => {
  // The failure this guards: a poster that silently did not render is
  // indistinguishable from one that rendered blank, and the blank one ships.
  const deps = {
    chromeBin: "/bin/true",
    spawnFn: async () => {}, // exits clean, writes no PNG
  };
  return assert.rejects(
    () => renderHtmlToPng("<html></html>", { width: 100, height: 100, deps }),
    (err) => err instanceof PosterRenderError && err.code === "POSTER_EMPTY_PNG",
  );
});

// --- translation ----------------------------------------------------------

test("parseTranslationLines: strips fences and numbering, keeps order", () => {
  assert.deepEqual(parseTranslationLines("1. 甲\n2. 乙\n3. 丙", 3), ["甲", "乙", "丙"]);
  assert.deepEqual(parseTranslationLines("```\n甲\n乙\n```", 2), ["甲", "乙"]);
  assert.deepEqual(parseTranslationLines("甲\n乙", 3), ["甲", "乙", null], "a short reply leaves gaps, not shifts");
});

test("parseTranslationLines: a junk line does not shift the numbered entries after it", () => {
  // The failure this prevents is a wrong FACT, not a cosmetic one: if "—" is
  // dropped positionally, 丙 lands on input 2 and the poster attributes one
  // repository's description to another.
  assert.deepEqual(parseTranslationLines("1. 甲\n—\n3. 丙", 3), ["甲", null, "丙"]);
  assert.deepEqual(parseTranslationLines("1. 甲\n2. \n3. 丙", 3), ["甲", null, "丙"]);
});

test("translateToChinese: without credentials the English survives untouched", () => {
  const saved = { url: process.env.GROK_API_URL, key: process.env.GROK_API_KEY };
  delete process.env.GROK_API_URL;
  delete process.env.GROK_API_KEY;
  return translateToChinese(["An open-source app for agents", "Already 中文", ""])
    .then((out) => {
      assert.deepEqual(out, ["An open-source app for agents", "Already 中文", ""]);
    })
    .finally(() => {
      if (saved.url !== undefined) process.env.GROK_API_URL = saved.url;
      if (saved.key !== undefined) process.env.GROK_API_KEY = saved.key;
    });
});

test("translateToChinese: an all-Chinese batch makes no call at all", () => {
  const saved = { url: process.env.GROK_API_URL, key: process.env.GROK_API_KEY };
  process.env.GROK_API_URL = "https://api.test";
  process.env.GROK_API_KEY = "k";
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    throw new Error("should not be reached");
  };
  return translateToChinese(["全是中文", "已经翻译好了"], { fetch: fetchImpl })
    .then((out) => {
      assert.equal(called, 0, "no call when there is nothing to translate");
      assert.deepEqual(out, ["全是中文", "已经翻译好了"]);
    })
    .finally(() => {
      if (saved.url === undefined) delete process.env.GROK_API_URL;
      else process.env.GROK_API_URL = saved.url;
      if (saved.key === undefined) delete process.env.GROK_API_KEY;
      else process.env.GROK_API_KEY = saved.key;
    });
});

test("translateToChinese: a failed call degrades to English, it does not throw", () => {
  const saved = { url: process.env.GROK_API_URL, key: process.env.GROK_API_KEY };
  process.env.GROK_API_URL = "https://api.test";
  process.env.GROK_API_KEY = "k";
  const fetchImpl = async () => {
    throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
  };
  return translateToChinese(["English one", "English two"], { fetch: fetchImpl })
    .then((out) => {
      assert.deepEqual(out, ["English one", "English two"], "an outage must not cost a poster");
    })
    .finally(() => {
      if (saved.url === undefined) delete process.env.GROK_API_URL;
      else process.env.GROK_API_URL = saved.url;
      if (saved.key === undefined) delete process.env.GROK_API_KEY;
      else process.env.GROK_API_KEY = saved.key;
    });
});

test("translateToChinese: a reply identical to the input is not accepted as a translation", () => {
  const saved = { url: process.env.GROK_API_URL, key: process.env.GROK_API_KEY };
  process.env.GROK_API_URL = "https://api.test";
  process.env.GROK_API_KEY = "k";
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "English one\nEnglish one" } }] }),
  });
  return translateToChinese(["English one"], { fetch: fetchImpl })
    .then((out) => {
      assert.deepEqual(out, ["English one"]);
    })
    .finally(() => {
      if (saved.url === undefined) delete process.env.GROK_API_URL;
      else process.env.GROK_API_URL = saved.url;
      if (saved.key === undefined) delete process.env.GROK_API_KEY;
      else process.env.GROK_API_KEY = saved.key;
    });
});

// --- source cards are the fallback, so they are covered too ----------------
//
// buildStories is NOT dead code: run.mjs:345 falls back to it whenever the note
// body yields fewer than three bullets, which is exactly the degraded case. The
// shapes below run on a fallback poster, so they are production behaviour.

test("buildStories: a source card is third-party text all the way to the document", () => {
  // The card's title is authored verbatim by whoever owns the repository. It is
  // sanitised for injection but not for markup — escaping happens at the HTML
  // layer — so the chain has to be tested end to end, not per stage.
  const stories = buildStories([{ title: `<img src=x onerror="alert(1)">`, snippet: "y" }], {
    period: { weekly: true },
  });
  const html = aiPosterHtml({ stories, period: WEEKLY });
  assert.ok(!html.includes("<img src=x"), "raw tag must not survive into the document");
  assert.ok(!html.includes('onerror="alert'), "an attribute break-out must not survive");
  assert.ok(html.includes("&lt;img src=x"), "it is still SHOWN, as text");
});

test("buildStories: a summary stops at the first sentence", () => {
  const [story] = buildStories([{ title: "甲", snippet: "第一句。第二句。" }], { period: { weekly: true } });
  assert.equal(story.summary, "第一句。", "the poster has one line for this; the tail is not it");
});

test("buildStories: a snippet that only repeats the headline produces no summary", () => {
  // "同题" vs "同题。" is the exact case that defeated a plain !== compare: the
  // trailing full stop is punctuation, not information.
  const [story] = buildStories([{ title: "同题", snippet: "同题。" }], { period: { weekly: true } });
  assert.equal(story.summary, "", "printing the headline twice is the defect, not information");
});

test("buildStories: an untitled card is skipped rather than rendered blank", () => {
  assert.deepEqual(buildStories([{ title: "", snippet: "x" }, { title: "   ", snippet: "y" }], { period: { weekly: true } }), []);
  assert.deepEqual(buildStories([null, undefined], { period: { weekly: true } }), []);
});

test("buildStories: the fallback path is capped by mode too", () => {
  // If the cap is only honoured on the body path, a degraded run silently ships
  // a twenty-story poster that overflows the 900px frame.
  const cards = Array.from({ length: 14 }, (_, i) => ({ title: `T${i}`, snippet: `S${i}` }));
  assert.equal(buildStories(cards, { period: { weekly: true } }).length, AI_WEEKLY_POSTER_MAX_STORIES);
  assert.equal(buildStories(cards, { period: { weekly: false } }).length, AI_POSTER_MAX_STORIES);
  assert.equal(buildStories(cards, { period: { weekly: true }, maxStories: 3 }).length, 3);
});

// --- the note body is the poster's input ---------------------------------
//
// The delivered 2026-09-25 weekly makes the reason concrete. Its 15 cited
// sources are raw third-party headlines — 8 of the first 12 in English, plus
// forum register — while the same note's body already states every event as a
// finished Chinese sentence. These tests pin the shaping, not the wording.

const MERGED_WEEKLY_BULLET =
  "* **Anthropic 创始人寻求投票控制权与公司动态**：为即将到来的首次公开募股（IPO）做准备，Anthropic 的创始人正在积极寻求公司的投票控制权 [19]。" +
  "同时，该公司的一项关于基因编辑的研究引发讨论，其生命科学团队利用人工智能筛选海量 DNA 数据集并自主发现了一种与 DNA 序列相关的新酶系统 [4]。";

test("buildStoriesFromBody: an over-merged bullet becomes separate poster slots", () => {
  const stories = buildStoriesFromBody(MERGED_WEEKLY_BULLET, { period: { weekly: true } });
  assert.equal(stories.length, 2, `expected 2 stories, got ${JSON.stringify(stories)}`);
  assert.equal(stories[0].title, "Anthropic 创始人寻求投票控制权与公司动态");
  assert.ok(
    stories[1].title.startsWith("该公司的一项关于基因编辑的研究引发讨论"),
    `the split-off story needs a headline of its own, got ${stories[1].title}`
  );
});

test("buildStoriesFromBody: a headline is cut at a claim boundary, not a character count", () => {
  // The headline column is 700px and a 22px CJK glyph is 22.0px, so 31
  // characters fit on one line; the cap is 30. The first attempt sliced mid
  // word — "…并自主发现了一种与 DNA 序" — with nothing to show it was cut.
  const stories = buildStoriesFromBody(MERGED_WEEKLY_BULLET, { period: { weekly: true } });
  for (const s of stories) {
    // +1 for the ellipsis a marked cut spends; 31 CJK glyphs is 682px in a
    // 700px column, so the widest headline is still one line.
    assert.ok(
      s.title.length <= BODY_TITLE_MAX + 1,
      `headline must stay one line, got ${s.title.length}: ${s.title}`
    );
    assert.ok(!s.title.includes("，其生命科学团队"), `cut at a clause, got ${s.title}`);
  }
  assert.equal(stories[1].title, "该公司的一项关于基因编辑的研究引发讨论");
  assert.ok(stories[1].summary.length > 0, "the rest of the paragraph is the summary, not lost");
  assert.ok(!stories[1].summary.includes("同时，"), "the connective belongs to neither slot");
});

test("buildStoriesFromBody: an uncuttable headline is marked as abridged", () => {
  // No clause boundary inside the cap, so the cut has to be visible. A label
  // silently sliced off reads as a whole one.
  const [story] = buildStoriesFromBody("* **标题**：一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一。", {
    period: { weekly: true },
  });
  // The model gave this one a headline, so it is the headline under test; make
  // the over-long headline the untitled case instead.
  const untitled = buildStoriesFromBody("* 一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一。", {
    period: { weekly: true },
  });
  assert.ok(untitled[0].title.endsWith("…"), `expected a marked cut, got ${untitled[0].title}`);
  assert.ok(untitled[0].title.length <= BODY_TITLE_MAX + 1);
  assert.ok(untitled[0].summary.length > 0, "the cut tail is demoted, not deleted");
  assert.equal(story.title, "标题");
});

test("buildStoriesFromBody: a summary that repeats the title is dropped", () => {
  const [story] = buildStoriesFromBody("* **同题**：同题 [1]。", { period: { weekly: true } });
  assert.equal(story.summary, "", "printing the headline twice is the defect, not information");
});

test("buildStoriesFromBody: the reference list is never rendered as a story", () => {
  const doc = ["* **真要点**：真的内容 [1]。", "", "### 参考来源", "", "- [1] [A](<https://a.test>)"].join("\n");
  const stories = buildStoriesFromBody(doc, { period: { weekly: true } });
  assert.equal(stories.length, 1);
  assert.equal(stories[0].title, "真要点");
});

test("buildStoriesFromBody: weekly and daily use different caps", () => {
  const bullets = Array.from({ length: 14 }, (_, i) => `* **标题${i}**：正文 ${i} [${i + 1}]。`).join("\n");
  assert.equal(buildStoriesFromBody(bullets, { period: { weekly: true } }).length, AI_WEEKLY_POSTER_MAX_STORIES);
  assert.equal(buildStoriesFromBody(bullets, { period: { weekly: false } }).length, AI_POSTER_MAX_STORIES);
});

test("buildStoriesFromBody: no body yields no stories rather than invented ones", () => {
  assert.deepEqual(buildStoriesFromBody("", {}), []);
  assert.deepEqual(buildStoriesFromBody(null, {}), []);
  assert.deepEqual(buildStoriesFromBody("（模型未返回正文内容）", {}), []);
});
