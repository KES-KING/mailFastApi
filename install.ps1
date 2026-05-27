[CmdletBinding()]
param(
  [string]$ServiceUser = $env:USERNAME,
  [string]$AppDir = $PSScriptRoot,
  [switch]$SkipSystemDeps,
  [switch]$SkipService,
  [switch]$SkipNpm,
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$CoreTaskName = "mailfastapi-core"
$WebTaskName = "mailfastapi-web"
$CoreEntry = "src/app.js"
$WebEntry = "src/web.js"
$EnvFile = ".env"
$EnvTemplateFile = ".env.example"
$DefaultSecureStoreKey = "change_me_with_at_least_32_random_characters"
$NodePath = ""
$NpmPath = ""
$EnvCreated = $false

function Show-Usage {
  @"
Usage: .\install.ps1 [options]

Windows installer for mailFastApi.

Options:
  -ServiceUser <user>      reserved for parity with Linux/macOS installers
  -AppDir <path>           project directory (default: script directory)
  -SkipSystemDeps          skip Node.js package-manager install attempt
  -SkipService             skip Windows Scheduled Task registration/start
  -SkipNpm                 skip npm dependency install
  -Help                    show this help

Examples:
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  .\install.ps1 -SkipService
  .\installer.cmd -SkipNpm
"@
}

function Write-Info([string]$Message) {
  Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Err([string]$Message) {
  Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Show-Banner {
  Write-Host ""
  Write-Host " __  __       _ _ _____          _      _    ____  _" -ForegroundColor Cyan
  Write-Host "|  \/  | __ _(_) |  ___|_ _  ___| |_   / \  |  _ \(_)" -ForegroundColor Cyan
  Write-Host "| |\/| |/ _`` | | | |_ / _`` |/ __| __| / _ \ | |_) | |" -ForegroundColor Cyan
  Write-Host "| |  | | (_| | | |  _| (_| | (__| |_ / ___ \|  __/| |" -ForegroundColor Cyan
  Write-Host "|_|  |_|\__,_|_|_|_|  \__,_|\___|\__/_/   \_\_|   |_|" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Windows Installer (Core + Web)" -ForegroundColor Magenta
  Write-Host "GitHub: https://github.com/KES-KING/mailFastApi" -ForegroundColor Cyan
  Write-Host ""
}

function Resolve-AppDir {
  $script:AppDir = [System.IO.Path]::GetFullPath($AppDir)
  if (-not (Test-Path -LiteralPath $script:AppDir -PathType Container)) {
    throw "APP_DIR does not exist: $script:AppDir"
  }
}

function Assert-ProjectFiles {
  $required = @(
    "package.json",
    $CoreEntry,
    $WebEntry,
    "scripts/updater.js",
    $EnvTemplateFile
  )

  foreach ($relative in $required) {
    $path = Join-Path $script:AppDir $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "$relative not found in APP_DIR"
    }
  }
}

function Get-CommandSource([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return ""
  }
  return [string]$command.Source
}

function Get-NodeMajor([string]$Candidate) {
  if (-not $Candidate) {
    return 0
  }

  try {
    $value = & $Candidate -p "process.versions.node.split('.')[0]" 2>$null
    return [int]$value
  } catch {
    return 0
  }
}

function Test-NodeSqlite([string]$Candidate) {
  if (-not $Candidate) {
    return $false
  }

  try {
    $value = & $Candidate -p "Boolean(process.versions.sqlite)" 2>$null
    return ($LASTEXITCODE -eq 0 -and ([string]$value).Trim().ToLowerInvariant() -eq "true")
  } catch {
    return $false
  }
}

function Resolve-NodeAndNpm {
  $nodeCandidates = @(
    (Get-CommandSource "node.exe"),
    (Get-CommandSource "node"),
    "node.exe",
    "node",
    (Join-Path $env:ProgramFiles "nodejs/node.exe")
  )

  if ($env:ProgramFiles -and (Test-Path "Env:ProgramFiles(x86)")) {
    $nodeCandidates += Join-Path ${env:ProgramFiles(x86)} "nodejs/node.exe"
  }

  foreach ($candidate in $nodeCandidates) {
    if ($candidate -and (Get-NodeMajor $candidate) -ge 22 -and (Test-NodeSqlite $candidate)) {
      $script:NodePath = $candidate
      break
    }
  }

  if (-not $script:NodePath) {
    return
  }

  $npmCandidates = @(
    (Get-CommandSource "npm.cmd"),
    (Get-CommandSource "npm"),
    "npm.cmd",
    "npm",
    (Join-Path (Split-Path -Parent $script:NodePath) "npm.cmd")
  )

  foreach ($candidate in $npmCandidates) {
    if ($candidate -and ((Test-Path -LiteralPath $candidate -PathType Leaf) -or (Get-Command $candidate -ErrorAction SilentlyContinue))) {
      $script:NpmPath = $candidate
      break
    }
  }
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Install-NodeIfNeeded {
  Resolve-NodeAndNpm
  if (-not $script:NodePath -and (Get-NodeMajor "node.exe") -ge 22 -and (Test-NodeSqlite "node.exe")) {
    $script:NodePath = "node.exe"
  }
  if (-not $script:NpmPath -and -not $SkipNpm -and (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)) {
    $script:NpmPath = "npm.cmd"
  }
  if ($script:NodePath -and ($script:NpmPath -or $SkipNpm)) {
    Write-Ok "Node.js version is suitable (>=22 with node:sqlite)."
    return
  }

  if ($SkipSystemDeps) {
    throw "Node.js >=22 with node:sqlite support is required."
  }

  $winget = Get-CommandSource "winget.exe"
  $choco = Get-CommandSource "choco.exe"

  if ($winget) {
    Write-Info "Installing Node.js LTS via winget..."
    & $winget install OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
  } elseif ($choco) {
    Write-Info "Installing Node.js LTS via Chocolatey..."
    & $choco install nodejs-lts -y
  } else {
    throw "Node.js >=22 is required. Install Node.js LTS from https://nodejs.org, or install winget/Chocolatey."
  }

  Refresh-ProcessPath
  Resolve-NodeAndNpm
  if (-not $script:NodePath -or (-not $script:NpmPath -and -not $SkipNpm)) {
    throw "Could not resolve Node.js/npm after installation. Open a new terminal and rerun the installer."
  }

  Write-Ok "Node.js installed successfully."
}

function Get-EnvPath {
  return Join-Path $script:AppDir $EnvFile
}

function Get-EnvValue([string]$Key, [string]$Fallback = "") {
  $envPath = Get-EnvPath
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    return $Fallback
  }

  $prefix = "$Key="
  $matchedLines = @(Get-Content -LiteralPath $envPath | Where-Object { $_.StartsWith($prefix) })
  if ($matchedLines.Count -eq 0) {
    return $Fallback
  }

  $line = [string]$matchedLines[-1]
  $value = $line.Substring($prefix.Length)
  if ($value.Length -gt 0) {
    return $value
  }
  return $Fallback
}

function Write-TextNoBom([string]$Path, [string[]]$Lines) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($Path, $Lines, $encoding)
}

function Set-EnvValue([string]$Key, [string]$Value) {
  $envPath = Get-EnvPath
  $prefix = "$Key="
  $lines = @()
  if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    $lines = @(Get-Content -LiteralPath $envPath)
  }

  $output = New-Object System.Collections.Generic.List[string]
  $updated = $false
  foreach ($line in $lines) {
    if ($line.StartsWith($prefix)) {
      if (-not $updated) {
        [void]$output.Add("$Key=$Value")
        $updated = $true
      }
      continue
    }
    [void]$output.Add($line)
  }

  if (-not $updated) {
    if ($output.Count -gt 0 -and $output[$output.Count - 1] -ne "") {
      [void]$output.Add("")
    }
    [void]$output.Add("$Key=$Value")
  }

  Write-TextNoBom $envPath $output.ToArray()
}

