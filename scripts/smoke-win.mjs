#!/usr/bin/env node
// Windows (and local) smoke: syntax, poster 3200x1800, linux.do JSON via CDP 9222.
// Does not write the vault and does not run the daily report.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchLinuxDoJsonPageWithBrowser } from "../src/linuxdo.mjs";
import { renderHtmlToPng } from "../src/poster/shot.mjs";
import { POSTER_WIDTH, POSTER_HEIGHT } from "../src/poster/html.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const files = [
  "src/run.mjs",
  "src/poster/shot.mjs",
  "src/topic-bullets.mjs",
  "src/child-tracker.mjs",
  "src/grok-cli.mjs",
  "src/sections/ai-news.mjs",
];

for (const file of files) {
  const res = spawnSync(node, ["--check", path.join(root, file)], { encoding: "utf8" });
  if (res.status !== 0) {
    process.stderr.write(`check-fail ${file}\n${res.stderr || res.stdout || ""}\n`);
    process.exit(1);
  }
}
console.log("check-ok");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="width:${POSTER_WIDTH}px;height:${POSTER_HEIGHT}px;margin:0;background:#fff">
<h1>smoke</h1></body></html>`;
const buf = await renderHtmlToPng(html, { width: POSTER_WIDTH, height: POSTER_HEIGHT, timeoutMs: 45_000 });
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
if (w !== 3200 || h !== 1800) {
  throw new Error(`bad poster dim ${w}x${h}`);
}
console.log(`poster-ok ${w}x${h} ${buf.length}B`);

const url = "https://linux.do/c/news/34.json?page=1&order=created";
const text = await fetchLinuxDoJsonPageWithBrowser(url, "", "127.0.0.1:9222", { deadlineMs: 25_000 });
if (!text) {
  console.error("cdp-empty");
  process.exit(1);
}
const trimmed = String(text).trimStart();
if (!trimmed.startsWith("{")) {
  console.error(`cdp-not-json ${trimmed.slice(0, 80)}`);
  process.exit(1);
}
console.log(`cdp-ok ${trimmed.length}B`);
