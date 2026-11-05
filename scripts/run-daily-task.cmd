@echo off
rem DallyReport scheduled daily run. ALL logging is owned by src\resilient-run.mjs
rem (single-point log()/logErr() write to console AND logs\task.{out,err}.log), so
rem this launcher must NOT redirect: a `>>` here would double-write every line and
rem hold the log file open, which breaks resilient-run's log rotation on Windows.
cd /d E:\code\DallyReport
rem 2026-11-06: gateway calls go through the local clash mixed port (loopback path),
rem bypassing the fragile TUN-adapter state (11-04 incident: the TUN path dropped every
rem connection, the gateway saw ZERO requests, both channels shipped empty shells).
rem Only enabled when 7897 is alive; NO_PROXY keeps CDP(9222) and localhost direct.
curl -s --max-time 1 http://127.0.0.1:7897 >nul 2>&1
if %errorlevel%==0 (
  set "http_proxy=http://127.0.0.1:7897"
  set "https_proxy=http://127.0.0.1:7897"
  set "NO_PROXY=localhost,127.0.0.1,::1"
  set "NODE_USE_ENV_PROXY=1"
)
"C:\Program Files\nodejs\node.exe" src\resilient-run.mjs