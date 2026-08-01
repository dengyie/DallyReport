import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { EventEmitter } from "node:events";
import { generateGithubPoster, extractPrompt, buildContextualPrompt, sipsDownscale } from "../src/image-gen.mjs";

// Load .env if present so cred-gated paths behave like the synthesize tests.
if (existsSync(path.resolve(process.cwd(), ".env"))) {
  try {
    const dotenv = await import("dotenv");
    dotenv.config();
  } catch {
    /* dotenv is a dependency; if missing, cred tests just skip */
  }
}

// A 1x1 transparent PNG for the reference-image path so image-gen doesn't bail
// on IMG_BAD_REF. sips downscale is disabled via deps.sips=false so no shelling out.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

// Minimal config object (loadConfig shape, subset image-gen uses).
function cfg(over = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dally-img-"));
  const promptFile = path.join(tmp, "prompt.md");
  writeFileSync(
    promptFile,
    "----\n# note\n\n正文\n\n````\n生成一张 {date} GitHub 日榜简报海报\n````\n",
  );
  const ref = path.join(tmp, "ref.png");
  writeFileSync(ref, PNG_1x1);
  return {
    imagePromptFile: promptFile,
    imageRefImage: ref,
    imageModel: "gpt-image-2",
    imageSize: "1024x1024",
    imageTimeoutMs: 5000,
    imageRetries: 0,
    cacheDir: tmp,
    obsidianDir: path.join(tmp, "out"),
    date: "2026-07-31",
    ...over,
  };
}

// stubFetch returns a fetch impl that records calls and answers the next queued
// response. Each entry: { status, ct, body } where body is an object (JSON) or
// a string (raw). Mirrors the synthesize stub pattern.
function stubFetch(queue) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = queue[Math.min(i, queue.length - 1)];
    i++;
    const status = r.status ?? 200;
    const ct = r.ct ?? "application/json";
    const bodyStr =
      typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? ct : null) },
      async text() {
        return bodyStr;
      },
      async json() {
        return JSON.parse(bodyStr);
      },
    };
  };
  fn.calls = calls;
  return fn;
}

// A real-ish b64 image (the 1x1 PNG) so the decode path produces bytes.
const B64_IMG = PNG_1x1.toString("base64");

