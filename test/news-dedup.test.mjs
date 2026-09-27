import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAndNormalizeSources } from "../src/news-dedup.mjs";

// Real linux.do news/34 titles from 2026-08-09 — eight posts all about the same
// ChatGPT/Codex free-quota reset, with wildly different (and mostly not
// self-contained) titles. This is the exact shape the module exists to fold.
const RESET_TITLES = [
  "明天还会有一次重置",
  "重置了重置了！",
  "codex 周一还会重置！",
  "gpt今天重置了。周一还要重置。赶紧起床玩命的蹬。",
  "奥特曼又给重置了",
  "Codex重置了。",
  "Codex余额已重置，Tibo回应称明天周一会再次重置",
];

function card(title, snippet = "") {
  return { url: `https://linux.do/t/topic/${Math.random().toString(36).slice(2)}`, title, snippet };
}

test("dedupeAndNormalizeSources: 8 reset posts fold into one 'ChatGPT/Codex 额度重置' card", () => {
  const sources = RESET_TITLES.map((t) => card(t));
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 1, "all 8 reset posts collapse to a single card");
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置", "representative gets the clear rewritten title");
});

test("dedupeAndNormalizeSources: representative keeps the richest snippet", () => {
  const sources = [
    card("重置了重置了！", "短"),
    card("Codex余额已重置，Tibo回应称明天周一会再次重置", "这是最详细的一条正文，包含重置时间、Tibo 回应、资格到期提示等完整信息"),
    card("奥特曼又给重置了", "中"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
  assert.match(out[0].snippet, /最详细/, "keeps the member with the richest snippet");
});

test("dedupeAndNormalizeSources: representative is the most INFORMATIVE snippet, not the longest", () => {
  // Real 2026-08-09 deep-fetch snippets. The longest ones are garbage — a
  // Cloudflare Turnstile challenge URL (121 chars), a Discourse chrome line
  // ("Topic list, column headers with buttons are sortable.", 53 chars), and a
  // near-empty "1\." (3 chars). The informative prose is shorter. The old
  // longest-snippet rule picked the Turnstile URL; the substance rule must pick
  // the prose.
  const sources = [
    card("gpt今天重置了。周一还要重置。赶紧起床玩命的蹬。", "[Troubleshoot](https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/m4dn3/0x4AAAAAAAc2BQ"),
    card("重置了重置了！", "Topic list, column headers with buttons are sortable."),
    card("奥特曼又给重置了", "1\\."),
    card("Codex余额已重置，Tibo回应称明天周一会再次重置", "Tibo哥会不会等会说，因为我们这次重置，跟大家自然重置时间冲突了，所以提前重置了"),
    card("明天还会有一次重置", "就在5h前，tibo重置了。。。，还说 周一还会performative reset"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
  assert.match(out[0].snippet, /Tibo哥/, "picks the prose snippet, not the Turnstile URL / chrome / near-empty");
  assert.doesNotMatch(out[0].snippet, /challenges\.cloudflare|Topic list|^1\\\.$/, "garbage snippets never win");
});

test("dedupeAndNormalizeSources: non-reset sources pass through untouched, in order", () => {
  // NOTE: the Apple-Qwen title is intentionally NOT here — it is a real cluster
  // now (single-member → rewritten to its own title), so using it here would test
  // a cluster, not pass-through. The Apple fold is covered by its own test below.
  // 2026-09-26: the two reset posts now carry quota evidence, because a vague
  // reset with nothing to identify the event must NOT be relabelled (see the
  // fabrication tests below).
  const sources = [
    card("OpenAI 收购 AI 演示文稿初创公司 NextSlide", "s1"),
    card("重置了重置了！", "s2"),
    card("宇树科技明天申购，发行价格为150.80元/股", "s3"),
    card("Codex额度已重置", "s4"),
    card("OpenAI 发布 GPT 新版本", "s5"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 4, "2 reset posts fold to 1, 3 non-reset stay");
  assert.equal(out[0].title, "OpenAI 收购 AI 演示文稿初创公司 NextSlide");
  assert.equal(out[1].title, "ChatGPT/Codex 额度重置", "representative sits at the first member's position");
  assert.equal(out[2].title, "宇树科技明天申购，发行价格为150.80元/股");
  assert.equal(out[3].title, "OpenAI 发布 GPT 新版本");
});

test("dedupeAndNormalizeSources: a lone reset post WITH quota evidence is normalized", () => {
  // 2026-09-26: this test used to assert that a single vague post ("重置了重置了！",
  // snippet "8月9日中午 12点40 全部重置了") was rewritten to "ChatGPT/Codex 额度重置".
  // That IS the fabrication the review flagged — the title names no quota and no
  // vendor, so the rewrite asserted an event the input never described. A single
  // post carrying real quota evidence still normalizes; a vague one does not.
  const out = dedupeAndNormalizeSources([
    card("Codex额度重置，已恢复5H额度窗口", "8月9日中午 12点40 全部重置了"),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
  assert.equal(out[0].snippet, "8月9日中午 12点40 全部重置了", "snippet preserved");
});

test("dedupeAndNormalizeSources: reset + password (different event) is NOT folded", () => {
  const sources = [
    card("Codex额度重置了", "s1"),
    card("账号密码重置通知", "s2"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 2, "password-reset is a different event, stays separate");
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
  assert.equal(out[1].title, "账号密码重置通知");
});

test("dedupeAndNormalizeSources: 115 网盘 API 暂停 posts fold into one card", () => {
  const sources = [
    card("115网盘API暂停服务，官方称因系统升级", "s1"),
    card("115 API 暂停了，什么时候恢复？", "s2"),
    card("OpenAI 收购 NextSlide", "s3"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 2, "two 115-API-pause posts fold to one");
  assert.equal(out[0].title, "115 网盘 API 暂停服务");
  assert.equal(out[1].title, "OpenAI 收购 NextSlide");
});

test("dedupeAndNormalizeSources: Apple 删除千问扩展 posts fold into one card", () => {
  // Real 2026-08-09 titles — the action verb lands AFTER 千问 in one and BEFORE in
  // the other; both must fold.
  const sources = [
    card("苹果中国官网删除 Apple 智能接入阿里千问使用手册", "s1"),
    card("苹果貌似撤回了有关Apple智能的千问扩展内容", "s2"),
    card("OpenAI 收购 NextSlide", "s3"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 2, "two Apple-Qwen posts fold to one");
  assert.equal(out[0].title, "苹果中国官网删除 Apple 智能接入阿里千问使用手册");
  assert.equal(out[1].title, "OpenAI 收购 NextSlide");
});

// The earlier "iPhone 接入千问" partnership news is the OPPOSITE event (adding,
// not removing) — a poison test for the Apple cluster's broad 苹果…千问 surface.
test("dedupeAndNormalizeSources: 苹果与千问合作 (非删除事件) 不被折叠", () => {
  const sources = [card("苹果中国官网将于 iPhone 接入阿里千问 AI", "s1"), card("OpenAI 收购 NextSlide", "s2")];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 2, "partnership news stays untouched — no removal word, no fold");
  assert.equal(out[0].title, "苹果中国官网将于 iPhone 接入阿里千问 AI");
});

test("dedupeAndNormalizeSources: empty / non-array input is safe", () => {
  assert.deepEqual(dedupeAndNormalizeSources([]), []);
  assert.deepEqual(dedupeAndNormalizeSources(undefined), []);
  assert.deepEqual(dedupeAndNormalizeSources(null), []);
});

test("dedupeAndNormalizeSources: does not mutate the input array", () => {
  const sources = [card("重置了重置了！", "s1"), card("OpenAI 收购 NextSlide", "s2")];
  const before = sources.map((s) => s.title);
  dedupeAndNormalizeSources(sources);
  assert.deepEqual(sources.map((s) => s.title), before, "input untouched");
});

test("dedupeAndNormalizeSources: unrelated reset stories keep their own titles (no fabricated headline)", () => {
  // 2026-09-25 review: the bare /重置|reset/i cluster used to REPLACE a
  // self-contained title with the fixed "ChatGPT/Codex 额度重置" — deterministic
  // fake news. Titles whose reset object is a different artifact must pass
  // through with their own headline, folded or not.
  const sources = [
    card("OpenAI 重置了 GPT-5 系统提示词", "官方把默认系统提示词替换为新版本"),
    card("Git reset 使用教程", "详解 reset 的三种模式与区别"),
  ];
  const out = dedupeAndNormalizeSources(sources);
  assert.equal(out.length, 2, "different reset events must not fold together");
  assert.equal(out[0].title, "OpenAI 重置了 GPT-5 系统提示词", "self-contained title is never replaced");
  assert.equal(out[1].title, "Git reset 使用教程");
});

// ---- 2026-09-26 review P1: the quota-reset cluster must never FABRICATE ----
// The old match was the bare /重置|reset/i guarded only by an 8-noun blocklist,
// which could not bound it: unrelated reset stories were deterministically
// REWRITTEN into "ChatGPT/Codex 额度重置" — a different vendor and a different
// event — and that fabricated string became a source title in the synthesis
// prompt. A blocklist cannot constrain a match this broad, so the cluster now
// requires positive evidence (reset + a balance/quota object); vague reset posts
// still fold, but only onto a cluster some title actually established.
const FOREIGN_RESET_TITLES = [
  "Google 账号安全重置新流程上线",
  "Redis 连接池 reset 后异常",
  "Claude 上下文窗口重置策略调整",
  "Mistral API rate limit reset",
  "SQLite WAL reset 实现",
  "AWS ap-east-1 区域 reset 了配额",
];

for (const title of FOREIGN_RESET_TITLES) {
  test(`dedupeAndNormalizeSources: a foreign reset story is NOT relabelled (${title})`, () => {
    const out = dedupeAndNormalizeSources([card(title, "s1")]);
    assert.equal(out.length, 1);
    assert.equal(
      out[0].title,
      title,
      "passes through untouched — no fabricated OpenAI headline",
    );
  });
}

test("dedupeAndNormalizeSources: reset with a non-balance object is not folded", () => {
  const out = dedupeAndNormalizeSources([card("OpenAI 重置了 GPT-5 系统提示词", "s1")]);
  assert.equal(out[0].title, "OpenAI 重置了 GPT-5 系统提示词");
});

test("dedupeAndNormalizeSources: a day of ONLY vague resets invents nothing", () => {
  // Weak members may join a cluster, but only one a positive-evidence title
  // established. With no quota evidence anywhere, every card must survive.
  const titles = ["重置了重置了！", "明天还会有一次重置", "奥特曼又给重置了"];
  const out = dedupeAndNormalizeSources(titles.map((t) => card(t)));
  assert.equal(out.length, 3, "nothing collapsed");
  assert.deepEqual(
    out.map((s) => s.title),
    titles,
    "original titles preserved",
  );
});

test("dedupeAndNormalizeSources: one quota-evidence title folds the vague posts with it", () => {
  // The 2026-08-09 reality: only one of eight posts actually names the object.
  // That one post is enough to establish the event and pull the rest in.
  const titles = [
    "重置了重置了！",
    "奥特曼又给重置了",
    "Codex余额已重置，Tibo回应称明天周一会再次重置",
    "OpenAI 收购 NextSlide",
  ];
  const out = dedupeAndNormalizeSources(titles.map((t) => card(t)));
  assert.equal(out.length, 2, "three reset posts fold, the unrelated one stays");
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
  assert.equal(out[1].title, "OpenAI 收购 NextSlide");
});

test("dedupeAndNormalizeSources: quota evidence LATER in the list still governs", () => {
  // Whether a vague title may fold is a whole-input question, not a left-to-right
  // one — a single-pass implementation let the last title decide the first's fate.
  const out = dedupeAndNormalizeSources(
    [card("重置了重置了！"), card("codex 额度重置"), card("奥特曼又给重置了")].map((s, i) => ({
      ...s,
      url: `https://linux.do/t/topic/9${i}`,
    })),
  );
  assert.equal(out.length, 1, "all three fold regardless of evidence order");
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
});

test("dedupeAndNormalizeSources: a cluster and a pass-through keep their relative order", () => {
  const out = dedupeAndNormalizeSources([
    card("OpenAI 收购 NextSlide", "s1"),
    card("重置了重置了！", "s2"),
    card("codex 额度已重置", "s3"),
    card("宇树科技明天申购", "s4"),
  ]);
  assert.equal(out.length, 3, "the two reset posts fold into one card");
  assert.deepEqual(
    out.map((s) => s.title),
    ["OpenAI 收购 NextSlide", "ChatGPT/Codex 额度重置", "宇树科技明天申购"],
  );
});

// P2-3: a fold must UNION provenance. The representative is picked by snippet
// richness, which is normally the forum card — so a same-day hard-source card
// folded into it lost its `fromDaily` flag and stopped counting toward 当日素材.
// That could push an adequately-stocked day under the 低素材 threshold, making
// the report describe itself as stale when it wasn't.
test("dedupeAndNormalizeSources: a fold keeps fromDaily even when the forum card represents it", () => {
  const daily = { url: "https://hn/1", title: "Codex额度已重置", snippet: "短", fromDaily: true };
  const forum = {
    url: "https://linux.do/t/1",
    title: "Codex 额度重置，Tibo 回应称明天再次重置",
    snippet: "这是信息最完整的一条正文，包含重置时间与资格到期提示等完整信息",
  };
  const out = dedupeAndNormalizeSources([daily, forum]);
  assert.equal(out.length, 1, "the two posts are one event");
  assert.equal(out[0].url, forum.url, "the richer forum snippet represents the cluster");
  assert.equal(
    out[0].fromDaily,
    true,
    "the survivor still counts as daily material — provenance is unioned, not inherited",
  );
});

test("dedupeAndNormalizeSources: a pure-forum cluster is NOT marked fromDaily", () => {
  const out = dedupeAndNormalizeSources([
    { url: "https://linux.do/t/1", title: "codex 额度重置", snippet: "A" },
    { url: "https://linux.do/t/2", title: "codex额度又重置", snippet: "B" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].fromDaily, undefined, "no member was a hard source");
});

// ---------------------------------------------------------------------------
// 2026-09-27 review (round 4) P1-1 / P1-2.
//
// The round-3 fix moved `match` off the bare /重置|reset/ onto
// "reset AND a quota object", and the source comment claims that is what
// stopped "Google 账号安全重置新流程上线" and "Mistral API rate limit reset"
// being folded into the ChatGPT/Codex cluster. It did not. Both still fold, and
// so does a bare-vendor quota story. All five shapes below were verified
// folding before this test existed.
//
// The reason the existing 290 lines missed it: every non-folding case was fed
// ALONE. `exclude` is the only thing standing between those titles and the
// fold, and it happens to contain 账号-adjacent and rate-limit-adjacent words.
// The instant a title is named ALONGSIDE a real quota card it is judged by a
// different path (the weak-member `namesForeignEntity` check), whose list does
// not carry those words. So the poison samples are now asserted next to a
// legitimate quota card, which is the only context where they actually occur.
// ---------------------------------------------------------------------------

// The positive side, to be paired with each poison sample below.
const REAL_RESET_CARD = card("Codex额度已重置，Tibo回应称明天再次重置", "openai 官方宣布额度恢复，细节见正文");

test("dedupeAndNormalizeSources: a bare vendor quota reset is that vendor's event, not OpenAI's", () => {
  // P1-1. `match` requires reset AND a quota object but names NO vendor, so
  // "Gemini 额度重置" is positive evidence for the ChatGPT/Codex event and was
  // deterministically REWRITTEN into it — a different company, delivered to the
  // synthesis model as if it were OpenAI's announcement.
  for (const title of ["Gemini 额度重置公告", "Claude 额度重置了新周期", "DeepSeek 余额重置"]) {
    const out = dedupeAndNormalizeSources([card(title, "公告正文")]);
    assert.equal(out.length, 1, "a lone card must never be rewritten away");
    assert.equal(
      out[0].title,
      title,
      `${title} was rewritten into the OpenAI/Codex event — a different vendor`,
    );
  }
});

test("dedupeAndNormalizeSources: a foreign vendor's quota reset does not fold onto the OpenAI one", () => {
  // P1-2. Co-presence: a real Codex card establishes positive evidence, and the
  // foreign card then folds onto it — so the day loses a story outright.
  const out = dedupeAndNormalizeSources([
    REAL_RESET_CARD,
    card("Mistral 额度重置", "mistral 公告"),
    card("Gemini 额度调整", "谷歌公告"),
  ]);
  const titles = out.map((s) => s.title);
  assert.equal(out.length, 3, `a foreign vendor's reset folded onto the OpenAI one: ${JSON.stringify(titles)}`);
});

test("dedupeAndNormalizeSources: an account-security reset does not fold onto the quota reset", () => {
  // P1-2. The exact title the round-3 comment claims to have fixed.
  const out = dedupeAndNormalizeSources([
    REAL_RESET_CARD,
    card("Google 账号安全重置新流程上线", "谷歌账号安全策略更新说明"),
  ]);
  assert.equal(
    out.length,
    2,
    `an account-security story folded into "ChatGPT/Codex 额度重置": ${JSON.stringify(out.map((s) => s.title))}`,
  );
});

test("dedupeAndNormalizeSources: a rate-limit reset does not fold onto a balance reset", () => {
  // P1-2. `limit` is deliberately not a quota object, but "reset" alone still
  // makes this a positive match once the title also says 额度-adjacent English.
  const out = dedupeAndNormalizeSources([
    REAL_RESET_CARD,
    card("Mistral API rate limit reset", "mistral raised the ceiling"),
  ]);
  assert.equal(
    out.length,
    2,
    `a rate-limit story folded into "ChatGPT/Codex 额度重置": ${JSON.stringify(out.map((s) => s.title))}`,
  );
});

test("dedupeAndNormalizeSources: a policy/flow story does not fold onto the quota reset", () => {
  // P1-2. Same shape, Chinese vocabulary.
  const out = dedupeAndNormalizeSources([
    REAL_RESET_CARD,
    card("额度重置政策流程调整公告", "平台公告"),
    card("账号安全政策更新", "平台公告"),
  ]);
  assert.equal(
    out.length,
    3,
    `a policy/flow story folded in: ${JSON.stringify(out.map((s) => s.title))}`,
  );
});

test("dedupeAndNormalizeSources: the real vague reset posts still fold", () => {
  // The positive side of the same change: tightening the vendor constraint must
  // not cost the module its original job. These are the 2026-08-09 titles.
  const out = dedupeAndNormalizeSources([
    REAL_RESET_CARD,
    card("重置了重置了！", "短"),
    card("codex 周一还会重置！", "短"),
    card("奥特曼又给重置了", "短"),
  ]);
  assert.equal(out.length, 1, "the real vague posts must still collapse onto the real card");
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
});

test("dedupeAndNormalizeSources: vague posts naming a foreign entity still do NOT fold", () => {
  // ...and the co-presence guard must not become so broad that it also rejects
  // the real thing. A vague post ABOUT Redis is still a Redis story.
  //
  // Scope note: the module clusters on TITLE only, by design — the snippet picks
  // the representative, it never decides membership. So a foreign subject named
  // ONLY in the snippet ("又重置了" + "Redis 连接池 reset 后异常") is invisible to
  // it. That is a real residual limitation, not a bug: the title alone gives no
  // signal to separate it from "codex 周一还会重置！", which is the same shape,
  // and folding on snippet prose is the opposite of the module's purpose.
  // Recorded as 需要确认 rather than asserted either way.
  const out = dedupeAndNormalizeSources([REAL_RESET_CARD, card("Redis 重置了", "Redis 连接池 reset 后异常")]);
  assert.equal(out.length, 2, "a Redis story named in the TITLE folded in just because it said 重置");
});

// ---------------------------------------------------------------------------
// 2026-09-27 review E1/E2.
//
// E1: the vendor guard was a DENY list. It named fourteen vendors, so every
// vendor NOT on it — xAI/Grok, Cursor, Midjourney, Cohere's successors, any
// company that ships a model in the next two years — was rewritten into
// "ChatGPT/Codex 额度重置". A deny list has to be re-extended forever and fails
// open on every name it hasn't met; measured, three of four foreign vendors
// were fabricated. The rewrite must instead be conditioned on the title actually
// being about the event's own vendor.
//
// E2: apple-qwen-removal carried no evidence requirement. Its match fires on
// 苹果…千问…删除, so a DEBUNK post — 「苹果回应：从未移除千问接入」 — was
// rewritten into "苹果中国官网删除 Apple 智能接入阿里千问使用手册": the exact
// opposite of what the thread says, asserted to the synthesis model as a source
// title. (Its own comment warned about exactly this for the 苹果…千问 pairing and
// the negation slipped through anyway.)
// ---------------------------------------------------------------------------

const reset = (n, title, snippet) => ({ url: `https://linux.do/t/topic/${n}`, title, snippet });

test("dedupeAndNormalizeSources: a foreign vendor's quota reset is never rewritten as OpenAI's", () => {
  for (const [n, title, snippet] of [
    [101, "Grok 额度重置了", "xAI 刚刚把 Grok 的月度额度重置了，额度已经恢复正常使用。"],
    [102, "Cursor 额度重置", "Cursor 的额度重置了，可以继续使用下去。"],
    [103, "Midjourney 额度重置", "Midjourney 的额度重置通知已经出来了。"],
    [104, "Perplexity 额度重置", "Perplexity 宣布额度重置，所有套餐都恢复。"],
  ]) {
    const out = dedupeAndNormalizeSources([reset(n, title, snippet)]);
    assert.equal(
      out[0].title,
      title,
      `「${title}」 was rewritten as another company's event`,
    );
  }
});

test("dedupeAndNormalizeSources: a brandless quota reset with no OpenAI evidence is not rewritten", () => {
  // The rewrite is a factual claim about WHO reset. Without a name tying the
  // title to OpenAI it cannot be made, whatever the quota vocabulary says.
  const out = dedupeAndNormalizeSources([reset(105, "额度重置了", "今天额度重置了，很开心。")]);
  assert.equal(out[0].title, "额度重置了");
});

test("dedupeAndNormalizeSources: a genuine OpenAI reset still folds (contrast direction)", () => {
  const out = dedupeAndNormalizeSources([
    reset(106, "ChatGPT 额度重置了", "ChatGPT Plus 的额度重置，恢复正常使用。"),
    reset(107, "重置了重置了！", "今天额度重置了，开心。"),
  ]);
  assert.equal(out.length, 1, "the fold still happens — the guard is not over-blocking");
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
});

test("dedupeAndNormalizeSources: a codex-only reset still folds", () => {
  const out = dedupeAndNormalizeSources([
    reset(108, "codex 额度重置", "额度重置，今天又能用了。"),
    reset(109, "codex额度又重置", "又重置了。"),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "ChatGPT/Codex 额度重置");
});

test("dedupeAndNormalizeSources: a debunk post is not rewritten into a removal announcement", () => {
  const out = dedupeAndNormalizeSources([
    reset(
      110,
      "苹果回应：从未移除千问接入",
      "苹果方面回应称从未移除 Apple 智能中的千问接入，相关页面仍然可以正常访问。",
    ),
  ]);
  assert.equal(
    out[0].title,
    "苹果回应：从未移除千问接入",
    "a refutation was rewritten as the event it refutes",
  );
});

test("dedupeAndNormalizeSources: the genuine Apple/Qwen removal still folds", () => {
  const out = dedupeAndNormalizeSources([
    reset(111, "苹果中国官网删除 Apple 智能接入阿里千问使用手册", "官网页面已经无法访问。"),
    reset(112, "苹果貌似撤回了有关Apple智能的千问扩展内容", "撤回之后官网找不到入口了。"),
  ]);
  assert.equal(out.length, 1, "the two posts are the same event and must still fold");
  assert.equal(out[0].title, "苹果中国官网删除 Apple 智能接入阿里千问使用手册");
});

test("dedupeAndNormalizeSources: a single-sided removal report is not rewritten alone", () => {
  // One post claiming a removal is not evidence the removal happened; the fold
  // needs a sibling reporting the same action.
  const out = dedupeAndNormalizeSources([
    reset(113, "苹果撤回了千问扩展", "撤回之后就找不到了。"),
  ]);
  assert.equal(out[0].title, "苹果撤回了千问扩展");
});
