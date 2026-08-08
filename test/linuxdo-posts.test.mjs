import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cookedToMarkdown,
  extractAttachments,
  attachmentKey,
  enrichLinuxdoPosts,
  downloadAttachmentAsset,
} from "../src/linuxdo.mjs";

const IMG_ORIG = "https://cdn3.ldstatic.com/original/4X/3/5/c/35cab35942d147a12df3c18a806afa15045af2e7.png";
const IMG_ORIG2 = "https://cdn3.ldstatic.com/original/4X/1/2/3/abcdef123456789.png";
const IMG_ORIG3 =
  "https://cdn3.ldstatic.com/original/4X/9/8/7/0123456789012345678901234567890123456789.png";
// The resized variant Discourse emits for the SAME upload as IMG_ORIG (same 40-hex
// stem + `_2_500x500`): must dedup to the full-res original, not be downloaded too.
const IMG_OPT =
  "https://cdn3.ldstatic.com/optimized/4X/3/5/c/35cab35942d147a12df3c18a806afa15045af2e7_2_500x500.png";

function cookedHtml() {
  return `<div>
<script>alert("injected")</script>
<nav>社区准则 真诚 友善</nav>
<p><strong>重要：</strong>DeepSeek V4 Flash 正式版 API 已上线公测，推理成本大幅下降，开发者体验全面升级。</p>
<p>这是第二段完整正文，包含足够的实质内容供人阅读。</p>
<img src="${IMG_ORIG}" alt="截图">
<p><a class="attachment" href="https://linux.do/uploads/example/1/report.pdf">报告.pdf</a></p>
<p><a href="https://linux.do/t/topic/123">论坛链接</a></p>
</html>`;
}

test("cookedToMarkdown: drops script/nav, keeps prose, converts img+links", () => {
  const md = cookedToMarkdown(cookedHtml());
  assert.doesNotMatch(md, /script|inject/i);
  assert.doesNotMatch(md, /真诚|友善/);
  assert.match(md, /DeepSeek V4 Flash 正式版 API 已上线公测/);
  assert.match(md, /这是第二段完整正文/);
  assert.match(md, /!\[附件\]\(/); // image emitted as markdown
});

test("cookedToMarkdown: rewrite maps CDN srcs to local attachment paths", () => {
  const md = cookedToMarkdown(cookedHtml(), {
    rewrite: (u) => (u === IMG_ORIG ? "../linuxdo-attachments/10/abc.png" : null),
  });
  assert.match(md, /!\[附件\]\(\.\.\/linuxdo-attachments\/10\/abc\.png\)/);
});

test("extractAttachments: collects unique images + file attachments in order", () => {
  const list = extractAttachments(cookedHtml());
  const urls = list.map((a) => a.url);
  assert.ok(urls.includes(IMG_ORIG), "original png should be collected");
  assert.ok(list.some((a) => a.kind === "file" && a.basename.endsWith(".pdf")), "pdf attachment collected");
  // Same url appearing twice collapses to one; order preserved.
  const dupHtml = cookedHtml() + `<img src="${IMG_ORIG2}"><img src="${IMG_ORIG2}">`;
  const list2 = extractAttachments(dupHtml);
  assert.equal(list2.filter((a) => a.url === IMG_ORIG2).length, 1, "duplicate should collapse");
  assert.equal(list2.length, list.length + 1);
});

function makeTopicJson(title, cookedArr) {
  return JSON.stringify({
    title,
    created_at: "2026-08-07T00:00:00Z",
    post_stream: { posts: cookedArr.map((cooked) => ({ cooked })) },
  });
}

test("enrichLinuxdoPosts: writes full post md + downloads attachments into vault folders", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoDownloadAttachments: true,
    linuxdoFullPostsLimit: 40,
    linuxdoAttachMaxPerPost: 20,
    linuxdoAttachMaxBytesPerPost: 20 * 1024 * 1024,
  };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "DeepSeek 发布", created_at: "2026-08-07T00:00:00Z" }];
  const fetchTopic = async () =>
    makeTopicJson("DeepSeek 发布", [
      `<p>DeepSeek <strong>V4</strong> Flash 正式版 API 已上线公测。</p><img src="${IMG_ORIG}">`,
    ]);
  const download = async (_url, dest) => { writeFileSync(dest, "x", "utf8"); return { bytes: 1 }; };

  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download });
  assert.equal(out.length, 1, "one post enriched");
  const rec = out[0];
  assert.equal(rec.id, 10);
  // Full post md exists under linuxdo-posts/.
  const postFile = path.join(tmp, "2026-08-07", "linuxdo-posts", path.basename(rec.postFile));
  assert.ok(existsSync(postFile), "full post markdown written");
  const md = readFileSync(postFile, "utf8");
  assert.match(md, /API 已上线公测/);
  assert.match(md, /DeepSeek/);
  // Attachment downloaded under linuxdo-attachments/<id>/.
  assert.equal(rec.attachments.length, 1);
  const attachFile = path.join(tmp, "2026-08-07", rec.attachments[0].local);
  assert.ok(existsSync(attachFile), "attachment downloaded");
  // Post md references the local attachment via relative path (post file lives
  // one level deeper in linuxdo-posts/, so it needs the ../ prefix to resolve
  // its sibling linuxdo-attachments/ dir).
  assert.match(md, /\.\.\/linuxdo-attachments\/10\//);
  // Embed is a vault-root embed line for Obsidian.
  assert.match(rec.embed, /^!\[\[2026-08-07\/linuxdo-posts\/10-.*\.md\]\]$/);
  rmSync(tmp, { recursive: true, force: true });
});

