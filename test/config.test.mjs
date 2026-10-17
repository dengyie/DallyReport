import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateRuntimePaths, beijingDateFor, beijingTimestampFor, KNOWN_BAD_MODELS } from "../src/config.mjs";
import { hostPaths } from "../src/host-paths.mjs";

const ENV_KEYS = [
  "GROK_SEARCH_DIR",
  "OBSIDIAN_DIR",
  "IMAGE_PROMPT_FILE",
  "IMAGE_REF_IMAGE",
  "AI_IMAGE_PROMPT_FILE",
  "AI_IMAGE_REF_IMAGE",
  "AI_IMAGE_ENABLED",
  "IMAGE_ENABLED",
  "IMAGE_SIPS_TIMEOUT_MS",
  "GROK_DAYS",
  "GROK_MODEL",
];

async function withEnv(values, fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) {
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

test("loadConfig: derives portable defaults from the current host", async () => {
  await withEnv({}, async () => {
    const config = loadConfig({ date: "2026-08-01" });
    // hostPaths() is the single source of truth: the defaults are host-derived
    // (darwin iCloud nest / win32 iCloud Drive mirror / else ~/obsidian-note), so
    // the test asserts the mechanism, not a hardcoded macOS literal — which is
    // exactly what used to make a Windows clone write outside its vault.
    const expected = hostPaths();
    assert.equal(config.grokSearchDir, expected.grokSearchDir);
    assert.equal(config.obsidianDir, expected.obsidianDir);
    assert.match(config.obsidianDir, /DallyReport$/);
    assert.equal(config.imageSipsTimeoutMs, 15000);
    assert.match(config.aiImagePromptFile, /图片生成提示词[\\/]AI 日报海报提示词\.md$/);
    assert.equal(config.aiImageRefImage, config.imageRefImage);
    assert.match(config.imageRefImage, /Pasted image 20260804185819\.png$/);
    assert.equal(config.imageEnabled, true);
    assert.equal(config.aiImageEnabled, config.imageEnabled);
  });
});

test("loadConfig: synthModel default is a working writer, not a known-bad model", async () => {
  await withEnv({}, async () => {
    const config = loadConfig({ date: "2026-08-01" });
    assert.equal(config.synthModel, "gemini-3.6-flash");
    assert.ok(
      !KNOWN_BAD_MODELS.includes(config.synthModel),
      "the shipped default writer must never be on the known-bad list",
    );
  });
});

test("loadConfig: GROK_MODEL still overrides the synthModel default", async () => {
  const previous = process.env.GROK_MODEL;
  process.env.GROK_MODEL = "deepseek-v4-pro";
  try {
    const config = loadConfig({ date: "2026-08-01" });
    assert.equal(config.synthModel, "deepseek-v4-pro");
  } finally {
    if (previous == null) delete process.env.GROK_MODEL;
    else process.env.GROK_MODEL = previous;
  }
});

test("loadConfig: explicit paths and sips timeout override defaults", async () => {
  await withEnv(
    {
      GROK_SEARCH_DIR: "/tmp/custom-grok",
      OBSIDIAN_DIR: "/tmp/custom-vault",
      IMAGE_PROMPT_FILE: "/tmp/prompt.md",
      IMAGE_REF_IMAGE: "/tmp/ref.png",
      AI_IMAGE_PROMPT_FILE: "/tmp/ai-prompt.md",
      AI_IMAGE_REF_IMAGE: "/tmp/ai-ref.png",
      AI_IMAGE_ENABLED: "false",
      IMAGE_SIPS_TIMEOUT_MS: "23000",
    },
    async () => {
      const config = loadConfig();
      assert.equal(config.grokSearchDir, "/tmp/custom-grok");
      assert.equal(config.obsidianDir, "/tmp/custom-vault");
      assert.equal(config.imagePromptFile, "/tmp/prompt.md");
      assert.equal(config.imageRefImage, "/tmp/ref.png");
      assert.equal(config.aiImagePromptFile, "/tmp/ai-prompt.md");
      assert.equal(config.aiImageRefImage, "/tmp/ai-ref.png");
      assert.equal(config.aiImageEnabled, false);
      assert.equal(config.imageSipsTimeoutMs, 23000);
    },
  );
});

test("loadConfig: image switches compose global and AI poster gates", async () => {
  await withEnv({ IMAGE_ENABLED: "false" }, async () => {
    const config = loadConfig();
    assert.equal(config.imageEnabled, false);
    assert.equal(config.aiImageEnabled, false, "AI defaults to the global switch");
  });

  await withEnv({ IMAGE_ENABLED: "false", AI_IMAGE_ENABLED: "true" }, async () => {
    const config = loadConfig();
    assert.equal(config.imageEnabled, false);
    assert.equal(config.aiImageEnabled, true, "explicit AI setting is preserved for the runtime gate");
  });

  await withEnv({ IMAGE_ENABLED: "true", AI_IMAGE_ENABLED: "false" }, async () => {
    const config = loadConfig();
    assert.equal(config.imageEnabled, true);
    assert.equal(config.aiImageEnabled, false);
  });
});

test("loadConfig: rejects invalid positive sips timeout", async () => {
  await withEnv({ IMAGE_SIPS_TIMEOUT_MS: "0" }, async () => {
    assert.throws(() => loadConfig(), /IMAGE_SIPS_TIMEOUT_MS/);
  });
});

test("beijingDateFor: maps UTC instants to the Beijing (UTC+8) calendar date", () => {
  // 16:00 UTC is 00:00 next day in Beijing — crosses the date line.
  assert.equal(beijingDateFor(Date.parse("2026-08-04T16:00:00Z")), "2026-08-05");
  // 15:59 UTC is 23:59 same day in Beijing — does not cross.
  assert.equal(beijingDateFor(Date.parse("2026-08-04T15:59:00Z")), "2026-08-04");
  // Midnight UTC is 08:00 same day in Beijing — same calendar date.
  assert.equal(beijingDateFor(Date.parse("2026-08-04T00:00:00Z")), "2026-08-04");
  // The wrap boundary itself: 16:00:00.000Z → 00:00:00 next day, not 23:59.
  assert.equal(beijingDateFor(Date.parse("2026-01-31T16:00:00Z")), "2026-02-01");
});

test("beijingTimestampFor: log stamps carry the Beijing wall-clock time (2026-10-07 P3)", () => {
  // The same instant a UTC clock prints 23:52, a Beijing wall clock prints
  // 07:52 NEXT day. Log lines must agree with the report's date — a UTC stamp
  // next to a "2026-10-07" report folder reads as a timestamp for the wrong day.
  assert.equal(
    beijingTimestampFor(Date.parse("2026-10-06T23:52:00Z")),
    "2026-10-07 07:52:00",
    "UTC 23:52 on the 6th is 07:52 on the 7th in Beijing",
  );
  // Mid-morning Beijing on the same date.
  assert.equal(
    beijingTimestampFor(Date.parse("2026-10-07T01:22:33Z")),
    "2026-10-07 09:22:33",
  );
  // Zero-padding is stable across the boundary.
  assert.equal(
    beijingTimestampFor(Date.parse("2026-01-31T16:05:07Z")),
    "2026-02-01 00:05:07",
  );
});

test("validateRuntimePaths: warns when a known-bad model is configured", () => {
  const config = { synthModel: "gpt-5.6-luna", aiAltModel: "gemini-3.6-flash", searchModel: null };
  const warnings = validateRuntimePaths(config);
  const bad = warnings.filter((w) => w.includes("已知坏模型"));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /GROK_MODEL=gpt-5\.6-luna/);
  assert.match(bad[0], /gemini-3\.6-flash/);
});

test("validateRuntimePaths: reports missing paths without throwing", () => {
  const config = {
    grokSearchDir: "/definitely/missing/grok",
    obsidianDir: "/definitely/missing/vault",
    imagePromptFile: "/definitely/missing/prompt.md",
    imageRefImage: "/definitely/missing/ref.png",
    aiImagePromptFile: "/definitely/missing/ai-prompt.md",
  };
  assert.deepEqual(validateRuntimePaths(config), [
    "GROK_SEARCH_DIR 不存在：/definitely/missing/grok",
    "OBSIDIAN_DIR 不存在：/definitely/missing/vault",
    "IMAGE_PROMPT_FILE 不存在：/definitely/missing/prompt.md",
    "IMAGE_REF_IMAGE 不存在：/definitely/missing/ref.png",
    "AI_IMAGE_PROMPT_FILE 不存在：/definitely/missing/ai-prompt.md",
  ]);
});
