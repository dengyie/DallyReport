import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, modelSlug, resolveAltChannel } from "../src/config.mjs";

// The alt-channel env vars are read straight from process.env, so they need to be
// wiped (and restored) per-test just like the other env-backed keys. The model is
// only used via resolveAltChannel (returns the object), never from process.env
// directly in the consumer, so a clean baseline keeps the defaults deterministic.
const ALT_KEYS = ["AI_ALT_CHANNEL", "AI_ALT_MODEL", "AI_ALT_QUERY", "AI_ALT_FILE", "AI_ALT_SYNTH_TIMEOUT_MS", "AI_QUERY"];

async function withEnv(values, fn) {
  const previous = new Map(ALT_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ALT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        const value = values[key];
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- modelSlug (pure) ---

test("modelSlug: known alt models map to short labels", () => {
  assert.equal(modelSlug("deepseek-v4-pro"), "DeepSeek");
  assert.equal(modelSlug("grok-4.5"), "Grok");
  assert.equal(modelSlug("gpt-5.6-luna"), "Luna");
  assert.equal(modelSlug("gemini-3.6-flash"), "Gemini");
});

test("modelSlug: unknown model falls back to a sanitized kebab slug", () => {
  assert.equal(modelSlug("openai/gpt-4.1"), "openai-gpt-4-1");
  assert.equal(modelSlug("  meta::llama-3 "), "meta-llama-3");
});

test("modelSlug: empty / non-string falls back to Alt", () => {
  assert.equal(modelSlug(""), "Alt");
  assert.equal(modelSlug(null), "Alt");
  assert.equal(modelSlug(undefined), "Alt");
});

// --- resolveAltChannel ---

test("resolveAltChannel: disabled channel returns null (single-channel mode)", () => {
  assert.equal(resolveAltChannel({ aiAltChannel: false }), null);
  assert.equal(resolveAltChannel({ aiAltChannel: false, aiAltModel: "grok-4.5" }), null);
});

test("resolveAltChannel: defaults to Gemini writer + shared AI_QUERY", () => {
  const ch = resolveAltChannel({ aiAltChannel: true, date: "2026-08-06" });
  assert.equal(ch.name, "AI-Gemini");
  assert.equal(ch.model, "gemini-3.6-flash");
  assert.equal(ch.queryTemplate, undefined); // no aiQueryTemplate set -> undefined
  assert.equal(ch.title, "# AI 热点（Gemini）· 2026-08-06");
});

test("resolveAltChannel: carries the alt synthesis timeout budget", () => {
  const ch = resolveAltChannel({
    aiAltChannel: true,
    date: "2026-08-06",
    aiAltSynthTimeoutMs: 300000,
  });
  assert.equal(ch.synthTimeoutMs, 300000);
});

test("resolveAltChannel: queryTemplate falls back to aiQueryTemplate", () => {
  const ch = resolveAltChannel({
    aiAltChannel: true,
    date: "2026-08-06",
    aiQueryTemplate: "今天{date}业界动态",
  });
  assert.equal(ch.queryTemplate, "今天{date}业界动态");
});

test("resolveAltChannel: aiAltQuery overrides, aiAltFile overrides name, model slug goes to title", () => {
  const ch = resolveAltChannel({
    aiAltChannel: true,
    date: "2026-08-06",
    aiAltModel: "grok-4.5",
    aiAltQueryTemplate: "格罗克视角{date}",
    aiAltFile: "AI-Grok.md",
  });
  assert.equal(ch.name, "AI-Grok.md");
  assert.equal(ch.model, "grok-4.5");
  assert.equal(ch.queryTemplate, "格罗克视角{date}");
  assert.equal(ch.title, `# AI 热点（Grok）· 2026-08-06`);
});

// --- loadConfig defaults ---

test("loadConfig: aiAltModel defaults to gemini-3.6-flash and channel to on", async () => {
  await withEnv({}, async () => {
    const config = loadConfig({ date: "2026-08-06" });
    assert.equal(config.aiAltChannel, true);
    assert.equal(config.aiAltModel, "gemini-3.6-flash");
    assert.equal(config.aiAltQueryTemplate, null);
    assert.equal(config.aiAltFile, null);
    assert.equal(config.aiAltSynthTimeoutMs, 300000);
  });
});

test("loadConfig: AI_ALT_CHANNEL=false restores single-channel", async () => {
  await withEnv({ AI_ALT_CHANNEL: "false" }, async () => {
    const config = loadConfig({ date: "2026-08-06" });
    assert.equal(config.aiAltChannel, false);
  });
});