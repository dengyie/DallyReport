import fs from "node:fs/promises";
import path from "node:path";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(date) {
  if (!DATE_RE.test(date)) throw new Error(`日期必须是 YYYY-MM-DD：${date}`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`无效日期：${date}`);
  }
}

function yamlQuote(value) {
  return JSON.stringify(String(value));
}

function parseFrontMatter(markdown) {
  if (!markdown.startsWith("---\n")) return { frontMatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return { frontMatter: {}, body: markdown };
  const raw = markdown.slice(4, end);
  const frontMatter = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontMatter[match[1]] = match[2].trim();
  }
  return { frontMatter, body: markdown.slice(end + 4).replace(/^\n+/, "") };
}

function cleanObsidianMarkdown(body, { imagePath = "assets/AI.png" } = {}) {
  let result = body;
  // Obsidian embeds are deliberately converted only for the known local poster.
  // Other embeds become a visible text marker instead of silently disappearing.
  result = result.replace(/!\[\[AI\.png\]\]/g, `![AI 日报海报](${imagePath})`);
  result = result.replace(/!\[\[([^\]]+)\]\]/g, "![附件：$1](attachments/$1)");
  // Internal Obsidian links are not meaningful on the public blog. Keep the label.
  result = result.replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_, note, heading, label) => {
    const visible = label || (heading ? `${note} · ${heading}` : note);
    return visible;
  });
  // Obsidian callouts are valid-ish Markdown but the public draft should not depend
  // on the Obsidian renderer. Preserve the text and make the warning explicit.
  result = result.replace(/^>\s*\[!(WARNING|CAUTION|重要|TIP)\]\s*/gim, "> **$1：** ");
  return result.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function convertReportToBlogDraft(markdown, { date, sourceFile = "", imagePath = "assets/AI.png" } = {}) {
  assertDate(date);
  const { frontMatter, body } = parseFrontMatter(markdown);
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() || `AI 日报 · ${date}`;
  const warnings = [];
  const dropped = Number.parseInt(frontMatter.days_dropped || "0", 10);
  if (Number.isFinite(dropped) && dropped > 0) warnings.push(`已过滤 ${dropped} 条时效不符来源`);
  if (/低素材提示|低素材/.test(body)) warnings.push("当日硬源不足，正文包含近期趋势，请人工核验后再发布");
  const publicBody = cleanObsidianMarkdown(body, { imagePath });
  const header = [
    "---",
    `title: ${yamlQuote(title.replace(/\s+·\s+\d{4}-\d{2}-\d{2}$/, ""))}`,
    `date: ${date}`,
    "draft: true",
    "type: ai-daily-report",
    "tags: [AI, 日报]",
    `source: ${yamlQuote(sourceFile)}`,
    "publish_review: pending",
    "review_warnings:",
    ...(warnings.length ? warnings.map((warning) => `  - ${yamlQuote(warning)}`) : ["  []"]),
    "---",
    "",
    "> ⚠️ 这是博客草稿，尚未发布。请先核对来源时效、事实准确性和图片路径。",
    "",
  ].join("\n");
  return `${header}${publicBody}`;
}

export async function exportBlogDraft({ obsidianDir, date, outputDir, section = "AI" } = {}) {
  assertDate(date);
  if (!obsidianDir || !outputDir) throw new Error("obsidianDir 和 outputDir 必填");
  const sourceDir = path.join(obsidianDir, date);
  const sourceFile = path.join(sourceDir, `${section}.md`);
  const outputDateDir = path.join(outputDir, date);
  const outputFile = path.join(outputDateDir, `${section}.md`);
  await fs.mkdir(outputDateDir, { recursive: true });
  const markdown = await fs.readFile(sourceFile, "utf8");
  const draft = convertReportToBlogDraft(markdown, {
    date,
    sourceFile,
    imagePath: "assets/AI.png",
  });
  await fs.mkdir(path.join(outputDateDir, "assets"), { recursive: true });
  const sourceImage = path.join(sourceDir, "AI.png");
  try {
    await fs.copyFile(sourceImage, path.join(outputDateDir, "assets", "AI.png"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.writeFile(path.join(outputDateDir, "assets", "IMAGE-MISSING.txt"), "源日报没有 AI.png，发布前请补充封面图。\n");
  }
  await fs.writeFile(outputFile, draft, "utf8");
  return { outputFile, sourceFile, assetsDir: path.join(outputDateDir, "assets") };
}

export { cleanObsidianMarkdown, parseFrontMatter };