function Set-EnvDefault([string]$Key, [string]$Value) {
  $envPath = Get-EnvPath
  if ((Test-Path -LiteralPath $envPath -PathType Leaf) -and
    (Get-Content -LiteralPath $envPath | Where-Object { $_.StartsWith("$Key=") } | Select-Object -First 1)) {
    return
  }
  Set-EnvValue $Key $Value
}

function New-Secret {
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Protect-EnvFile {
  $envPath = Get-EnvPath
  try {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $envPath /inheritance:r /grant:r "*${sid}:F" *> $null
  } catch {
    Write-Warn "Could not restrict .env ACL automatically."
  }
}

function Ensure-EnvFile {
  $envPath = Get-EnvPath
  $templatePath = Join-Path $script:AppDir $EnvTemplateFile

  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    Copy-Item -LiteralPath $templatePath -Destination $envPath
    $script:EnvCreated = $true
    Write-Ok ".env created from $EnvTemplateFile"
  } else {
    Write-Info ".env already exists, preserving current values."
  }

  $port = Get-EnvValue "PORT" "3000"
  $monitorToken = Get-EnvValue "MONITOR_TOKEN" ""
  $secureStoreKey = Get-EnvValue "SECURE_STORE_KEY" ""

  if (-not $monitorToken) {
    $monitorToken = New-Secret
    Write-Warn "MONITOR_TOKEN was empty. Generated a secure token."
    Set-EnvValue "MONITOR_TOKEN" $monitorToken
  }

  if (-not $secureStoreKey -or $secureStoreKey -eq $DefaultSecureStoreKey) {
    $secureStoreKey = New-Secret
    Write-Warn "SECURE_STORE_KEY was empty/default. Generated a secure vault key."
    Set-EnvValue "SECURE_STORE_KEY" $secureStoreKey
  }

  Set-EnvDefault "MONITOR_ENABLED" "true"
  Set-EnvDefault "MONITOR_UI_ENABLED" "false"
  Set-EnvDefault "MONITOR_PATH" "/monitor"
  Set-EnvDefault "METRICS_PATH" "/metrics"
  Set-EnvDefault "WEB_PORT" "8080"
  Set-EnvDefault "WEB_HOST" "0.0.0.0"
  Set-EnvDefault "WEB_CORE_BASE_URL" "http://127.0.0.1:$port"
  Set-EnvDefault "WEB_UPDATE_SCRIPT" "./scripts/updater.js"
  Set-EnvDefault "WEB_UPDATE_TIMEOUT_MS" "180000"
  Set-EnvDefault "WEB_UPDATE_TOKEN" ""
  Set-EnvDefault "UPDATER_RELEASE_MODE" "branch"
  Set-EnvDefault "UPDATER_ALLOWED_TAG_PATTERN" "^v[0-9]+\.[0-9]+\.[0-9]+$"
  Set-EnvDefault "UPDATER_REQUIRE_SIGNED_TAG" "false"
  Set-EnvDefault "UPDATER_TARGET" ""
  Set-EnvDefault "UPDATER_RUN_TESTS" "false"
  Set-EnvDefault "UPDATER_HEALTH_TIMEOUT_MS" "60000"
  Set-EnvDefault "UPDATER_LOCK_STALE_MS" "1800000"

  if ($script:EnvCreated) {
    Set-EnvValue "WEB_ENABLE_UPDATER" "true"
  } else {
    Set-EnvDefault "WEB_ENABLE_UPDATER" "true"
  }

  Protect-EnvFile
  Write-Ok ".env defaults verified."
}

