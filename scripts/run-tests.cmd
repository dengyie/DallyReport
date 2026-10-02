@echo off
cd /d E:\code\DallyReport
del /s /q /f ._* >nul 2>&1
"C:\Program Files\nodejs\node.exe" --test "test\\*.test.mjs"

