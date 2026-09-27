import { test } from "node:test";
import assert from "node:assert/strict";
import { isAiRelatedTopic } from "../src/community.mjs";

// ===========================================================================
// 2026-09-27 四轮复审新增：真实标题对照集。
//
// 为什么需要这份对照集：上一轮（2026-09-26 三轮复审）给 AI_TITLE_RE 加词边界
// 锚定时，只用 `Claude Code 2.0` 这类**空格分隔**的形状做测试，于是 352 个测试
// 全绿的同时，\b 却把**连写版本号**（GPT5 / GLM4.5 / Qwen3）——AI 论坛最常见的
// 标题形状——全部判成非 AI。
//
// 这份对照集把两侧同时钉死：
//   KEEP  = 必须是 AI 新闻（防再次丢失真实标题）
//   DROP  = 必须不是 AI 新闻（防再次过度匹配，即 bare `ai` 那个老 bug）
// 只断言一侧的测试是这轮 bug 能全绿通过的根因。
// ===========================================================================

const MUST_KEEP_AI = [
  // 版本号连写（\b 的尾部边界在这里闯祸：5/4/3 是词字符）
  "GPT5 发布",
  "GPT5.1 预览版",
  "GPT4 开源",
  "GPT-5 正式版",
  "GLM4.5 发布",
  "GLM5 开源预告",
  "GLM-4 评测",
  "Qwen3 登顶",
  "Qwen3.5 上线",
  "Qwen2.5 蒸馏",
  "Llama4 开源",
  "Llama3.1 上下文长度",
  "Grok4 发布",
  "Grok-4 评测",
  "Sora2 评测",
  "Kimi2 上下文",
  "Kimi K2 发布",
  "Veo3 竞品对比",
  "Veo 3 视频模型",
  "Mimo7B 评测",
  "vLLM0.9 部署",
  "Cursor0.9 定价",
  // 复合词（边界落在词中间，尾部 \b 同样闯祸）
  "agentic 架构新范式",
  "Agentic RL 论文",
  "Agentic Workflow 设计",
  "agentic coding 实践",
  "tokenizer 改进",
  "tokenomics 讨论",
  "Tokengate 事件",
  "cursors 插件生态",
  "LLM4S 综述",
  "LLM-based 评测方法",
  // bare `ai` 的连写形态
  "AIGC 行业报告",
  "AIGC 创业公司融资",
  "AI2 论文导读",
  // 空格 / 标点分隔（上一轮测试只覆盖了这一类）
  "Claude Code 2.0 正式版发布",
  "DeepSeek V4 Flash 开放 API",
  "OpenAI 发布新的 agent 能力",
  "Gemini 3.5 Pro 要来了？",
  "AI 编程助手新版本发布",
  "讨论一下 ai 在推理上的进展",
  "新模型 benchmark 对比",
  "提示词工程实践总结",
  "Qwen3 的 token 消耗实测",
  "ChatGPT 企业版新政策",
  "DeepSeek 开源新模型，推理成本降一半",
  "vLLM v0.9 支持 FP8 量化推理",
  "NVIDIA 发布新卡",
  "xAI 估值上涨",
  "Mistral 开源新模型",
  "HuggingFace 上线新数据集",
  // NB: 「模型评测：拼车功能上线企业版」是 deliberately NOT in this list.
  // It matches AI_TITLE_RE via 模型, but NEGATIVE_COMMUNITY_RE drops it for
  // 拼车 — a documented conservative over-kill (论坛信源宁可少收), asserted in
  // test/snippet-hygiene.test.mjs. Putting it here would have made the corpus
  // assert the opposite of an existing intentional decision.
];

const MUST_DROP_NON_AI = [
  // 这六条就是 2026-09-26 复审点名的原 bug：bare `ai` 匹配英文词里的 a-i-a
  "Daily maintenance window 这个公告",
  "Repair chain 讨论",
  "请问 Email 收不到验证码",
  "Air conditioning 闲聊",
  "求推荐 training 用的笔记本",
  "Failed to load 报错",
  // 同族词
  "maintain 公告",
  "email 收不到验证码",
  "said 有人讨论这个",
  // NB: 「trained 模型太大」 is deliberately NOT here — it contains 模型, which
  // is a real AI token in its own right, so AI_TITLE_RE matches it correctly.
  // The bare-`ai` bug was never about trained-with-a-non-AI-tail; adding it here
  // would have demanded the gate ignore a genuine signal.
  "trained 入门",
  "detail 页面加载失败",
  "available 库存不足",
  "chain 分析入门",
  "aisle 座位",
  "contain 容器教程",
  // 其它明显非 AI 的论坛水贴
  "出号 ChatGPT Plus 年付 低价",
  "求车 Gemini Advanced 拼车",
  "今天天气不错",
  "求推荐机械键盘",
  "求推荐显示器",
];

test("AI_TITLE_RE: 真实 AI 标题对照集——版本号连写 / 复合词 / 连写 AI 一律不丢", () => {
  const lost = MUST_KEEP_AI.filter((t) => !isAiRelatedTopic(t));
  assert.deepEqual(
    lost,
    [],
    `这些是真实 AI 新闻却被判为非 AI（\b 尾部边界 + 复合词）:\n  ${lost.join("\n  ")}`,
  );
});

test("AI_TITLE_RE: 真实非 AI 标题对照集——bare `ai` 那个老 bug 不得复发", () => {
  const leaked = MUST_DROP_NON_AI.filter((t) => isAiRelatedTopic(t));
  assert.deepEqual(
    leaked,
    [],
    `这些不是 AI 新闻却通过了闸门（bare \`ai\` 过度匹配）:\n  ${leaked.join("\n  ")}`,
  );
});

test("AI_TITLE_RE: 对照集两侧的通过率都要可观测（防止一侧被整体放弃）", () => {
  // 如果某次"修复"只是把闸门调成永远 true / 永远 false，上面两个测试会分别
  // 抓住——但这里再钉一次数量下限，让退化在 CI 里一眼可见。
  const keepPass = MUST_KEEP_AI.filter((t) => isAiRelatedTopic(t)).length;
  const dropPass = MUST_DROP_NON_AI.filter((t) => !isAiRelatedTopic(t)).length;
  assert.ok(keepPass >= MUST_KEEP_AI.length, `KEEP 侧全过，实得 ${keepPass}/${MUST_KEEP_AI.length}`);
  assert.ok(dropPass >= MUST_DROP_NON_AI.length, `DROP 侧全过，实得 ${dropPass}/${MUST_DROP_NON_AI.length}`);
});