function Test-RedisLocal {
  if (Get-CommandSource "redis-server.exe") {
    return $true
  }
  if (Get-CommandSource "redis-server") {
    return $true
  }
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", 6379, $null, $null)
    $connected = $iar.AsyncWaitHandle.WaitOne(300)
    if ($connected) {
      $client.EndConnect($iar)
    }
    $client.Close()
    return $connected
  } catch {
    return $false
  }
}

function Ensure-WindowsQueueDefault {
  $queueBackend = Get-EnvValue "QUEUE_BACKEND" "redis"
  if ($script:EnvCreated -and $queueBackend -eq "redis" -and -not (Test-RedisLocal)) {
    Set-EnvValue "QUEUE_BACKEND" "memory"
    Write-Warn "Redis was not detected on Windows. QUEUE_BACKEND was set to memory for first-run compatibility."
    Write-Warn "For production, install Redis-compatible service and switch QUEUE_BACKEND back to redis."
  } elseif ($queueBackend -eq "redis" -and -not (Test-RedisLocal)) {
    Write-Warn "QUEUE_BACKEND=redis but no local Redis listener was detected. Verify REDIS_URL before starting services."
  }
}

function Test-Port([int]$Port, [string]$Label) {
  try {
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
      Write-Warn "$Label port seems busy: $Port"
      return
    }
    Write-Ok "$Label port available: $Port"
  } catch {
    $netstat = (& netstat.exe -ano 2>$null) -join "`n"
    if ($netstat -match "[:.]$Port\s+") {
      Write-Warn "$Label port seems busy: $Port"
    } else {
      Write-Warn "Could not reliably verify $Label port availability."
    }
  }
}

function Ensure-RuntimeDirs {
  Write-Info "Creating runtime directories..."
  $dirs = @(
    "data",
    "run",
    "logs",
    "logs/core",
    "logs/web",
    "logs/install"
  )
  foreach ($relative in $dirs) {
    New-Item -ItemType Directory -Force -Path (Join-Path $script:AppDir $relative) | Out-Null
  }
  Write-Ok "Runtime directories ready."
}

function Invoke-NpmInstall {
  if ($SkipNpm) {
    Write-Warn "Skipping npm install by request."
    return
  }

  Write-Info "Installing npm dependencies..."
  Push-Location $script:AppDir
  try {
    & $script:NpmPath install --omit=dev
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed."
    }
  } finally {
    Pop-Location
  }
  Write-Ok "npm install completed."
}

