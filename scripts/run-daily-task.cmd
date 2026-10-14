@echo off
rem DallyReport scheduled daily run. ALL logging is owned by src\resilient-run.mjs
rem (single-point log()/logErr() write to console AND logs\task.{out,err}.log), so
rem this launcher must NOT redirect: a `>>` here would double-write every line and
rem hold the log file open, which breaks resilient-run's log rotation on Windows.
cd /d E:\code\DallyReport
"C:\Program Files\nodejs\node.exe" src\resilient-run.mjs