test("sipsDownscale: timeout terminates child and cleans temporary output", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dally-sips-timeout-"));
  const tmpOut = path.join(dir, "downscaled.jpg");
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  let timedOut = false;

  const result = await sipsDownscale("/source.png", tmpOut, {
    spawnImpl: () => child,
    timeoutMs: 10,
    graceMs: 10,
    onTimeout: () => {
      timedOut = true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(result, null);
  assert.equal(timedOut, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(existsSync(tmpOut), false);
});

test("sipsDownscale: reads successful output and removes temporary file", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dally-sips-success-"));
  const tmpOut = path.join(dir, "downscaled.jpg");
  const child = new EventEmitter();
  const output = Buffer.from("fake jpeg bytes");

  const resultPromise = sipsDownscale("/source.png", tmpOut, {
    spawnImpl: () => {
      writeFileSync(tmpOut, output);
      process.nextTick(() => child.emit("exit", 0));
      return child;
    },
    timeoutMs: 100,
  });
  const result = await resultPromise;

  assert.deepEqual(result, { buf: output, mime: "image/jpeg" });
  assert.equal(existsSync(tmpOut), false);
});

// --- extractPrompt ---

test("extractPrompt: pulls the first fenced block", () => {
  const md = "# x\n\n````\n生成一张海报\n````\n\n````\n精简版\n````";
  assert.equal(extractPrompt(md), "生成一张海报");
});

test("extractPrompt: 3-backtick fences too", () => {
  const md = "```\nhi\n```";
  assert.equal(extractPrompt(md), "hi");
});

test("extractPrompt: no fence -> stripped raw text, not null", () => {
  const md = "---\ntitle: x\n---\n\nplain body";
  assert.equal(extractPrompt(md), "plain body");
});

test("extractPrompt: empty input -> null", () => {
  assert.equal(extractPrompt(""), null);
  assert.equal(extractPrompt(null), null);
});

// --- buildContextualPrompt ---

test("buildContextualPrompt: injects raw description + Chinese-render instruction", () => {
  const out = buildContextualPrompt("base {date}", {
    date: "2026-07-31",
    repos: [
      { repo: "a/b", starsToday: 5, starsTotal: 10, description: "First sentence. Second sentence ignored." },
      { repo: "c/d", starsToday: 1, starsTotal: 2, description: "中文单句介绍。第二句忽略。" },
      { repo: "e/f", starsToday: 0, starsTotal: null, description: null },
    ],
  });
  assert.ok(!out.includes("{date}"), "date placeholder replaced");
  // One-sentence truncation: only the first sentence of the raw desc is passed.
  assert.match(out, /a\/b — 今日 Star \+5，总 Star 10（原始简介：First sentence\.）/);
  assert.match(out, /c\/d — 今日 Star \+1，总 Star 2（原始简介：中文单句介绍。）/);
  // A repo with no description renders the data head with no 原始简介 suffix.
  assert.match(out, /e\/f — 今日 Star \+0，总 Star —/);
  assert.doesNotMatch(out, /e\/f[^\n]*原始简介/);
  // The prompt must instruct the model to render descriptions in Chinese.
  assert.match(out, /翻译成\*\*中文\*\*/);
  // And keep the project name in its original (English owner/repo) form.
  assert.match(out, /项目名用上面给出的原始 owner\/repo（英文，保持原样，不要翻译）/);
});

test("buildContextualPrompt: description without a terminator is kept whole (raw)", () => {
  const out = buildContextualPrompt("base {date}", {
    date: "2026-07-31",
    repos: [{ repo: "a/b", starsToday: 5, starsTotal: 10, description: "No period here just text" }],
  });
  assert.match(out, /原始简介：No period here just text/);
});

test("buildContextualPrompt: no repos -> just date substitution", () => {
  const out = buildContextualPrompt("base {date} end", { date: "2026-07-31", repos: [] });
  assert.equal(out, "base 2026-07-31 end");
});

// --- generateGithubPoster ---

const HAVE_CREDS = !!process.env.GROK_API_URL && !!process.env.GROK_API_KEY;
const maybeCreds = HAVE_CREDS ? test : test.skip;

maybeCreds("image-gen: edits success writes PNG + embed path", async () => {
  const c = cfg();
  const fetchStub = stubFetch([
    { status: 200, ct: "application/json", body: { data: [{ b64_json: B64_IMG }] } },
  ]);
  const res = await generateGithubPoster(c, [{ repo: "a/b", starsToday: 5, starsTotal: 10 }], {
    fetch: fetchStub,
    sips: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.usedFallback, false);
  assert.match(res.file, /GitHub\.png$/);
  // The file actually landed with PNG bytes.
  const written = readFileSync(res.file);
  assert.equal(written[0], 0x89);
  assert.equal(written[1], 0x50);
  // edits is the first call
  assert.match(fetchStub.calls[0].url, /\/images\/edits$/);
});

maybeCreds("image-gen: 524 with valid image body is salvaged (not an error)", async () => {
  // CPA quirk: status 524 but JSON body carries a real image.
  const c = cfg();
  const fetchStub = stubFetch([
    { status: 524, ct: "application/json", body: { data: [{ b64_json: B64_IMG }] } },
  ]);
  const res = await generateGithubPoster(c, [{ repo: "a/b", starsToday: 5, starsTotal: 10 }], {
    fetch: fetchStub,
    sips: false,
  });
  assert.equal(res.ok, true, "524-with-image must be salvaged as success");
  assert.equal(res.error, null);
});

maybeCreds("image-gen: edits 524 (html) then retry then generations fallback", async () => {
  const c = cfg({ imageRetries: 1 });
  // call1 edits -> 524 html; call2 edits retry -> 524 html; call3 generations -> image
  const fetchStub = stubFetch([
    { status: 524, ct: "text/html; charset=UTF-8", body: "<html>524</html>" },
    { status: 524, ct: "text/html; charset=UTF-8", body: "<html>524</html>" },
    { status: 200, ct: "application/json", body: { data: [{ b64_json: B64_IMG }] } },
  ]);
  const res = await generateGithubPoster(c, [{ repo: "a/b", starsToday: 5, starsTotal: 10 }], {
    fetch: fetchStub,
    sips: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.usedFallback, true, "should fall back to generations");
  // first two calls edits, third generations
  assert.match(fetchStub.calls[0].url, /\/images\/edits$/);
  assert.match(fetchStub.calls[1].url, /\/images\/edits$/);
  assert.match(fetchStub.calls[2].url, /\/images\/generations$/);
});

maybeCreds("image-gen: HTTP 400 (non-retryable) -> skip retries, go generations fallback", async () => {
  const c = cfg({ imageRetries: 2 });
  const fetchStub = stubFetch([
    { status: 400, ct: "application/json", body: { error: { message: "bad model" } } },
    { status: 200, ct: "application/json", body: { data: [{ b64_json: B64_IMG }] } },
  ]);
  const res = await generateGithubPoster(c, [{ repo: "a/b", starsToday: 5, starsTotal: 10 }], {
    fetch: fetchStub,
    sips: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.usedFallback, true);
  // 400 is not retryable -> only one edits call, then generations
  assert.equal(fetchStub.calls.length, 2);
  assert.match(fetchStub.calls[0].url, /\/images\/edits$/);
  assert.match(fetchStub.calls[1].url, /\/images\/generations$/);
});

maybeCreds("image-gen: all attempts fail -> IMG_HTTP_ERROR, ok false", async () => {
  const c = cfg({ imageRetries: 1 });
  const fetchStub = stubFetch([
    { status: 524, ct: "text/html", body: "<html>524</html>" },
    { status: 524, ct: "text/html", body: "<html>524</html>" },
    { status: 524, ct: "text/html", body: "<html>524</html>" },
  ]);
  const res = await generateGithubPoster(c, [{ repo: "a/b", starsToday: 5, starsTotal: 10 }], {
    fetch: fetchStub,
    sips: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "IMG_HTTP_ERROR");
  assert.equal(res.error.status, 524);
});

maybeCreds("image-gen: fetch TimeoutError -> IMG_TIMEOUT { aborted }", async () => {
  const c = cfg({ imageRetries: 0 });
  const fetchStub = async () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    throw e;
  };
  // generations also times out
  const res = await generateGithubPoster(c, [{ repo: "a/b", starsToday: 5, starsTotal: 10 }], {
    fetch: fetchStub,
    sips: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "IMG_TIMEOUT");
  assert.equal(res.error.aborted, true);
});

maybeCreds("image-gen: 200 but empty data -> IMG_EMPTY then generations fallback ok", async () => {
  const c = cfg();
  const fetchStub = stubFetch([
    { status: 200, ct: "application/json", body: { data: [] } },
    { status: 200, ct: "application/json", body: { data: [{ b64_json: B64_IMG }] } },
  ]);
  const res = await generateGithubPoster(c, [{ repo: "a/b", starsToday: 5, starsTotal: 10 }], {
    fetch: fetchStub,
    sips: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.usedFallback, true);
});

maybeCreds("image-gen: url branch fetches + PNG signature check", async () => {
  const c = cfg();
  // generations returns a url; the second fetch (url download) returns the PNG bytes.
  const pngBuf = PNG_1x1;
  const fetchStub = async (url) => {
    if (String(url).endsWith("/images/edits")) {
      // edits returns empty so we fall to generations
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return { data: [] };
        },
        async text() {
          return JSON.stringify({ data: [] });
        },
      };
    }
    if (String(url).endsWith("/images/generations")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return { data: [{ url: "https://img.example/x.png" }] };
        },
        async text() {
          return JSON.stringify({ data: [{ url: "https://img.example/x.png" }] });
        },
      };
    }
    // url download
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      async arrayBuffer() {
        return pngBuf.buffer.slice(pngBuf.byteOffset, pngBuf.byteOffset + pngBuf.byteLength);
      },
    };
  };
  const res = await generateGithubPoster(c, [{ repo: "a/b", starsToday: 5, starsTotal: 10 }], {
    fetch: fetchStub,
    sips: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.usedFallback, true);
});

maybeCreds("image-gen: missing prompt file -> IMG_BAD_PROMPT", async () => {
  const c = cfg({ imagePromptFile: "/no/such/prompt.md" });
  const res = await generateGithubPoster(c, [], { fetch: () => {}, sips: false });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "IMG_BAD_PROMPT");
});

maybeCreds("image-gen: write failure -> IMG_WRITE_FAILED", async () => {
  const c = cfg({ obsidianDir: "/no/such/root/dir/that/cannot/exist/out" });
  const fetchStub = stubFetch([
    { status: 200, ct: "application/json", body: { data: [{ b64_json: B64_IMG }] } },
  ]);
  const res = await generateGithubPoster(c, [{ repo: "a/b", starsToday: 5, starsTotal: 10 }], {
    fetch: fetchStub,
    sips: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "IMG_WRITE_FAILED");
});

test("image-gen: missing creds -> MISSING_IMAGE_CREDS", async (t) => {
  if (process.env.GROK_API_URL && process.env.GROK_API_KEY) {
    t.skip("creds present in env; skipping the missing-creds case");
    return;
  }
  const c = cfg();
  const res = await generateGithubPoster(c, [], { fetch: () => {}, sips: false });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "MISSING_IMAGE_CREDS");
});
