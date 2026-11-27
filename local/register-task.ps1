# Registers (or updates) a Windows scheduled task that runs the Coze daily claim at 04:20.
# Run once from PowerShell:  powershell -ExecutionPolicy Bypass -File local\register-task.ps1
# Requires Node.js + "npm install" + "npx playwright install chromium" in the repo root first.

$ErrorActionPreference = 'Stop'

$taskName = 'CozeDailyCredit'
$batPath = Join-Path $PSScriptRoot 'run-daily.bat'
if (-not (Test-Path -LiteralPath $batPath)) {
    throw "run-daily.bat not found next to this script: $batPath"
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$batPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At '04:20'

# WakeToRun lets a sleeping machine run it; a powered-off machine still cannot.
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description 'Coze daily credit claim (local runner)' | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Output "Registered task $taskName"
Write-Output ("Next run time: " + $info.NextRunTime)
Write-Output ("Log file: " + (Join-Path $PSScriptRoot 'run.log'))
Write-Output 'Manual test:  Start-ScheduledTask -TaskName CozeDailyCredit'
