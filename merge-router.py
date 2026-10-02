#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""合并 AI-DOC-ROUTER.md 被拼接的两张路由表为一张。"""
import io, sys

PATH = r"E:/profile/note/note/00.MOC/AI-DOC-ROUTER.md"
lines = open(PATH, encoding="utf-8").read().splitlines()

def rowname(line):
    cells = [c.strip() for c in line.split("|")]
    return cells[1].strip("*").strip()

# ---- 收集块1（41-125）与块2（144-308）的行 ----
b1 = {}   # name -> (lineno, text)
b1_order = []
for i in range(41, 126):
    l = lines[i-1]
    if l.startswith("| **"):
        n = rowname(l)
        b1[n] = l
        b1_order.append(n)

b2 = {}
b2_order = []
for i in range(144, 309):
    l = lines[i-1]
    if l.startswith("| **"):
        n = rowname(l)
        b2[n] = l
        b2_order.append(n)

# ---- 仲裁：共享行取哪条线 ----
take_b2 = {
    "ainovel 文章质量优先 / 上游对照",
    "CPA",
    "Grok 注册 / free Build",
    "awesome-skills / Codex Skill 维护",
    "automation-kit 平台",
    "开源自动化框架对比",
    "Google VPS",
    "xianyu-auto-bot",
    "Beszel 监控",
    "Hermes / TG bot",
    "探针后台运行（最佳实践）",
    "国内社媒自动化发布 / 一键发布",
}
# B1 基准行里丢弃的 Mac 行（文档将删除）
drop_b1 = {
    "本机 macOS 常驻进程 / 垃圾清理",
    "本机 macOS 服务 / 菜单栏指示器",
    "本机 macOS 服务排障 / Spotlight 索引",
}
# 块2独有行里跳过的 Mac 行（文档将删除）
skip_b2_unique = {"ZCode 桌面端性能与维护（Mac）", "本机 macOS 常驻进程 / 内存与垃圾清理"}

out_rows = []
for n in b1_order:
    if n in drop_b1:
        continue
    if n in take_b2 and n in b2:
        out_rows.append(b2[n])
    else:
        out_rows.append(b1[n])

added = 0
for n in b2_order:
    if n in b1 or n in skip_b2_unique:
        continue
    out_rows.append(b2[n])
    added += 1

# ---- 组装新文件 ----
new = []
new += lines[0:11]           # frontmatter + 空行 (1-11)
new += lines[11:12]          # # AI 文档路由表（给 Agent 用） (12)
new += lines[13:14]          # blockquote 规则行 (14)
new.append("")
new.append("## 速读（当前有效 · 维护于 2026-10-02）")
new += lines[21:28]          # 10-01 速读块内容（去标题行21）
new.append("")
new += lines[29:36]          # 怎么用 (30-36)
new.append("")
new.append("## 路由表")
new.append("")
new.append(lines[38])        # 表头 (39)
new.append(lines[39])        # 分隔 (40)
new += out_rows
new.append("")
new += lines[126:143]        # 生产真相速记 (127-143)

open(PATH, "w", encoding="utf-8", newline="\n").write("\n".join(new) + "\n")
print("B1 rows kept:", len(out_rows) - added, " B2 unique added:", added, " total:", len(out_rows))
