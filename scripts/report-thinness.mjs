#!/usr/bin/env node
// report-thinness.mjs — measure the §9.5 content-thickness metric on produced
// report files. READ-ONLY: it never writes to the vault or touches the network.
//
// 2026-10-18 thinness review ([[DallyReport 优化开发文档]] §9): the report's
// complaint was that 33%–91% of bullets were a bare source title with no body.
// §9.5 sets the acceptance bar: bare-title ratio < 15%, mean body length ≥ 120.
//
// Classification follows the doc exactly: a bullet is `* **headline**：body [N]`.
// Strip the citation markers; if what remains after the headline carries no CJK,
// the bullet is "bare" (title-only). Everything else has a body, and its length
// is the character count of that remainder.
//
// 2026-11-07: the tool also learned the ai-daily product format. Its entries are
// paragraph-shaped (`**headline**` on its own line, body paragraph after,
// `*可信度：…*` to close) and it carries a `数据概览` stats list whose
// `- **板块**：3 claims / 3 sources` bullets matched the main-system bullet
// regex as ten "bare titles" — a systematic false FAIL. Files declaring
// `generator: ai-daily` (or carrying 可信度 markers) are measured by
// measureAiDaily(): entries = non-bullet bold-headline blocks, body = the
// paragraph between headline and 可信度; apparatus bullets never count.
//
// Run:
//   node scripts/report-thinness.mjs <file.md> [more.md ...]
//   node scripts/report-thinness.mjs --dir "<vault>/Note/AI/DallyReport/2026-10-18"
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ANY_BULLET = /^\s*[*+-]\s+\*\*(.+?)\*\*\s*([\s\S]*)$/;
const CJK = /[\u4e00-\u9fff]/;
const CITE = /\[\d+(?:\s*,\s*\d+)*\]/g;
const REF_HEADING = /^#{1,6}\s*(参考来源|参考资料|参考文献|来源列表)/;
const AI_DAILY_GENERATOR = /^generator:\s*ai-daily\s*$/m;
const AI_DAILY_ENTRY = /^\*\*(.+?)\*\*\s*(.*)$/;
const AI_DAILY_CONF = /^\s*\*可信度/;
const AI_DAILY_CONF_ANY = /\*可信度/;
const AI_DAILY_HEADING = /^#{1,6}\s/;

const BARE_BAR = 0.15;
const BODY_BAR = 120;

export function isAiDaily(markdown) {
  const md = String(markdown || "");
  return AI_DAILY_GENERATOR.test(md) || AI_DAILY_CONF_ANY.test(md);
}

// ai-daily 条目计分：`**headline**` 独立行开块，正文取 headline 之后到
// `*可信度` / 标题 / 下一块之间的段行。统计行是 `- ` 开头的 bullet，天然不命中。
export function measureAiDaily(markdown) {
  // 统一 CRLF → LF：AI_DAILY_ENTRY 的 (.*)$ 无 m 标志，行尾 \r 会让整条
  // headline 不匹配、静默测出 0 条目（n/a 假 PASS）。2026-11-07 review 探针实测。
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  let entries = 0;
  let bare = 0;
  let bodyBullets = 0;
  let bodyChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(AI_DAILY_ENTRY);
    if (!m) continue;
    entries += 1;
    const parts = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (AI_DAILY_CONF.test(line) || AI_DAILY_HEADING.test(line) || AI_DAILY_ENTRY.test(line)) break;
      if (line.trim()) parts.push(line.trim());
    }
    const body = parts
      .join(" ")
      .replace(CITE, " ")
      .replace(/\*\[[^\]]*\]\*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!body || !CJK.test(body)) {
      bare += 1;
      continue;
    }
    bodyBullets += 1;
    bodyChars += body.length;
  }
  return {
    bullets: entries,
    bare,
    ratio: entries ? bare / entries : 0,
    bodyBullets,
    meanBody: bodyBullets ? bodyChars / bodyBullets : 0,
  };
}

export function measure(markdown) {
  let bullets = 0;
  let bare = 0;
  let bodyBullets = 0;
  let bodyChars = 0;
  for (const line of String(markdown || "").split("\n")) {
    // Everything from the reference list down is apparatus, not report body.
    if (REF_HEADING.test(line)) break;
    const m = line.match(ANY_BULLET);
    if (!m) continue;
    bullets += 1;
    const body = m[2]
      .replace(CITE, " ")
      .replace(/^[\s：:]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!body || !CJK.test(body)) {
      bare += 1;
      continue;
    }
    bodyBullets += 1;
    bodyChars += body.length;
  }
  return {
    bullets,
    bare,
    ratio: bullets ? bare / bullets : 0,
    bodyBullets,
    meanBody: bodyBullets ? bodyChars / bodyBullets : 0,
  };
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function verdict(r) {
  if (!r.bullets) return "n/a";
  const okBare = r.ratio < BARE_BAR;
  const okBody = r.bodyBullets === 0 || r.meanBody >= BODY_BAR;
  return okBare && okBody ? "PASS" : "FAIL";
}

function collect(args) {
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") {
      const dir = args[++i];
      for (const name of fs.readdirSync(dir)) {
        if (/\.md$/i.test(name)) files.push(path.join(dir, name));
      }
    } else {
      files.push(args[i]);
    }
  }
  return files;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const files = collect(process.argv.slice(2));
  if (!files.length) {
    console.error("usage: node scripts/report-thinness.mjs <file.md>... | --dir <dir>");
    process.exit(2);
  }
  console.log(`bar: bare-title ratio < ${pct(BARE_BAR)}, mean body ≥ ${BODY_BAR} chars\n`);
  console.log("file                          bullets  bare   ratio   meanBody  verdict");
  let worst = "PASS";
  let unreadable = 0;
  for (const f of files.sort()) {
    let r;
    let kind = "";
    try {
      const md = fs.readFileSync(f, "utf8");
      if (isAiDaily(md)) {
        kind = " [ai-daily]";
        r = measureAiDaily(md);
      } else {
        r = measure(md);
      }
    } catch (err) {
      // An unreadable file must fail the run (rc 1), never pass silently: this
      // tool is the §9.5 acceptance gate, and a mistyped path "passing" with
      // rc 0 is how a broken check survives. A date-shaped argument gets a hint
      // pointing at the --dir form that was actually meant (2026-10-30: passing
      // a bare date here read as ENOENT and exited 0).
      unreadable += 1;
      const hint = /^\d{4}-\d{2}-\d{2}$/.test(path.basename(f))
        ? "（日期参数请用 --dir \"<vault>/Note/AI/DallyReport/<date>\"）"
        : "";
      console.log(`${path.basename(f).padEnd(29)} (unreadable: ${err?.code || err?.message})${hint}`);
      continue;
    }
    const v = verdict(r);
    if (v === "FAIL") worst = "FAIL";
    console.log(
      `${path.basename(f).padEnd(29)} ${String(r.bullets).padStart(7)} ${String(r.bare).padStart(5)} ` +
        `${pct(r.ratio).padStart(7)} ${r.meanBody.toFixed(0).padStart(9)}  ${v}${kind}`,
    );
  }
  process.exit(worst === "PASS" && !unreadable ? 0 : 1);
}
