# Agent City board — the always-on setup for spine (RX 6600). Design doc 07 §10 V3.
#
# PRINT-ONLY by default: it shows every change it would make and changes nothing. Applying them is
# the owner's call (doc §10 V3: "RX 적용은 owner 승인 후"); re-run with -Apply to make them.
#
# What -Apply would change (current user only, nothing machine-wide except power settings):
#   1. a Scheduled Task "AgentCity Board" that runs start-board.ps1 at THIS user's logon, interactive
#      (a screen needs a logged-on desktop; the hub/heartbeat tasks run S4U without one and cannot
#      show a window)
#   2. power: never turn the display off, never sleep while on AC (powercfg, current scheme)
#   3. screen saver off for this user (HKCU\Control Panel\Desktop)
#
# What it never does:
#   - Windows automatic logon. Without it the board appears after someone logs in. Enabling it stores a
#     password and is a separate owner decision (doc §12.1); this script has no switch for it.
#   - anything to the hub, its tasks, .env, tokens or ~/.claude / ~/.codex.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\kiosk\install-board.ps1
#         [-Url http://127.0.0.1:4317/] [-Browser edge|chrome] [-Apply]
#         -Uninstall [-Apply]   removes the task (power / screen saver are left as they are)

param(
	[string]$Url = "http://127.0.0.1:4317/",
	[ValidateSet("edge", "chrome")]
	[string]$Browser = "edge",
	[switch]$Apply,
	[switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "AgentCity Board"
$start = Join-Path $PSScriptRoot "start-board.ps1"
$user = "$env:USERDOMAIN\$env:USERNAME"

function Step([string]$what, [scriptblock]$do) {
	if ($Apply) {
		Write-Output "apply: $what"
		& $do
	} else {
		Write-Output "would: $what"
	}
}

if ($Uninstall) {
	Step "remove scheduled task '$TaskName'" {
		Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
	}
	if (-not $Apply) { Write-Output "(print-only; re-run with -Apply to remove it)" }
	exit 0
}

if (-not (Test-Path $start)) { throw "install-board: $start not found" }

$argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$start`" -Url `"$Url`" -Browser $Browser"

Step "register scheduled task '$TaskName': at logon of $user, interactive, run: powershell.exe $argLine" {
	$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine
	$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
	$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
	$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
		-ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
	Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
		-Principal $principal -Settings $settings -Force | Out-Null
}

Step "power (current scheme, AC): display off never, sleep never, hibernate never" {
	powercfg /change monitor-timeout-ac 0
	powercfg /change standby-timeout-ac 0
	powercfg /change hibernate-timeout-ac 0
}

Step "screen saver off for $user (HKCU:\Control Panel\Desktop ScreenSaveActive=0)" {
	Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name ScreenSaveActive -Value "0"
	Remove-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name SCRNSAVE.EXE -ErrorAction SilentlyContinue
}

if (-not $Apply) {
	Write-Output ""
	Write-Output "Nothing was changed. Review the lines above, then run again with -Apply."
	Write-Output "Not included on purpose: Windows automatic logon (owner decision, doc 07 §12.1)."
}