test("enrichLinuxdoPosts: honors fullPostsLimit (caps fan-out)", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-limit-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoFullPostsLimit: 1,
    linuxdoDownloadAttachments: false,
  };
  const cards = [
    { id: 10, url: "https://linux.do/t/topic/10", title: "A" },
    { id: 11, url: "https://linux.do/t/topic/11", title: "B" },
  ];
  const fetchTopic = async (id) => JSON.stringify({ title: `T${id}`, post_stream: { posts: [{ cooked: `<p>正文 ${id}</p>` }] } });
  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download: async () => null });
  assert.equal(out.length, 1);
  rmSync(tmp, { recursive: true, force: true });
});

test("enrichLinuxPosts: no cookie / browser — fetchTopic null -> silently skipped", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-null-"));
  const config = { date: "2026-08-07", obsidianDir: tmp, linuxdoFullPosts: true };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "A" }];
  const fetchTopic = async () => null;
  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download: async () => null });
  assert.equal(out.length, 0);
  rmSync(tmp, { recursive: true, force: true });
});

// --- post-review fixes: dedup + budget + gates ---

test("attachmentKey: collapses Discourse resize suffixes to the identity stem", () => {
  const stem = "35cab35942d147a12df3c18a806afa15045af2e7";
  assert.equal(attachmentKey(`${stem}_2_500x500.png`), stem, "hash-named thumbnails collapse to their hash");
  assert.equal(attachmentKey(`${stem}.png`), stem);
  // User-named uploads: a trailing `_<n>_<W>x<H>` / `_<W>x<H>` / `_2x` marker is stripped.
  assert.equal(attachmentKey("report_2_500x500.pdf"), "report.pdf");
  assert.equal(attachmentKey("report_2x_1024x576.jpg"), "report.jpg");
  assert.equal(attachmentKey("report_2x.png"), "report.png");
  assert.equal(attachmentKey("正常的图片.png"), "正常的图片.png");
});

test("extractAttachments: lightbox <a><img> collapses to the original, drops the thumb", () => {
  const list = extractAttachments(`<a href="${IMG_ORIG}"><img src="${IMG_OPT}"></a>`);
  assert.equal(list.length, 1, "resized sibling deduped against its full-res original");
  assert.equal(list[0].url, IMG_ORIG, "the original URL wins");
  assert.equal(list[0].original, true);
  assert.equal(list[0].basename, "35cab35942d147a12df3c18a806afa15045af2e7.png", "kept under the clean name, no _2_500x500");
});

