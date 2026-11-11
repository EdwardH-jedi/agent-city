# Agent City board — open the main screen full-screen on spine (RX 6600 monitor). Design doc 07 §10 V3.
#
# What it does, and nothing else:
#   1. waits until the hub answers GET http://127.0.0.1:4317/healthz (read-only; up to -WaitSeconds)
#   2. starts Edge (or Chrome) in kiosk mode on http://127.0.0.1:4317/ with sound allowed without a
#      click (the board's 결재 knock), its own profile, no first-run or translate prompts.
# It sends no request other than that GET, changes no setting, and installs nothing.
# Run it by hand, or from the logon task that install-board.ps1 prints (owner applies it).
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\kiosk\start-board.ps1
#         [-Url http://127.0.0.1:4317/?quiet=23-8] [-Browser edge|chrome] [-WaitSeconds 300] [-DryRun]

param(
	[string]$Url = "http://127.0.0.1:4317/",
	[ValidateSet("edge", "chrome")]
	[string]$Browser = "edge",
	[int]$WaitSeconds = 300,
	[switch]$DryRun
)

$ErrorActionPreference = "Stop"

# The board is served by the hub on loopback only (CLAUDE.md rule 5). Refuse anything else.
$target = [Uri]$Url
if ($target.Host -ne "127.0.0.1" -and $target.Host -ne "localhost") {
	throw "start-board: only a loopback URL is allowed (got $($target.Host))"
}
$health = "$($target.Scheme)://$($target.Authority)/healthz"

function Find-Browser([string]$name) {
	$candidates = if ($name -eq "edge") {
		@(
			"${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
			"$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
		)
	} else {
		@(
			"$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
			"${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
			"$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
		)
	}
	foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
	throw "start-board: $name not found"
}

$exe = Find-Browser $Browser
$profileDir = Join-Path $env:LOCALAPPDATA "AgentCity\kiosk-profile-$Browser"

$browserArgs = @(
	"--kiosk", $Url,
	"--autoplay-policy=no-user-gesture-required",
	"--user-data-dir=$profileDir",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-features=Translate",
	"--disable-session-crashed-bubble",
	"--overscroll-history-navigation=0"
)
if ($Browser -eq "edge") { $browserArgs += "--edge-kiosk-type=fullscreen" }

if ($DryRun) {
	Write-Output "would wait for: GET $health"
	Write-Output "would run: `"$exe`" $($browserArgs -join ' ')"
	exit 0
}

# wait for the hub (the logon task may start before the hub's own task has bound the port)
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ($true) {
	try {
		$r = Invoke-WebRequest -Uri $health -Method Get -UseBasicParsing -TimeoutSec 3
		if ($r.StatusCode -eq 200) { break }
	} catch { }
	if ((Get-Date) -gt $deadline) { break } # open anyway: the board shows "화면 연결 끊김" and reconnects
	Start-Sleep -Seconds 3
}

Start-Process -FilePath $exe -ArgumentList $browserArgs
