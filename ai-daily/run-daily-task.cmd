@echo off
rem ai-daily 定时入口（Windows 任务计划程序 `ai-daily` 08:40）
rem 调 Git Bash 执行 Windows 版无头运行器；运行器自身再写 C:\Users\mango\.ai-daily\run-daily.log
"E:\code\Git\usr\bin\bash.exe" "E:\code\DallyReport\ai-daily\run-daily-win.sh" >> "C:\Users\mango\.ai-daily\task.out.log" 2>> "C:\Users\mango\.ai-daily\task.err.log"
