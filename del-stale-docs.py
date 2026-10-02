#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""删除过时文档：全部 " 2.md" 旧冲突副本（原版存在才删）+ Mac 专属文档 + 日报 09-01 副本。"""
import subprocess, os

os.chdir(r"E:/profile/note/note")

def lsfiles(pat):
    r = subprocess.run(["git", "ls-files", "-z"], capture_output=True)
    return [p.decode("utf-8") for p in r.stdout.split(b"\0") if pat in p.decode("utf-8")]

def wexists(p):
    return os.path.exists(p)

to_rm = []

# 1) Note/Infra 与 Note/AI 下的 " 2.md" 冲突副本（原版存在才删）
for p in lsfiles(" 2.md"):
    if p.startswith(("Note/Infra", "Note/infra", "Note/AI/经验")) and not p.startswith("Note/AI/DallyReport/achieve"):
        orig = p.replace(" 2.md", ".md")
        if wexists(orig):
            to_rm.append(p)

# 2) Mac 专属文档（Mac 已完全删除）
for p in lsfiles("macOS") + lsfiles("macOS ") + lsfiles("本机 macOS"):
    if p.startswith("Note/") and "Archive" not in p and "achieve" not in p:
        to_rm.append(p)
for p in lsfiles("ZCode 桌面端性能"):
    to_rm.append(p)

# 3) 日报 09-01 冲突副本
for p in lsfiles("DallyReport/2026-09-01"):
    if " 2.md" in p:
        to_rm.append(p)

to_rm = sorted(set(to_rm))
for p in to_rm:
    print("DEL", p)

if to_rm:
    r = subprocess.run(["git", "rm", "-q", "--"] + to_rm, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("git rm rc:", r.returncode)
    if r.returncode != 0:
        print(r.stderr[:2000])
