import "dotenv/config";
import path from "node:path";
import { loadConfig, beijingDateFor } from "./config.mjs";
import { exportBlogDraft } from "./blog-draft.mjs";

function usage() {
  console.error("用法：node src/export-blog-draft.mjs [--date YYYY-MM-DD] [--section AI]");
}

function parseArgs(argv) {
  let date = null;
  let section = "AI";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--date") date = argv[++i];
    else if (argv[i] === "--section") section = argv[++i];
    else if (argv[i] === "--help") return { help: true };
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (section !== "AI") throw new Error("草稿导出当前只允许 --section AI");
  return { date, section };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
const date = args.date || beijingDateFor(Date.now());
const config = loadConfig({ date });
const outputDir = process.env.BLOG_DRAFT_DIR?.trim() || path.join(config.cacheDir, "blog-drafts");
const result = await exportBlogDraft({
  obsidianDir: config.obsidianDir,
  outputDir,
  date,
  section: args.section,
});
console.log(`博客草稿已生成（仍为 draft=true，未发布）：${result.outputFile}`);
console.log(`封面资源：${result.assetsDir}`);
