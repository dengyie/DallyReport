// HTML -> PNG, by driving the Chrome that is already installed on the machine.
//
// Why a browser at all, when this project already talks to one over CDP for
// linux.do: that path drives the user's LOGGED-IN personal Chrome, which is
// exactly the wrong dependency for a 09:00 unattended job — quit the browser
// and the run breaks. This launches its own headless instance instead, so the
// poster renders whether or not anything is open. It is also fast (sub-second)
// and free, against a ~126s image-API call that can time out at the gateway.
//
// The alternative was a diffusion image model, which is why this module exists
// at all. gpt-image-2 cannot typeset: it corrupted 官方→教据源, 美元→葵元,
// 颁奖→颌奖 (identical wrong glyphs at 2x and 4x OCR), duplicated panels,
// dropped stories, invented section headings, and collapsed the type size
// halfway down a 10-row table. No prompt change fixes a capability gap, so the
// text is laid out by a real typesetting engine and only pixels are captured.

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { trackChild } from "../child-tracker.mjs";

// Rendered at 2x so CJK glyphs land on whole device pixels. At 1x a 20px
// 汉字 is rasterised across an odd number of device pixels and looks soft in a
// way that is obvious next to the Latin text on the same line.
const DEVICE_SCALE = 2;

const DEFAULT_TIMEOUT_MS = 45_000;

// Where Chrome lives, most specific first. Resolved lazily and memoised: the
// candidates are absolute paths, so a miss costs a few stat calls, not a
// subprocess.
function windowsChromeCandidates() {
  const local = process.env.LOCALAPPDATA;
  const roots = ["C:\\Program Files", "C:\\Program Files (x86)", local].filter(Boolean);
  const rels = [
    ["Google", "Chrome", "Application", "chrome.exe"],
    ["Microsoft", "Edge", "Application", "msedge.exe"],
    ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
  ];
  const out = [];
  for (const root of roots) {
    for (const rel of rels) out.push(path.join(root, ...rel));
  }
  return out;
}

const CHROME_CANDIDATES = [
  process.env.POSTER_CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ...(process.platform === "win32" ? windowsChromeCandidates() : []),
].filter(Boolean);

export class PosterRenderError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "PosterRenderError";
    this.code = code;
    Object.assign(this, extra);
  }
}

let cachedChromeBin;
async function resolveChromeBin() {
  if (cachedChromeBin !== undefined) return cachedChromeBin;
  for (const bin of CHROME_CANDIDATES) {
    try {
      await access(bin);
      cachedChromeBin = bin;
      return bin;
    } catch {
      // try the next candidate
    }
  }
  cachedChromeBin = null;
  return null;
}

// Test seam: lets a suite assert the argv without a browser present.
export function buildChromeArgs({ htmlPath, outPath, width, height, scale = DEVICE_SCALE }) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    // A poster must never inherit a dark-mode or forced-colors stylesheet from
    // the host OS; the design below declares its own colours outright.
    "--force-color-profile=srgb",
    "--disable-lcd-text",
    `--force-device-scale-factor=${scale}`,
    `--window-size=${width},${height}`,
    // Chrome returns from --screenshot as soon as the load event fires, which
    // can be before webfonts settle. This gives layout a beat to finish.
    "--virtual-time-budget=2000",
    `--screenshot=${outPath}`,
    // pathToFileURL, not `file://${htmlPath}`: a Windows path `C:\…\poster.html`
    // becomes `file://C:\…`, which Chrome does not load. On POSIX the result is
    // the same `file:///tmp/a.html` the tests already lock.
    pathToFileURL(htmlPath).href,
  ];
}

