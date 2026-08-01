import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateRuntimePaths } from "../src/config.mjs";

const ENV_KEYS = [
  "GROK_SEARCH_DIR",
  "OBSIDIAN_DIR",
  "IMAGE_PROMPT_FILE",
  "IMAGE_REF_IMAGE",
  "IMAGE_SIPS_TIMEOUT_MS",
  "GROK_DAYS",
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

test("loadConfig: derives portable defaults from the current home directory", async () => {
  await withEnv({}, async () => {
    const config = loadConfig({ date: "2026-08-01" });
    assert.equal(config.grokSearchDir, path.join(os.homedir(), ".claude", "skills", "grok-search"));
    assert.equal(
      config.obsidianDir,
      path.join(
        os.homedir(),
        "Library",
        "Mobile Documents",
        "iCloud~md~obsidian",
        "Documents",
        "obsidian-note",
        "Note",
        "AI",
        "DallyReport",
      ),
    );
    assert.equal(config.imageSipsTimeoutMs, 15000);
  });
});

test("loadConfig: explicit paths and sips timeout override defaults", async () => {
  await withEnv(
    {
      GROK_SEARCH_DIR: "/tmp/custom-grok",
      OBSIDIAN_DIR: "/tmp/custom-vault",
      IMAGE_PROMPT_FILE: "/tmp/prompt.md",
      IMAGE_REF_IMAGE: "/tmp/ref.png",
      IMAGE_SIPS_TIMEOUT_MS: "23000",
    },
    async () => {
      const config = loadConfig();
      assert.equal(config.grokSearchDir, "/tmp/custom-grok");
      assert.equal(config.obsidianDir, "/tmp/custom-vault");
      assert.equal(config.imagePromptFile, "/tmp/prompt.md");
      assert.equal(config.imageRefImage, "/tmp/ref.png");
      assert.equal(config.imageSipsTimeoutMs, 23000);
    },
  );
});

test("loadConfig: rejects invalid positive sips timeout", async () => {
  await withEnv({ IMAGE_SIPS_TIMEOUT_MS: "0" }, async () => {
    assert.throws(() => loadConfig(), /IMAGE_SIPS_TIMEOUT_MS/);
  });
});

test("validateRuntimePaths: reports missing paths without throwing", () => {
  const config = {
    grokSearchDir: "/definitely/missing/grok",
    obsidianDir: "/definitely/missing/vault",
    imagePromptFile: "/definitely/missing/prompt.md",
    imageRefImage: "/definitely/missing/ref.png",
  };
  assert.deepEqual(validateRuntimePaths(config), [
    "GROK_SEARCH_DIR 不存在：/definitely/missing/grok",
    "OBSIDIAN_DIR 不存在：/definitely/missing/vault",
    "IMAGE_PROMPT_FILE 不存在：/definitely/missing/prompt.md",
    "IMAGE_REF_IMAGE 不存在：/definitely/missing/ref.png",
  ]);
});
