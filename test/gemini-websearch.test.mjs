import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { synthesizeWithWebSearch } from "../src/llm-synthesize.mjs";

// 行为测试全部注入 stub、从不碰网；凭证门只查环境变量存在性。给无 .env 的机器也
// 提供一次性凭证，保证套件在所有主机上全绿（node:test 每个测试文件独立进程，env
// 不跨文件泄漏）。2026-09-25 review：此前无 .env 机器会静默蒸发十余个行为测试。
if (!process.env.GROK_API_URL) process.env.GROK_API_URL = "https://gateway.test/v1";
if (!process.env.GROK_API_KEY) process.env.GROK_API_KEY = "test-key";

// Load .env if present so the cred-gated tests can run (they still never touch the
// network — fetch and searchImpl are both injected stubs). A fresh checkout without
// .env skips them like the existing llm-synthesize cases.
if (existsSync(path.resolve(process.cwd(), ".env"))) {
  try {
    const dotenv = await import("dotenv");
    dotenv.config();
  } catch {
    /* dotenv is a dependency; if missing, cred tests just skip */
  }
}

// A fetch stub that replays a fixed sequence of /chat/completions payloads, one per
// call. Lets each test script gemini's tool-call round(s) and the final text reply.
function seqStubFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    const payload = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
      async json() {
        return payload;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

function toolCallResponse(id, query) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query }) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function textResponse(content, finishReason = "stop") {
  return {
    choices: [{ message: { content, tool_calls: null }, finish_reason: finishReason }],
  };
}

test("synthesizeWithWebSearch: executes emitted web_search and converges to text", async () => {
  const searched = [];
  const fetchStub = seqStubFetch([
    toolCallResponse("call_1", "2026年8月7日 AI 最新动态"),
    textResponse("## 今日 AI 摘要\n\n商汤发布 8B 模型。"),
  ]);
  const out = await synthesizeWithWebSearch({
    query: "今天2026-08-07 AI 资讯",
    date: "2026-08-07",
    sources: [{ url: "https://example.com/a", title: "甲", snippet: "乙" }],
    model: "gemini-3.6-flash",
    maxSearchRounds: 2,
    fetch: fetchStub,
    searchImpl: async (q) => {
      searched.push(q);
      return "商汤发布 8B 模型 U1.5-Lite-Preview。";
    },
  });
  assert.deepEqual(searched, ["2026年8月7日 AI 最新动态"], "searchImpl receives the parsed query");
  assert.equal(out, "## 今日 AI 摘要\n\n商汤发布 8B 模型。", "returns the final rendered text");
  assert.equal(fetchStub.calls.length, 2, "one tool round + one final text reply");
  // The first request must declare the web_search tool.
  assert.match(JSON.parse(fetchStub.calls[0].init.body).tools[0].function.name, /^web_search$/);
});

test("synthesize turns: caps search rounds at maxSearchRounds, then a forced no-tool final reply", async () => {
  const searched = [];
  const fetchStub = seqStubFetch([
    toolCallResponse("call_1", "q1"),
    textResponse("最终正文（不被工具轮顶着不签发）"),
  ]);
  const out = await synthesizeWithWebSearch({
    query: "q",
    date: "2026-08-07",
    sources: [{ url: "u", title: "t", snippet: "s" }],
    model: "gemini-3.6-flash",
    maxSearchRounds: 1, // exactly one search round, then the loop forces a final answer
    fetch: fetchStub,
    searchImpl: async (q) => {
      searched.push(q);
      return "检索片段";
    },
  });
  assert.deepEqual(searched, ["q1"], "exactly one search executed at maxSearchRounds=1");
  assert.equal(out, "最终正文（不被工具轮顶着不签发）");
  assert.equal(fetchStub.calls.length, 2, "one tool round + forced final");
  // The final request must carry NO tools (that is what forces a text answer).
  const finalBody = JSON.parse(fetchStub.calls[1].init.body);
  assert.equal(finalBody.tools, undefined, "final call drops the web_search tool");
});

test("synthesize loop: won't run forever even if the model never stops", async () => {
  const fetchStub = seqStubFetch([
    toolCallResponse("c1", "q"),
    toolCallResponse("c2", "q"),
    toolCallResponse("c3", "q"),
    textResponse("done"),
  ]);
  const out = await synthesizeWithWebSearch({
    query: "q",
    date: "2026-08-07",
    sources: [{ url: "u" }],
    model: "gemini-3.6-flash",
    maxSearchRounds: 3,
    fetch: fetchStub,
    searchImpl: async () => "x",
  });
  assert.equal(out, "done");
  assert.equal(fetchStub.calls.length, 4, "3 tool rounds + forced final, never spins");
  // The final request carried no tools.
  const finalBody = JSON.parse(fetchStub.calls[3].init.body);
  assert.equal(finalBody.tools, undefined, "final call drops the web_search tool");
});

test("synthesizeWithWebSearch: a failing searchImpl renders 检索失败, still converges", async () => {
  const fetchStub = seqStubFetch([
    toolCallResponse("call_1", "查询"),
    textResponse("即便检索失败也要出正文"),
  ]);
  let shouldThrow = true;
  const out = await synthesizeWithWebSearch({
    query: "q",
    date: "2026-08-07",
    sources: [{ url: "u", title: "t", snippet: "s" }],
    model: "gemini-3.6-flash",
    maxSearchRounds: 2,
    fetch: fetchStub,
    searchImpl: async () => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("gateway 500");
      }
      return "ok";
    },
  });
  assert.equal(out, "即便检索失败也要出正文");
  // Loop got past the failing search and still produced a final brief.
  assert.equal(fetchStub.calls.length, 2);
});

