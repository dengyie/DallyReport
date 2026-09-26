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