function Invoke-SyntaxChecks {
  Write-Info "Running syntax checks..."
  Push-Location $script:AppDir
  try {
    & $script:NodePath --check $CoreEntry
    if ($LASTEXITCODE -ne 0) {
      throw "Core syntax check failed."
    }
    & $script:NodePath --check $WebEntry
    if ($LASTEXITCODE -ne 0) {
      throw "Web syntax check failed."
    }
  } finally {
    Pop-Location
  }
  Write-Ok "Syntax checks passed."
}

function Write-RunnerScript([string]$Name, [string]$Entry, [string]$LogDir) {
  $scriptPath = Join-Path $script:AppDir "run/$Name.cmd"
  $outLog = Join-Path $script:AppDir "logs/$LogDir/windows.out.log"
  $errLog = Join-Path $script:AppDir "logs/$LogDir/windows.err.log"
  $content = @(
    "@echo off",
    "cd /d `"$script:AppDir`"",
    "set NODE_ENV=production",
    "`"$script:NodePath`" `"$Entry`" >> `"$outLog`" 2>> `"$errLog`""
  )
  Write-TextNoBom $scriptPath $content
  return $scriptPath
}

function Register-MailFastApiTask([string]$TaskName, [string]$RunnerPath) {
  $action = New-ScheduledTaskAction -Execute $RunnerPath
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel LeastPrivilege

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Description "mailFastApi background task" `
    -Force | Out-Null

  Start-ScheduledTask -TaskName $TaskName
}

function Setup-WindowsTasks {
  if ($SkipService) {
    Write-Warn "Skipping service/task setup by request."
    return
  }

  if (-not (Get-Command New-ScheduledTaskAction -ErrorAction SilentlyContinue)) {
    Write-Warn "ScheduledTasks module is unavailable. Skipping task registration."
    return
  }

  Write-Info "Creating Windows Scheduled Tasks..."
  $coreRunner = Write-RunnerScript "mailfastapi-core" $CoreEntry "core"
  $webRunner = Write-RunnerScript "mailfastapi-web" $WebEntry "web"

  Register-MailFastApiTask $CoreTaskName $coreRunner
  Register-MailFastApiTask $WebTaskName $webRunner
  Write-Ok "Scheduled Tasks registered and started: $CoreTaskName, $WebTaskName"
}

function Show-PostInstall {
  $port = Get-EnvValue "PORT" "3000"
  Write-Host ""
  Write-Ok "Installation completed."
  Write-Host "Core Task : $CoreTaskName" -ForegroundColor Cyan
  Write-Host "Web Task  : $WebTaskName" -ForegroundColor Cyan
  Write-Host "App Dir   : $script:AppDir" -ForegroundColor Cyan
  Write-Host "Env File  : $(Get-EnvPath)" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "URLs (default):"
  Write-Host "  Core Health : http://127.0.0.1:$port/health"
  Write-Host "  Web Panel   : http://127.0.0.1:8080"
  Write-Host ""
  Write-Host "Useful commands:"
  Write-Host "  Get-ScheduledTask -TaskName 'mailfastapi-*'"
  Write-Host "  Start-ScheduledTask -TaskName $CoreTaskName"
  Write-Host "  Start-ScheduledTask -TaskName $WebTaskName"
  Write-Host "  Stop-ScheduledTask -TaskName $CoreTaskName"
  Write-Host "  Stop-ScheduledTask -TaskName $WebTaskName"
  Write-Host ""
  Write-Warn "The updater is git-based. Use tag mode with signed tags for stricter production releases."
  Write-Warn "Open http://127.0.0.1:8080 on first run to create the web panel password."
}

function Main {
  if ($Help) {
    Show-Usage
    return
  }

  Show-Banner
  Resolve-AppDir
  Assert-ProjectFiles

  Write-Info "App dir           : $script:AppDir"
  Write-Info "Service user      : $ServiceUser"
  Write-Info "Skip system deps  : $SkipSystemDeps"
  Write-Info "Skip service setup: $SkipService"
  Write-Info "Skip npm install  : $SkipNpm"
  Write-Host ""

  Install-NodeIfNeeded
  Ensure-EnvFile
  Ensure-WindowsQueueDefault

  $corePort = [int](Get-EnvValue "PORT" "3000")
  Test-Port $corePort "Core"
  Test-Port 8080 "Web"

  Ensure-RuntimeDirs
  Invoke-NpmInstall
  Invoke-SyntaxChecks
  Setup-WindowsTasks
  Show-PostInstall
}

try {
  Main
} catch {
  Write-Err ($_.Exception.Message)
  exit 1
}
