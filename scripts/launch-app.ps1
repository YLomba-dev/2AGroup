# 2A Portal launcher (the desktop icon runs this). Starts whatever is not running yet -
# Docker Desktop, the Supabase database, n8n and the portal server - then opens the
# portal in its own app window. Progress is written to data\launcher.log.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = 'http://localhost:3000/'
$log = Join-Path $root 'data\launcher.log'
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
function Log($text) { "$(Get-Date -Format s)  $text" | Out-File -Append -Encoding utf8 $log }

function Test-Url($u) {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $u).StatusCode -eq 200 } catch { $false }
}

function Wait-Until($what, $seconds, [scriptblock]$check) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $check)) {
    if ((Get-Date) -gt $deadline) { throw "$what did not start within $seconds seconds" }
    Start-Sleep -Seconds 2
  }
}

function Show-Error($text) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("$text`n`nDetails: $log", '2A Portal', 'OK', 'Error') | Out-Null
}

try {
  Log 'launch'
  if (-not (Test-Url "$($url)api/health")) {
    # 1. Docker Desktop
    $dockerOk = $false
    try { docker info *> $null; $dockerOk = ($LASTEXITCODE -eq 0) } catch { }
    if (-not $dockerOk) {
      Log 'starting Docker Desktop'
      $dd = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
      if (-not (Test-Path $dd)) { $dd = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe' }
      Start-Process $dd
      Wait-Until 'Docker Desktop' 180 { docker info *> $null; $LASTEXITCODE -eq 0 }
    }

    # 2. Supabase (database, sign-in, files) and n8n
    if (-not (Test-Url 'http://127.0.0.1:54321/auth/v1/health')) {
      Log 'starting Supabase'
      Push-Location $root
      try { & npx.cmd supabase start -x edge-runtime,imgproxy,supavisor,vector,logflare *>> $log } finally { Pop-Location }
      Wait-Until 'Supabase' 180 { Test-Url 'http://127.0.0.1:54321/auth/v1/health' }
    }
    $n8n = docker ps --filter 'name=^n8n$' --format '{{.Names}}'
    if (-not $n8n) { Log 'starting n8n'; docker start n8n *>> $log }

    # 3. Portal server (runs in the background; stop it with Task Manager > Node.js)
    Log 'starting portal server'
    $node = (Get-Command node.exe).Source
    Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $root 'data\server.log') -RedirectStandardError (Join-Path $root 'data\server-errors.log')
    Wait-Until 'The portal server' 60 { Test-Url "$($url)api/health" }
  }

  # 4. Open the portal as an app window (Chrome, or Edge if Chrome is missing).
  $browser = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($browser) { Start-Process $browser "--app=$url" } else { Start-Process $url }
  Log 'opened'
} catch {
  Log "ERROR: $_"
  Show-Error "2A Portal could not start: $_"
}
