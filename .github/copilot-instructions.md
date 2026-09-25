# DallyReport — Copilot review instructions

DallyReport 生成中文 AI/GitHub 日报并写入 Obsidian vault，支持生成 16:9 日报海报。评审时请重点关注以下仓库级契约：

## 数据真实性（最高优先级）
- 海报提示词里的任何数字（Star / Fork / 排名 / 统计）必须来自解析出的真实数据，**严禁要求模型凭空生成**。
- 数据缺失时显示 `—` 或省略该字段，不要编造。
- 新增榜单字段时，解析器（`src/sections/github-trending.mjs`）和提示词注入必须同步。

## 模板标记契约
- 海报模板版本标记必须是完整的 HTML 注释 `<!-- 海报模板版本：v2 -->`；裸文本 `海报模板版本：v2` 不算数。
- `checkPosterTemplate()` 的校验逻辑必须与这个契约一致，漂移时要失败而不是放行。

## 解析器陷阱
- GitHub trending 的语言标签有多词形式（`Jupyter Notebook`、`Visual Basic` 等），改动解析正则时必须用 `test/fixtures/trending-sample.mjs` 回归。
- V2EX 标题允许 `[求助]` 这类方括号前缀；Markdown 链接不能跨行。
- 品牌拼写在 ingest 层统一归一化（如 `Anthoropic` → `Anthropic`），不要在各处散落修补。

## 输出正确性
- Markdown 输出不允许转义字符泄漏（如 `\(`、`\*`）。
- 海报引用来源必须是正文实际出现过的链接。
- V2EX 抓取要过滤纯提问/求助类帖子。

## 双通道与配置
- `src/run.mjs` 的 AI 双通道互链：只有在**双方 vault 写入都成功后**才能注入 `[[...]]` 互链，避免悬空链接。改动此时序要极其谨慎。
- `AI_ALT_FILE` 等用户配置在 `src/config.mjs` 做归一化（如自动去掉 `.md` 后缀），不要假设用户输入格式正确。

## 测试要求
- 每个 bug 修复必须附带回归测试（`test/*.test.mjs`，`node --test` 全绿）。
- 不要为了让测试通过而放宽断言；跳过（skip）只允许用于需要外部凭证的用例。

## 语言
- 用户面向中文，面向用户的文案/注释用中文；代码标识符用英文。文档更新（如 `docs/review-*.md`）用中文。
