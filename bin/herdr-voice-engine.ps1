# Engine wrapper — Windows "hands" machine. Runs in the console user's
# interactive session via the HerdrVoiceEngine scheduled task (audio devices
# are per-session; an ssh session has none). Tunnels are engine children.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$hostAlias = if ($env:HERDR_VOICE_HOST) { $env:HERDR_VOICE_HOST } else { 'studio' }
$owner = if ($env:HERDR_VOICE_OWNER) { $env:HERDR_VOICE_OWNER } else { 'pc' }

# Tooling: winget's Gyan.FFmpeg (ffmpeg + ffplay) and Node; OpenSSH is in System32.
$extra = @()
foreach ($d in (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg*\*\bin" -Directory -ErrorAction SilentlyContinue)) { $extra += $d.FullName }
foreach ($d in (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\OpenJS.NodeJS*\node-*" -Directory -ErrorAction SilentlyContinue)) { $extra += $d.FullName }
$extra += 'C:\Windows\System32\OpenSSH'
$env:Path = (($extra + $env:Path) -join ';')

# singleton engine (its child tunnels die with it)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'herdr-voice' -and $_.CommandLine -match 'engine\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 300

$logDir = Join-Path $HOME '.cache\herdr-voice'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'engine.log'
"[$(Get-Date -Format s)] engine starting (host=$hostAlias owner=$owner)" | Out-File $log -Append

# cmd does the redirection: PowerShell's *>> wraps every stderr line of a
# native command in a NativeCommandError record, burying the real log.
& cmd /c "node ""$root\src\engine.js"" --tunnel-host $hostAlias --owner $owner >> ""$log"" 2>&1"
"[$(Get-Date -Format s)] engine exited rc=$LASTEXITCODE" | Out-File $log -Append