test("enrich: lightbox thread downloads one original; both image srcs rewrite to it", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-lightbox-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoDownloadAttachments: true,
    linuxdoFullPostsLimit: 40,
    linuxdoAttachMaxPerPost: 20,
    linuxdoAttachMaxBytesPerPost: 20 * 1024 * 1024,
  };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "Lightbox", created_at: "2026-08-07T00:00:00Z" }];
  const fetched = [];
  const fetchTopic = async () => {
    return makeTopicJson("Lightbox", [`<p>正文</p><a href="${IMG_ORIG}"><img src="${IMG_OPT}"></a>`])
  };
  const download = async (_url, dest) => { writeFileSync(dest, "x", "utf8"); return { bytes: 1 }; };

  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download });
  assert.equal(out.length, 1);
  assert.equal(out[0].attachments.length, 1, "only the original is archived");
  assert.equal(
    path.basename(out[0].attachments[0].local),
    "35cab35942d147a12df3c18a806afa15045af2e7.png",
    "stored under the original file name (thumb name not used)",
  );
  const md = readFileSync(path.join(tmp, "2026-08-07", "linuxdo-posts", path.basename(out[0].postFile)), "utf8");
  // The optimized <img src> (not downloaded itself) rewrites to the same local original.
  assert.match(
    md,
    /!\[附件\]\(\.\.\/linuxdo-attachments\/10\/35cab35942d147a12df3c18a806afa15045af2e7\.png\)/,
    "optimized src resolves to the archived local original",
  );
  rmSync(tmp, { recursive: true, force: true });
});

test("enrich: withAttachments=false writes the full post but downloads nothing", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-noattach-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoDownloadAttachments: false,
  };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "A" }];
  let downloads = 0;
  const fetchTopic = async () => makeTopicJson("A", [`<p>正文全文足够长</p><img src="${IMG_ORIG}">`]);
  const download = async () => { downloads += 1; return { bytes: 1 }; };

  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download });
  assert.equal(out.length, 1);
  assert.equal(out[0].attachments.length, 0);
  assert.equal(downloads, 0, "no attachments fetched");
  const postFile = path.join(tmp, "2026-08-07", "linuxdo-posts", path.basename(out[0].postFile));
  assert.ok(existsSync(postFile), "full post markdown is still written");
  const attachDir = path.join(tmp, "2026-08-07", "linuxdo-attachments");
  assert.equal(existsSync(attachDir) ? readdirSync(attachDir).length : 0, 0, "no attachment files");
  rmSync(tmp, { recursive: true, force: true });
});

test("enrich: linuxdoFullPosts=false disables fetches entirely", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-off-"));
  const config = { date: "2026-08-07", obsidianDir: tmp, linuxdoFullPosts: false };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "A" }];
  let fetches = 0;
  const fetchTopic = async () => { fetches += 1; return "{}"; };
  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download: async () => null });
  assert.equal(out.length, 0);
  assert.equal(fetches, 0, "disabled → no topic fetched");
  rmSync(tmp, { recursive: true, force: true });
});

test("enrich: byte budget stops pulling files but keeps the over-budget one linked (no orphan)", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-bytes-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoDownloadAttachments: true,
    linuxdoAttachMaxPerPost: 20,
    linuxdoAttachMaxBytesPerPost: 5,
  };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "A" }];
  const fetchTopic = async () =>
    makeTopicJson("A", [`<p>正文</p><img src="${IMG_ORIG}"><img src="${IMG_ORIG2}"><img src="${IMG_ORIG3}">`]);
  const download = async (_url, dest) => { writeFileSync(dest, "xxx", "utf8"); return { bytes: 3 }; };

  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download });
  assert.equal(out[0].attachments.length, 2, "stops fetching once the byte budget is exhausted");
  const total = out[0].attachments.reduce((n, a) => n + a.bytes, 0);
  assert.equal(total, 6, "the file that pushed over budget is still recorded");
  for (const a of out[0].attachments) {
    assert.ok(existsSync(path.join(tmp, "2026-08-07", a.local)), `recorded file exists: ${a.local}`);
  }
  const md = readFileSync(path.join(tmp, "2026-08-07", "linuxdo-posts", path.basename(out[0].postFile)), "utf8");
  assert.ok(md.includes(`- [${path.basename(out[0].attachments[0].local)}]`), "attachment list section still rendered");
  rmSync(tmp, { recursive: true, force: true });
});

