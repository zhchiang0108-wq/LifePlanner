@echo off
setlocal
cd /d "%~dp0" || exit /b 1
set "NODEDIR=%CD%\.runtime\node-v24.22.3-win-x64"
if exist "%NODEDIR%\node.exe" set "PATH=%NODEDIR%;%PATH%"
set "BUNDLED=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if /i "%~1"=="status" goto status
if /i "%~1"=="setup" goto setup
if /i "%~1"=="run" goto supervise
if /i "%~1"=="--worker" goto setup
echo Usage: planner.cmd setup ^| status ^| run
exit /b 2

:supervise
if exist "%NODEDIR%\node.exe" goto localsupervisor
if exist "%BUNDLED%" goto bundledsupervisor
node -e "process.exit(process.versions.node.split('.')[0]==='24'?0:1)" >nul 2>&1
if errorlevel 1 goto install
:localsupervisor
node scripts\supervise.mjs
exit /b %errorlevel%
:bundledsupervisor
"%BUNDLED%" scripts\supervise.mjs
exit /b %errorlevel%

:status
node -e "process.exit(process.versions.node.split('.')[0]==='24'?0:1)" >nul 2>&1
if not errorlevel 1 goto nodestatus
if not exist "%BUNDLED%" goto missing
"%BUNDLED%" --version
"%BUNDLED%" scripts\loop.mjs --status
exit /b %errorlevel%
:nodestatus
node --version
node scripts\loop.mjs --status
exit /b %errorlevel%
:missing
echo Node.js 24 is required. Run planner.cmd setup.
exit /b 1

:setup
where codex.exe >nul 2>&1 || (echo Codex CLI is missing. & exit /b 1)
codex.exe login status || exit /b 1
node -e "process.exit(process.versions.node.split('.')[0]==='24'?0:1)" >nul 2>&1
if errorlevel 1 goto install
call npm.cmd --version >nul 2>&1
if not errorlevel 1 goto packages
:install
if not exist ".runtime" mkdir ".runtime" || exit /b 1
echo Installing portable Node.js 24 and npm for this project...
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $v='v24.22.3'; $n='node-'+$v+'-win-x64.zip'; $u='https://nodejs.org/dist/'+$v+'/'; $tmp=Join-Path (Resolve-Path '.runtime') ([guid]::NewGuid().ToString()); $null=New-Item -ItemType Directory $tmp; $z=Join-Path $tmp $n; $s=(Invoke-WebRequest -UseBasicParsing ($u+'SHASUMS256.txt')).Content; if($s -is [byte[]]){$s=[Text.Encoding]::UTF8.GetString($s)}; $m=[regex]::Match($s,'(?im)^([a-f0-9]{64})\s+\*?'+[regex]::Escape($n)+'\s*$'); if(!$m.Success){throw 'Missing official checksum'}; Invoke-WebRequest -UseBasicParsing ($u+$n) -OutFile $z; if((Get-FileHash $z).Hash -ne $m.Groups[1].Value){throw 'SHA256 mismatch'}; Expand-Archive -LiteralPath $z -DestinationPath $tmp; $dir=Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($n)); if(!(Test-Path (Join-Path $dir 'npm.cmd'))){throw 'npm missing'}; Move-Item -LiteralPath $dir -Destination (Resolve-Path '.runtime'); Remove-Item -LiteralPath $z; Remove-Item -LiteralPath $tmp"
if errorlevel 1 exit /b 1
set "PATH=%NODEDIR%;%PATH%"
if /i "%~1"=="run" goto localsupervisor
:packages
node --version || exit /b 1
call npm.cmd --version || exit /b 1
if not exist ".runtime\tools" mkdir ".runtime\tools" || exit /b 1
if not exist ".runtime\tools\package.json" echo {"private":true}>".runtime\tools\package.json"
if exist ".runtime\tools\node_modules\.bin\playwright.cmd" if exist ".runtime\tools\node_modules\embedded-postgres\package.json" goto browsers
call npm.cmd install --prefix ".runtime\tools" --save-exact embedded-postgres playwright || exit /b 1
:browsers
set "PLAYWRIGHT_BROWSERS_PATH=%CD%\.runtime\browsers"
call ".runtime\tools\node_modules\.bin\playwright.cmd" install chromium || exit /b 1
if exist package.json (
  call npm.cmd install --include=dev --no-audit --no-fund || exit /b 1
)
if /i "%~1"=="--worker" (
  node scripts\environment.mjs run
) else (
  node scripts\environment.mjs "%~1"
)
exit /b %errorlevel%
