$t = Get-ScheduledTask -TaskName ai-daily
Write-Host "State:" $t.State
Write-Host "Execute:" $t.Actions[0].Execute
Write-Host "TriggerAt:" $t.Triggers[0].StartBoundary
$i = Get-ScheduledTaskInfo -TaskName ai-daily
Write-Host "NextRunTime:" $i.NextRunTime
Write-Host "LastRunTime:" $i.LastRunTime
Write-Host "LastTaskResult:" $i.LastTaskResult
