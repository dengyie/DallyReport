Option Explicit
' Run <here>\run-daily-task.cmd with no console window and propagate its exit
' code. Task Scheduler's "Last Result" is the only machine-readable health signal
' these scheduled runs have; a hardcoded 0 hides every failure (the same launcher
' bug the vault sync had until 2026-10-30). bWaitOnReturn=True is what makes
' Run() return the child's exit code at all. Self-locating so a repo move or a
' re-clone on another drive does not silently break the 09:00 task.
Dim fso, shell, here, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
rc = shell.Run("cmd.exe /c """ & here & "\run-daily-task.cmd""", 0, True)
WScript.Quit rc