test("enrich: a failing topic doesn't drop its siblings (partial success)", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-partial-"));
  const config = { date: "2026-08-07", obsidianDir: tmp, linuxdoFullPosts: true };
  const cards = [
    { id: 10, url: "https://linux.do/t/topic/10", title: "A" },
    { id: 11, url: "https://linux.do/t/topic/11", title: "B" },
  ];
  const fetchTopic = async (id) => {
    if (id === 11) throw new Error("stub: fetch failed for 11");
    return makeTopicJson("A", [`<p>正文足够长十</p>`]);
  };
  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download: async () => null });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 10);
  rmSync(tmp, { recursive: true, force: true });
});

// --- second review pass fixes: host gate, streaming cap, reuse, deadline, continuation ---

test("enrich: external-host img/link is never downloaded (host gate)", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-gate-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoDownloadAttachments: true,
  };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "A" }];
  const fetchedHosts = [];
  const fetchTopic = async () =>
    makeTopicJson("A", [
      `<p>正文</p><img src="https://evil.example.com/steal.png"><a href="https://evil.example.com/report.pdf">pdf</a>`,
    ]);
  const download = async (_u, dest) => { writeFileSync(dest, "x", "utf8"); return { bytes: 1 }; };

  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download });
  assert.equal(out.length, 1);
  assert.equal(out[0].attachments.length, 0, "third-party host files never downloaded");
  // The md still renders them as plain links (readable), just not pulled.
  const md = readFileSync(path.join(tmp, "2026-08-07", "linuxdo-posts", path.basename(out[0].postFile)), "utf8");
  assert.match(md, /steal\.png/);
  const attachDir = path.join(tmp, "2026-08-07", "linuxdo-attachments");
  assert.equal(existsSync(attachDir) ? readdirSync(attachDir).length : 0, 0, "no attachments folder");
  rmSync(tmp, { recursive: true, force: true });
});

test("downloadAttachmentAsset: refuses a single file over maxBytes via Content-Length", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-cap-cl-"));
  const dest = path.join(tmp, "big.bin");
  const fetchImpl = async () =>
    new Response("x".repeat(2048), { status: 200, headers: { "content-length": "2048" } });
  const res = await downloadAttachmentAsset("https://cdn3.ldstatic.com/original/4X/x/big.bin", dest, {
    fetchImpl,
    maxBytes: 100,
  });
  assert.equal(res, null, "over-cap file refused before buffering");
  assert.equal(existsSync(dest), false, "nothing written to disk");
  rmSync(tmp, { recursive: true, force: true });
});

test("downloadAttachmentAsset: streaming counter aborts mid-body when no Content-Length", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-cap-stream-"));
  const dest = path.join(tmp, "big.bin");
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2048));
      controller.enqueue(new Uint8Array(2048));
      controller.close();
    },
    cancel() { canceled = true; },
  });
  const fetchImpl = async () => new Response(body, { status: 200 }); // no content-length header
  const res = await downloadAttachmentAsset("https://cdn3.ldstatic.com/original/4X/x/big.bin", dest, {
    fetchImpl,
    maxBytes: 100,
  });
  assert.equal(res, null, "over-cap stream aborted");
  assert.equal(existsSync(dest), false, "nothing written");
  assert.ok(canceled, "reader canceled as soon as the cap is crossed");
  rmSync(tmp, { recursive: true, force: true });
});