function runChrome(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Chrome prints GPU/display warnings to stderr on a headless macOS host
    // (CVDisplayLinkCreateWithCGDisplay failed) and still exits 0. They are not
    // failures, so stderr is captured but never used as an error signal; only
    // the exit code and a missing/empty PNG are.
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    // Registered, not merely awaited. macOS does not propagate a signal to
    // children, so a SIGINT/SIGTERM to the 09:00 job during a render would
    // leave this headless Chrome running with the profile lock held — and the
    // `finally` in renderHtmlToPng never runs inside a signal handler, so its
    // temp dir would leak too. Not detached: Chrome shares our process group,
    // and a group kill would take the report down with it.
    trackChild(child);
    let stderr = "";
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      // No signal on win32: Node's child.kill("SIGKILL") is not a portable kill.
      try {
        child.kill(process.platform === "win32" ? undefined : "SIGKILL");
      } catch {
        /* already gone */
      }
      finish(reject, new PosterRenderError("POSTER_RENDER_TIMEOUT", `海报渲染超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stderr.on("data", (d) => {
      if (stderr.length < 4000) stderr += String(d);
    });
    child.on("error", (err) =>
      finish(reject, new PosterRenderError("POSTER_RENDER_SPAWN", `无法启动 Chrome：${err.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) return finish(resolve, null);
      finish(
        reject,
        new PosterRenderError("POSTER_RENDER_EXIT", `Chrome 退出码 ${code}`, { stderr: stderr.slice(0, 2000) }),
      );
    });
  });
}

/**
 * Render an HTML document to a PNG buffer.
 *
 * Returns the raw PNG bytes; the caller decides where they go. Throws
 * PosterRenderError with a `code` on every failure path, because a poster that
 * silently did not render is indistinguishable from a poster that rendered
 * blank, and the second one ships.
 */
export async function renderHtmlToPng(html, { width, height, scale = DEVICE_SCALE, timeoutMs = DEFAULT_TIMEOUT_MS, deps = {} } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new PosterRenderError("POSTER_BAD_SIZE", `海报尺寸无效：${width}x${height}`);
  }
  const bin = deps.chromeBin ?? (await resolveChromeBin());
  if (!bin) {
    throw new PosterRenderError(
      "POSTER_NO_CHROME",
      "未找到 Chrome/Chromium/Edge，无法渲染海报。可用 POSTER_CHROME_BIN 指定可执行文件路径。",
    );
  }
  const run = deps.spawnFn || runChrome;
  const dir = await mkdtemp(path.join(os.tmpdir(), "dally-poster-"));
  const htmlPath = path.join(dir, "poster.html");
  const outPath = path.join(dir, "poster.png");
  try {
    await writeFile(htmlPath, html, "utf8");
    await run(bin, buildChromeArgs({ htmlPath, outPath, width, height, scale }), timeoutMs);
    // Chrome exits 0 on some failures and has been seen to write a 0-byte file
    // when the renderer dies under memory pressure. Read the bytes and check
    // the PNG magic ourselves rather than trusting the exit code.
    const buf = await readFile(outPath).catch(() => null);
    if (!buf || buf.length === 0) {
      throw new PosterRenderError("POSTER_EMPTY_PNG", "Chrome 退出成功但没有产出 PNG");
    }
    if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
      throw new PosterRenderError("POSTER_NOT_PNG", "渲染产物不是合法 PNG", { head: buf.subarray(0, 8).toString("hex") });
    }
    // The size is the last thing that can be wrong, and it is the one the reader
    // would notice. Chrome exits 0 having been told to produce 3200x1800 and
    // can hand back 1600x900 (1x, soft CJK) or a clipped viewport instead: a
    // real PNG, the wrong one. Only the IHDR knows, and its width/height sit at
    // fixed big-endian offsets 16..24. Checked before the read, because a
    // truncated file would throw ERR_OUT_OF_RANGE and escape this module's
    // error taxonomy entirely.
    if (buf.length < 33) {
      throw new PosterRenderError("POSTER_TRUNCATED_PNG", `PNG 只有 ${buf.length} 字节，读不出尺寸`);
    }
    const actualW = buf.readUInt32BE(16);
    const actualH = buf.readUInt32BE(20);
    const wantW = Math.round(width * scale);
    const wantH = Math.round(height * scale);
    if (actualW !== wantW || actualH !== wantH) {
      throw new PosterRenderError(
        "POSTER_BAD_DIM",
        `渲染尺寸不符：期望 ${wantW}x${wantH}（${width}x${height} @ ${scale}x），实际 ${actualW}x${actualH}`,
      );
    }
    return buf;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
