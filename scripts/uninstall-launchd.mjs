#!/usr/bin/env node
// uninstall-launchd.mjs — remove the DallyReport LaunchAgent.
// Inverse of install-launchd.mjs. Safe to run when nothing is installed.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LABEL = "com.mango.dallyreport";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

try {
  if (fs.existsSync(PLIST)) {
    const res = spawnSync("launchctl", ["unload", PLIST], { stdio: "inherit" });
    if (res.status !== 0) {
      console.error(`✖ launchctl unload 失败 (${res.status})，请手动检查: launchctl remove ${LABEL}`);
      process.exit(1);
    }
    fs.unlinkSync(PLIST);
    console.log(`✓ 已卸载 launchd 任务并删除 ${PLIST}`);
  } else {
    console.log("未安装（plist 不存在）。仍尝试清理可能残留的已加载任务…");
    // A job can outlive its plist (plist deleted by hand, or a stale load) and
    // keep running at 09:00. `launchctl remove` is harmless when nothing is
    // loaded — run it regardless and just report the outcome.
    const res = spawnSync("launchctl", ["remove", LABEL], { stdio: "ignore" });
    console.log(
      res.status === 0
        ? `✓ 已移除残留的已加载任务 ${LABEL}（无 plist 文件）`
        : `没有名为 ${LABEL} 的已加载任务，无需处理。`,
    );
  }
  console.log("✓ 完成。");
} catch (err) {
  console.error(`✖ 卸载失败: ${err.message}`);
  process.exit(1);
}