test("synthesizeWithWebSearch: missing searchImpl -> SYNTH_NO_SEARCH_IMPL", async () => {
  await assert.rejects(
    () =>
      synthesizeWithWebSearch({
        query: "q",
        date: "2026-08-07",
        sources: [{ url: "u" }],
        fetch: async () => {
          throw new Error("should not be called");
        },
      }),
    (err) => err.code === "SYNTH_NO_SEARCH_IMPL",
  );
});

// Regression: synthesizeWithWebSearch's timeoutMs must be a REAL overall ceiling, not
// silently overrun by per-round respites. Previously postChatComplete did
// `Math.max(10000, deadline - Date.now())`, so once the shared deadline was spent each
// subsequent round still got a fresh 10s floor — the loop could keep POSTing past the
// declared budget. The fix fails fast with SYNTH_TIMEOUT once the budget is gone.
// Here a tiny timeoutMs + a fetch that outlives it burns the whole budget in round 1,
// so the loop's next POST (round 2, since round 1 yields a tool_call) must surface the
// spent deadline as SYNTH_TIMEOUT instead of issuing another request.
test("synthesizeWithWebSearch: spent overall budget -> SYNTH_TIMEOUT, not a padded 10s floor", async () => {
  let fetchCalls = 0;
  const slowToolCallFetch = async () => {
    fetchCalls += 1;
    await new Promise((r) => setTimeout(r, 30)); // outlives the 10ms budget
    const payload = toolCallResponse("call_1", "查询");
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
      async json() {
        return payload;
      },
    };
  };
  await assert.rejects(
    () =>
      synthesizeWithWebSearch({
        query: "q",
        date: "2026-08-07",
        sources: [{ url: "u", title: "t", snippet: "s" }],
        model: "gemini-3.6-flash",
        timeoutMs: 10, // tiny budget: round 1's 30ms fetch consumes it entirely
        maxSearchRounds: 2, // round 1 emits a tool_call, so the loop requests round 2
        fetch: slowToolCallFetch,
        searchImpl: async () => "检索片段",
      }),
    (err) => err.code === "SYNTH_TIMEOUT" && /预算已耗尽/.test(err.message),
  );
  // Exact count is timing-dependent (the spent deadline may trip on round 1 or round 2),
  // but we must never issue the full round 2 + forced-final cascade the old floor allowed.
  assert.ok(fetchCalls <= 2, `old 10s floor could keep POSTing; got ${fetchCalls} fetches`);
});
// --- 2026-09-25 review root fixes ---

test("synthesizeWithWebSearch: a transition turn with text + tool_calls is not returned as the final report", async () => {
  // 模型「先说一句再检索」是常见行为：带正文的 tool_calls 轮次是过渡轮，绝不能
  // 被当作整篇日报提前返回（旧代码的 return text 正是这条路径，且声明的检索从未执行）。
  const searched = [];
  const fetchStub = seqStubFetch([
    {
      choices: [
        {
          message: {
            content: "我先检索一下最新动态。",
            tool_calls: [
              {
                id: "call_t1",
                type: "function",
                function: { name: "web_search", arguments: JSON.stringify({ query: "最新 AI 动态" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    textResponse("## 今日 AI 日报正文"),
  ]);
  const out = await synthesizeWithWebSearch({
    query: "今天2026-09-25 AI 资讯",
    date: "2026-09-25",
    sources: [{ url: "https://example.com/a", title: "甲", snippet: "乙" }],
    model: "gemini-3.6-flash",
    maxSearchRounds: 2,
    fetch: fetchStub,
    searchImpl: async (q) => {
      searched.push(q);
      return "检索结果正文";
    },
  });
  assert.equal(out, "## 今日 AI 日报正文", "the transition narration must never become the report");
  assert.deepEqual(searched, ["最新 AI 动态"], "the declared search actually ran");
  assert.equal(fetchStub.calls.length, 2, "one tool round + one final reply");
  const secondBody = JSON.parse(fetchStub.calls[1].init.body);
  const assistantTurn = secondBody.messages.find((m) => m.role === "assistant");
  assert.equal(assistantTurn.content, "我先检索一下最新动态。", "narration is fed back as the assistant turn");
});

test("synthesizeWithWebSearch: a search that outlives the wall-clock budget is abandoned, budget surfaces as SYNTH_TIMEOUT", async () => {
  // searchImpl（grok-search 子进程）此前完全运行在 deadline 之外；现在受墙钟预算
  // 约束：超预算的检索被放弃（tool 消息记检索失败），预算耗尽后由 postChatComplete
  // 的 deadline 检查收敛为 SYNTH_TIMEOUT。
  const searched = [];
  const fetchStub = seqStubFetch([
    toolCallResponse("call_slow", "慢查询"),
    textResponse("永远不会用到的正文"),
  ]);
  await assert.rejects(
    synthesizeWithWebSearch({
      query: "今天2026-09-25 AI 资讯",
      date: "2026-09-25",
      sources: [{ url: "https://example.com/a", title: "甲", snippet: "乙" }],
      model: "gemini-3.6-flash",
      maxSearchRounds: 2,
      timeoutMs: 120,
      fetch: fetchStub,
      searchImpl: (q) => {
        searched.push(q);
        return new Promise(() => {}); // never settles — 模拟子进程挂死
      },
    }),
    (e) => e.code === "SYNTH_TIMEOUT",
  );
  assert.equal(searched.length, 1, "the hanging search was attempted once, not retried");
});
