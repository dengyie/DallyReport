import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cookedToMarkdown, extractAttachments, enrichLinuxdoPosts } from "../src/linuxdo.mjs";

const IMG_ORIG = "https://cdn3.ldstatic.com/original/4X/3/5/c/35cab35942d147a12df3c18a806afa15045af2e7.png";
const IMG_ORIG2 = "https://cdn3.ldstatic.com/original/4X/1/2/3/abcdef123456789.png";

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

test("enrichLinuxdoPosts: no cookie/browser — fetchTopic null -> silently skipped", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dally-posts-null-"));
  const config = { date: "2026-08-07", obsidianDir: tmp, linuxdoFullPosts: true };
  const cards = [{ id: 10, url: "https://linux.do/t/topic/10", title: "A" }];
  const fetchTopic = async () => null;
  const out = await enrichLinuxdoPosts(cards, config, { fetchTopic, download: async () => null });
  assert.equal(out.length, 0);
  rmSync(tmp, { recursive: true, force: true });
});