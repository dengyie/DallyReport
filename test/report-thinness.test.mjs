import { test } from "node:test";
import assert from "node:assert/strict";
import { measure, measureAiDaily, isAiDaily } from "../scripts/report-thinness.mjs";

test("main-system format: bodies count, bare titles counted as bare", () => {
  const md = [
    "# 日报",
    "* **模型A发布**：这是一个足够长的正文段落，包含中文与细节描述，用来越过一百二十字的验收线。补充背景：该模型在多项基准上取得领先，发布方同时公开了评测脚本与权重，社区第三方已开始复现其关键数字，预计会影响后续同类工作的对比口径。发布方还表示后续将按季度更新权重并开放更完整的评测套件。 [1]",
    "* **裸标题B** [2]",
    "",
    "## 参考来源",
    "1. x",
  ].join("\n");
  const r = measure(md);
  assert.equal(r.bullets, 2);
  assert.equal(r.bare, 1);
  assert.equal(r.bodyBullets, 1);
  assert.ok(r.meanBody >= 120);
});

test("isAiDaily: frontmatter generator or 可信度 markers trigger ai-daily mode", () => {
  assert.ok(isAiDaily("---\ngenerator: ai-daily\n---\n# x"));
  assert.ok(isAiDaily("# x\n\n*可信度：中*\n"));
  assert.ok(!isAiDaily("# 普通主系统报告\n* **标题**：正文\n"));
});

test("ai-daily format: paragraph entries measured, stats bullets never counted", () => {
  const body = "据 Hugging Face 页面，Moonshot 放出开放权重，宣称为总参数很大的多模态混合专家模型，支持约百万 token 的长上下文，采用宽松许可。该发布被多方视为可自部署的前沿级开源底座，但具体能力与基准表现仍待官方及第三方进一步确认，发布日期约在窗口开始前。";
  const md = [
    "---",
    "generator: ai-daily",
    "---",
    "# 日报",
    "## 今日亮点",
    "- **亮点A** — 短评一句（不应被计为条目）",
    "### 开源底座",
    "",
    `**Moonshot 开源权重** \`[窗口外·重大]\``,
    "",
    `${body} [1] *[未核查·待证实]*`,
    "",
    "*可信度：中*",
    "",
    "## 数据概览",
    "- **开源与工具链**：9 claims / 3 sources",
    "- **学术研究**：6 claims / 2 sources",
  ].join("\n");
  const r = measureAiDaily(md);
  // 只有 1 个真条目（Moonshot）；亮点 bullet 与统计 bullet 都不算
  assert.equal(r.bullets, 1);
  assert.equal(r.bare, 0);
  assert.equal(r.bodyBullets, 1);
  // 引用与 *[...]* 标记不计入正文长度
  assert.ok(r.meanBody <= body.length);
  assert.ok(r.meanBody >= 120);
});

test("ai-daily format: entry without CJK body is bare", () => {
  const md = ["### 板块", "", "**Headline Only** `已核查 2-0`", "", "*可信度：低*"].join("\n");
  const r = measureAiDaily(md);
  assert.equal(r.bullets, 1);
  assert.equal(r.bare, 1);
  assert.equal(r.bodyBullets, 0);
});

test("ai-daily format: CRLF line endings must not zero out the entry count", () => {
  // 2026-11-07 review 探针：AI_DAILY_ENTRY 的 (.*)$ 无 m 标志时，\r 残留使
  // headline 不匹配 → 0 条目 → n/a 假 PASS。修复 = 解析前统一 CRLF → LF。
  const body = "据 Hugging Face 页面，Moonshot 放出开放权重，宣称为总参数很大的多模态混合专家模型，支持约百万 token 的长上下文，采用宽松许可。该发布被多方视为可自部署的前沿级开源底座，但具体能力与基准表现仍待官方及第三方进一步确认，发布日期约在窗口开始前。";
  const md = [
    "---",
    "generator: ai-daily",
    "---",
    "### 板块",
    "",
    `**Moonshot 开源权重** \`[窗口外·重大]\``,
    "",
    `${body} [1] *[未核查·待证实]*`,
    "",
    "*可信度：中*",
  ].join("\r\n");
  const r = measureAiDaily(md);
  assert.equal(r.bullets, 1);
  assert.equal(r.bare, 0);
  assert.ok(r.meanBody >= 120);
});

test("ai-daily format: consecutive entries without 可信度 stop at the next headline", () => {
  const long = (n) => `第${n}条正文足够长，包含中文细节描述与背景说明，用来越过验收线的一百二十字要求，继续补充复现口径、基准表现与第三方交叉验证的说明。发布方同时公开了评测脚本与权重，社区第三方已开始复现关键数字，预计会影响后续同类工作的对比口径，发布方还表示将按季度更新并开放更完整的评测套件。`;
  const md = ["### 板块", "", `**条目一** \`已核查 2-0\``, "", `${long("一")} [1]`, "", `**条目二** \`已核查 2-1\``, "", `${long("二")} [2]`].join("\n");
  const r = measureAiDaily(md);
  assert.equal(r.bullets, 2);
  assert.equal(r.bodyBullets, 2);
  assert.ok(r.meanBody >= 120);
});

test("ai-daily format: group citations [1, 2] are stripped from body length", () => {
  const body = "这段正文足够长，包含中文细节描述与背景说明，用来越过验收线的一百二十字要求，继续补充复现口径、基准表现与第三方交叉验证的说明。发布方同时公开了评测脚本与权重，社区第三方已开始复现关键数字，预计会影响后续同类工作的对比口径与引用标记剥离后的长度计算。";
  const md = ["### 板块", "", `**组引条目** \`已核查 2-0\``, "", `${body} [1, 2]`, "", "*可信度：高*"].join("\n");
  const r = measureAiDaily(md);
  assert.equal(r.bullets, 1);
  assert.ok(r.meanBody <= body.length);
  assert.ok(r.meanBody >= 120);
});
