# TrueMeet installer for Windows. No admin rights; everything goes in %LOCALAPPDATA%\TrueMeet.
#   irm https://raw.githubusercontent.com/ranjitmani61/truemeet/main/install.ps1 | iex
# Uses your Node.js if it is 20.11 or newer; otherwise downloads a private copy, verified against
# nodejs.org's published SHA-256 sums. Run it again to update; delete the folder to uninstall.
#   $env:TRUEMEET_HOME = 'D:\TrueMeet'   install somewhere else
#   $env:TRUEMEET_NO_START = '1'         install only, don't start
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is far faster without its progress bar
$Repo = 'ranjitmani61/truemeet'
$NodeVersion = '24.11.0'
$Dir = if ($env:TRUEMEET_HOME) { $env:TRUEMEET_HOME } else { Join-Path $env:LOCALAPPDATA 'TrueMeet' }

function Say($Message) { Write-Host "> $Message" -ForegroundColor Magenta }
function Test-Node($Exe) {
  if (-not $Exe -or -not (Test-Path $Exe)) { return $false }
  & $Exe -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)' 2>$null
  return $LASTEXITCODE -eq 0
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
New-Item -ItemType Directory -Force $Dir | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('truemeet-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  $system = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (Test-Node $system) {
    $node = $system
    Say "Using your Node.js $(& $node -v)"
  } else {
    $node = Join-Path $Dir 'node\node.exe'
    if (-not (Test-Node $node)) {
      $name = "node-v$NodeVersion-win-$arch"
      Say "Downloading Node.js $NodeVersion ($arch)..."
      Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$NodeVersion/$name.zip" -OutFile "$tmp\node.zip"
      $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt").Content -split "`n"
      $want = ($sums | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))$" } | Select-Object -First 1) -replace '\s.*$', ''
      $got = (Get-FileHash "$tmp\node.zip" -Algorithm SHA256).Hash.ToLower()
      if (-not $want -or $want -ne $got) { throw "the Node.js download didn't match its published checksum" }
      Expand-Archive "$tmp\node.zip" $tmp -Force
      Remove-Item -Recurse -Force (Join-Path $Dir 'node') -ErrorAction SilentlyContinue
      Move-Item (Join-Path $tmp $name) (Join-Path $Dir 'node')
    }
  }

  Say 'Downloading TrueMeet...'
  Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile "$tmp\app.zip"
  Expand-Archive "$tmp\app.zip" "$tmp\app" -Force
  $app = Get-ChildItem "$tmp\app" -Directory | Select-Object -First 1
  if (-not (Test-Path (Join-Path $app.FullName 'server.js'))) { throw 'the TrueMeet download looks incomplete' }
  Remove-Item -Recurse -Force (Join-Path $Dir 'app') -ErrorAction SilentlyContinue
  Move-Item $app.FullName (Join-Path $Dir 'app')

  # The launcher takes port 3000 (or %PORT%): whatever else is listening there is stopped first.
  $launcher = Join-Path $Dir 'truemeet.cmd'
  $free = 'Get-NetTCPConnection -LocalPort $env:PORT -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Host (''Port '' + $env:PORT + '': stopping '' + $p.ProcessName + '' (PID '' + $p.Id + '')''); Stop-Process -Id $p.Id -Force } }'
  Set-Content $launcher "@echo off`r`nif not defined PORT set PORT=3000`r`npowershell -NoProfile -Command `"$free`"`r`n`"$node`" `"$(Join-Path $Dir 'app\server.js')`" %*" -Encoding ASCII
  Say "Installed. Start it any time with: $launcher"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if (-not $env:TRUEMEET_NO_START) {
  Say 'Starting TrueMeet (Ctrl+C to stop)...'
  & (Join-Path $Dir 'truemeet.cmd')
}
