$action = New-ScheduledTaskAction -Execute "E:\code\DallyReport\ai-daily\run-daily-task.cmd"
$trigger = New-ScheduledTaskTrigger -Daily -At 08:40
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName "ai-daily" -Action $action -Trigger $trigger -Settings $settings -Force
