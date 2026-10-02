// Post-processing that removes the two mechanical tells of a machine-written
// digest: a category heading doing the work of a story, and unrelated news
// welded onto one bullet with a connective.
//
// WHAT THIS DOES AND DOES NOT FIX — read before adding to it.
//
// The shipped 2026-09-25 weekly has ten bullets. Four of them carry more than
// one citation, and all four are titled with a CATEGORY rather than an event:
//
//   3 refs  **Anthropic 创始人寻求投票控制权与公司动态**
//              → IPO 投票控制权 + 基因编辑酶系统研究 + 上诉法院供应链风险裁决
//   2 refs  **多模态与视频生成研究**   → 谷歌长视频生成 + VeriSpeak 语音基准
//   2 refs  **具身智能与世界模型**     → AD-WM + Rolling-WAM + RAPID
//   2 refs  **开源赛事与开发工具进展** → GOAI 颁奖典礼 + opencode review
//
// The other six are titled with a specific event (微软重组 Copilot、WSO2 发布
// Agent Manager、美团 Longcat-2.5-preview 上线) and each cites one source. The
// correlation is exact: 4 of 4 category-titled bullets over-merge, 0 of 6
// event-titled ones do. A category title forces unrelated items to share a
// bullet, because there is no story in the title to constrain it.
//
// The PRIMARY fix for that is the prompt (llm-synthesize.mjs rule 12), which
// asks for one story per bullet and a title naming a specific event. This
// module is the safety net for when the model ignores it anyway.
//
// It deliberately does NOT invent replacement headlines. A post-processor that
// manufactures Chinese titles by cutting a sentence at a comma produces exactly
// the mechanical, machine-smelling prose this is meant to remove. Split bullets
// keep the original title on the first part and carry the rest as untitled
// bullets, which read as ordinary follow-up context and claim nothing.
// The prompt-side fix is what gives the split parts proper titles on the next
// run.

/**
 * A connective that OPENS a sentence and marks "here comes an unrelated item".
 *
 * Matching at the start of a sentence, not mid-string: the body is split on
 * sentence terminators first, so a tack is always the first thing in its
 * sentence. An earlier version looked for a connective preceded by 。 within
 * one string, which could never match after the split and silently disabled
 * the whole module.
 */
const TACK_RE = /^(?:同时|此外|另外|与此同时|而且)[，,]\s*/;

/**
 * The reference list heading. Everything from here down is apparatus.
 *
 * Deliberately NOT "any heading": the body is organised under headings of its
 * own (## 本周焦点、## 产品与模型更新…), and stopping at the first one made
 * posterBullets return zero entries for a perfectly good weekly.
 */
const REFERENCE_HEADING_RE = /^#{1,6}\s*(参考来源|参考资料|参考文献|来源列表)/;
const BULLET_RE = /^(\s*)[*+-]\s+\*\*(.+?)\*\*[：:]\s*([\s\S]*)$/;

/** Sentence boundaries, keeping the terminator with its sentence. */
function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？；])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Split bullets that tack an unrelated item onto a first one.
 *
 * A split happens only where ALL of these hold, because each condition alone
 * would cut legitimate prose:
 *
 *   1. a connective immediately follows a sentence terminator (TACK_RE), so the
 *      model is explicitly transitioning rather than continuing a sentence;
 *   2. the clause after the connective carries its own `[N]` citation — a new
 *      claim with its own source, not an elaboration of the previous one;
 *   3. the text before the split is non-empty, so a bullet never becomes empty.
 *
 * Returns the same markdown with extra bullets; anything unrecognised is passed
 * through byte-for-byte.
 */
export function splitOverMergedBullets(markdown) {
  const lines = String(markdown || "").split("\n");
  const out = [];
  for (const line of lines) {
    const m = line.match(BULLET_RE);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, indent, title, body] = m;
    const parts = [];
    let current = "";
    for (const sentence of splitSentences(body)) {
      // A tack is only a split point when something precedes it. If the
      // connective opens the bullet there is nothing to separate.
      const cut = TACK_RE.exec(sentence);
      if (cut && current.trim()) {
        const head = (current + sentence.slice(0, cut.index)).trim();
        const tail = sentence.slice(cut.index + cut[0].length).trim();
        // Condition 2: the tacked clause must carry its own citation, or it is
        // a continuation of the same claim and must stay attached.
        if (head && tail && /\[\d+\]/.test(tail)) {
          parts.push(head);
          current = tail;
          continue;
        }
      }
      current += sentence;
    }
    if (current.trim()) parts.push(current.trim());

    if (parts.length <= 1) {
      out.push(line);
      continue;
    }
    parts.forEach((part, i) => {
      // The first part keeps the headline. The rest are untitled: the source
      // text is the claim, and a title cut out of it by string surgery would
      // read worse than no title at all.
      out.push(i === 0 ? `${indent}* **${title}**：${part}` : `${indent}* ${part}`);
    });
  }
  return out.join("\n");
}

/**
 * Count bullets that cite more than one source. Reported, not corrected —
 * `splitOverMergedBullets` handles the ones with an explicit connective, and a
 * bullet that merges two sources inside a single sentence is the model's
 * judgement call about one story, not a formatting artefact.
 */
export function countOverMergedBullets(markdown) {
  let n = 0;
  for (const line of String(markdown || "").split("\n")) {
    const m = line.match(BULLET_RE);
    if (!m) continue;
    const cites = (m[3].match(/\[\d+\]/g) || []).length;
    if (cites > 1) n += 1;
  }
  return n;
}

/**
 * Bullets the poster can use, in either shape.
 *
 * A split bullet has no `**title**：`, so the poster's extractor must not skip
 * it — that would make de-clustering silently drop stories from the image,
 * which is the exact class of bug this whole change set exists to remove.
 *
 * `titled` is returned because the two shapes need different shaping downstream
 * (see buildStoriesFromBody): a bullet the model gave a headline to keeps that
 * headline, while an untitled one has to have a headline derived from its own
 * first sentence. Collapsing both into one field here is what let a 100+
 * character paragraph be handed to the poster as a "title" and silently clip.
 */
export function posterBullets(markdown) {
  const out = [];
  for (const line of String(markdown || "").split("\n")) {
    // Without this stop, every "- [1] [A](<url>)" line in the reference list
    // is a valid untitled bullet, and the poster fills up with the
    // bibliography instead of the news.
    if (REFERENCE_HEADING_RE.test(line)) break;
    const titled = line.match(BULLET_RE);
    if (titled) {
      const body = titled[3].replace(/\s*\[\d+\]/g, "").trim();
      out.push({ titled: true, title: titled[2].trim(), body });
      continue;
    }
    const plain = line.match(/^\s*[*+-]\s+([^*].*)$/);
    if (plain) {
      const body = plain[1].replace(/\s*\[\d+\]/g, "").trim();
      if (body) out.push({ titled: false, title: "", body });
    }
  }
  return out;
}
