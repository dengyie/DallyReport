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
    console.log("未安装（plist 不存在），无需卸载。");
  }
  console.log("✓ 完成。");
} catch (err) {
  console.error(`✖ 卸载失败: ${err.message}`);
  process.exit(1);
}