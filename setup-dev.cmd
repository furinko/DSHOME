@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DSHOME Dev Environment Setup

rem ============================================================
rem  DSHOME dev environment one-shot installer (node + pnpm)
rem  Everything lives under %LOCALAPPDATA%\dshome-dev
rem  No admin rights. No registry changes. No system installs.
rem  To uninstall: delete that folder (and remove the PATH entry
rem  if you chose to add it during setup).
rem ============================================================

set "DEV_DIR=%LOCALAPPDATA%\dshome-dev"
set "NODE_VERSION=24.19.0"
set "PNPM_VERSION=10"
set "NODE_MIRROR=https://npmmirror.com/mirrors/node"
set "NODE_ZIP=node-v%NODE_VERSION%-win-x64.zip"
set "NODE_URL=%NODE_MIRROR%/v%NODE_VERSION%/%NODE_ZIP%"
set "NODE_DIR=%DEV_DIR%\node"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "PKG_DIR=%~dp0"

echo.
echo  [DSHOME] Dev environment setup
echo  [DSHOME] install dir : %DEV_DIR%
echo.

rem ---------------- 1. node ----------------
if exist "%NODE_EXE%" (
  "%NODE_EXE%" -v >nul 2>&1
  if not errorlevel 1 (
    echo  [DSHOME] node already installed: %NODE_VERSION% ^(skip download^)
    goto :node_ok
  )
)

echo  [DSHOME] downloading node %NODE_VERSION% ...
if not exist "%DEV_DIR%" mkdir "%DEV_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%DEV_DIR%\%NODE_ZIP%' -UseBasicParsing"
if errorlevel 1 goto :fail_download

echo  [DSHOME] verifying sha256 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "(Invoke-WebRequest -Uri '%NODE_MIRROR%/v%NODE_VERSION%/SHASUMS256.txt' -UseBasicParsing).Content | Out-File -Encoding ascii '%DEV_DIR%\SHASUMS256.txt'"
if errorlevel 1 goto :fail_checksum

set "EXPECT="
for /f "usebackq tokens=1" %%h in (`findstr /i "%NODE_ZIP%" "%DEV_DIR%\SHASUMS256.txt"`) do set "EXPECT=%%h"
if not defined EXPECT goto :fail_checksum

set "ACTUAL="
for /f "skip=1 delims=" %%a in ('certutil -hashfile "%DEV_DIR%\%NODE_ZIP%" SHA256') do if not defined ACTUAL set "ACTUAL=%%a"
if /i not "%ACTUAL%"=="%EXPECT%" goto :fail_checksum

echo  [DSHOME] sha256 OK
echo  [DSHOME] extracting ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%DEV_DIR%\%NODE_ZIP%' -DestinationPath '%DEV_DIR%' -Force"
if errorlevel 1 goto :fail_extract

move /y "%DEV_DIR%\node-v%NODE_VERSION%-win-x64" "%NODE_DIR%" >nul
del /q "%DEV_DIR%\%NODE_ZIP%" "%DEV_DIR%\SHASUMS256.txt" 2>nul

:node_ok
set "PATH=%NODE_DIR%;%PATH%"
"%NODE_EXE%" -v

rem ---------------- 2. pnpm ----------------
echo.
if exist "%NODE_DIR%\pnpm.cmd" (
  echo  [DSHOME] pnpm already installed
) else (
  echo  [DSHOME] installing pnpm@%PNPM_VERSION% ...
  call "%NODE_DIR%\npm.cmd" install -g pnpm@%PNPM_VERSION% --registry=https://registry.npmmirror.com
  if errorlevel 1 goto :fail_pnpm
)
call "%NODE_DIR%\pnpm.cmd" --version

rem ---------------- 3. optional user PATH ----------------
echo.
choice /c YN /n /m "  [DSHOME] Add node to user PATH so '开发启动.cmd' works from anywhere? [Y/N] "
if errorlevel 2 goto :no_path

powershell -NoProfile -ExecutionPolicy Bypass -Command "$u=[Environment]::GetEnvironmentVariable('Path','User'); if ($u -notlike '*dshome-dev\node*') { [Environment]::SetEnvironmentVariable('Path', $u + ';' + '%NODE_DIR%', 'User'); Write-Output 'PATH updated' } else { Write-Output 'PATH already set' }"
echo  [DSHOME] user PATH updated. New terminals will pick it up.
goto :after_path

:no_path
echo  [DSHOME] OK, keeping PATH untouched (local only).

:after_path
rem ---------------- 4. install dependencies ----------------
echo.
cd /d "%PKG_DIR%"
echo  [DSHOME] pnpm install ...
call "%NODE_DIR%\pnpm.cmd" install
if errorlevel 1 goto :fail_install

rem ---------------- 5. electron binary ----------------
echo.
echo  [DSHOME] pnpm setup ^(electron binary via npmmirror^) ...
call "%NODE_DIR%\pnpm.cmd" run setup
if errorlevel 1 goto :fail_setup

echo.
echo  ============================================================
echo   DSHOME dev environment ready!
echo   node  : %NODE_VERSION%   ^(%NODE_DIR%^)
echo   pnpm  : %PNPM_VERSION%
echo   start : 开发启动.cmd
echo   uninstall: delete %DEV_DIR%
echo  ============================================================
echo.
endlocal
exit /b 0

:fail_download
echo  [ERROR] node download failed: %NODE_URL%
goto :fail_cleanup

:fail_checksum
echo  [ERROR] sha256 mismatch for %NODE_ZIP% (network glitch or mirror issue)
goto :fail_cleanup

:fail_extract
echo  [ERROR] extract failed
goto :fail_cleanup

:fail_pnpm
echo  [ERROR] pnpm install failed
goto :fail_cleanup

:fail_install
echo  [ERROR] pnpm install failed
goto :fail_cleanup

:fail_setup
echo  [ERROR] electron setup failed
goto :fail_cleanup

:fail_cleanup
echo.
echo  [DSHOME] setup FAILED. You can retry: setup-dev.cmd
echo  [DSHOME] partial files stay in %DEV_DIR% (safe to delete).
endlocal
exit /b 1