test("enrich: re-run of the same date reuses the on-disk attachment (no re-download)", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-reuse-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoDownloadAttachments: true,
  };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "A" }];
  const fetchTopic = async () => makeTopicJson("A", [`<p>正文</p><img src="${IMG_ORIG}">`]);
  let downloads = 0;
  const download = async (u, dest) => { downloads += 1; writeFileSync(dest, "x", "utf8"); return { bytes: 1 }; };

  const out1 = await enrichLinuxdoPosts(cards, config, { fetchTopic, download });
  assert.equal(out1[0].attachments.length, 1);
  assert.equal(downloads, 1, "first run downloads it");
  const out2 = await enrichLinuxdoPosts(cards, config, { fetchTopic, download });
  assert.equal(out2[0].attachments.length, 1, "second run still reports the attachment");
  assert.equal(downloads, 1, "second run reuses the archived file, no re-fetch");
  rmSync(tmp, { recursive: true, force: true });
});

test("enrich: budget expiry stops scheduling new topics but returns partial results", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-deadline-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoDownloadAttachments: false,
    linuxdoEnrichBudgetMs: 30,
  };
  const cards = [1, 2, 3, 4].map((id) => ({
    id,
    url: `https://linux.do/t/topic/${id}`,
    title: `T${id}`,
  }));
  const fetchTopic = async (id) => {
    await new Promise((r) => setTimeout(r, 80)); // slower than the 30ms budget
    return JSON.stringify({ title: `T${id}`, post_stream: { posts: [{ cooked: `<p>正文 ${id}</p>` }] } });
  };
  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download: async () => null });
  assert.ok(Array.isArray(out), "always returns an array, never throws");
  assert.ok(out.length > 0, "in-flight topics complete and are returned");
  assert.ok(out.length < cards.length, "budget stops scheduling NEW topics past the deadline");
  for (const rec of out) {
    assert.ok(existsSync(path.join(tmp, "2026-08-07", "linuxdo-posts", path.basename(rec.postFile))), `md for ${rec.id}`);
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("enrich: long threads paginate remaining posts and preserve order", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-longthread-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoDownloadAttachments: false,
  };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "A" }];
  // Topic JSON carries the full stream (5 ids) but only 2 posts; the remaining 3
  // come back through fetchTopicPosts (Discourse /posts.json paging).
  const firstPage = {
    title: "长帖",
    post_stream: {
      stream: [101, 102, 103, 104, 105],
      posts: [
        { id: 101, post_number: 1, cooked: "<p>OP</p>" },
        { id: 102, post_number: 2, cooked: "<p>回 2</p>" },
      ],
    },
  };
  const pageCalls = [];
  const fetchTopic = async () => JSON.stringify(firstPage);
  const fetchTopicPosts = async (_id, ids) => {
    pageCalls.push(ids);
    return JSON.stringify({
      post_stream: { posts: ids.map((id) => ({ id, post_number: id - 100, cooked: `<p>回 ${id - 100}</p>` })) },
    });
  };
  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, fetchTopicPosts, download: async () => null });
  assert.equal(out.length, 1);
  assert.ok(pageCalls.length >= 1, "paged the remaining posts");
  const md = readFileSync(path.join(tmp, "2026-08-07", "linuxdo-posts", path.basename(out[0].postFile)), "utf8");
  assert.match(md, /OP/);
  for (const n of [2, 3, 4, 5]) assert.match(md, new RegExp(`回 ${n}`));
  assert.ok(md.indexOf("回 2") < md.indexOf("回 3"), "post_number order preserved");
  assert.ok(md.indexOf("回 4") < md.indexOf("回 5"), "post_number order preserved");
  rmSync(tmp, { recursive: true, force: true });
});

test("enrich: all-failed downloads leave no empty attachments dir behind", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-cleandir-"));
  const config = {
    date: "2026-08-07",
    obsidianDir: tmp,
    linuxdoFullPosts: true,
    linuxdoDownloadAttachments: true,
  };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "A" }];
  const fetchTopic = async () => makeTopicJson("A", [`<p>正文</p><img src="${IMG_ORIG}">`]);
  const download = async () => null; // every download fails
  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download });
  assert.equal(out.length, 1, "post md still written when attachments fail");
  assert.equal(out[0].attachments.length, 0);
  const attachDir = path.join(tmp, "2026-08-07", "linuxdo-attachments");
  assert.equal(existsSync(attachDir), false, "empty attachments dir swept after all failures");
  rmSync(tmp, { recursive: true, force: true });
});