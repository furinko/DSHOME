@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DSHOME - Update pnpm

rem ============================================================
rem  Update the DSHOME-bundled pnpm only.
rem  node is left untouched; no admin rights, no system install.
rem  Pairs with setup-dev.cmd: that one installs node + pnpm,
rem  this one updates pnpm.
rem
rem  Usage:
rem    update-pnpm.cmd            update to the latest pnpm 10.x (default;
rem                               staying on the same major is the safest)
rem    update-pnpm.cmd check      show current + available version, change nothing
rem    update-pnpm.cmd latest     update to the newest major (may change the
rem                               lockfileVersion written into pnpm-lock.yaml,
rem                               which produces big diffs across machines)
rem    update-pnpm.cmd 10.34.5    install one specific version
rem
rem  Exit code: 0 = ok, 1 = failed. This file is ASCII-only on purpose:
rem  cmd.exe reads batch files with the OEM codepage, so non-ASCII text here
rem  can be misparsed (use English output, keep the explanations in README).
rem ============================================================

set "NODE_DIR=%LOCALAPPDATA%\dshome-dev\node"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CMD=%NODE_DIR%\npm.cmd"
set "PNPM_CMD=%NODE_DIR%\pnpm.cmd"
rem Default is the China mirror; on failure the script retries the official registry.
set "REGISTRY=https://registry.npmmirror.com"
set "FALLBACK_REGISTRY=https://registry.npmjs.org"

set "EXITCODE=0"
set "MODE=update"
set "TARGET=pnpm@10"
if /i "%~1"=="check"  set "MODE=check"
if /i "%~1"=="latest" set "TARGET=pnpm@latest"
if not "%~1"=="" if /i not "%~1"=="check" if /i not "%~1"=="latest" set "TARGET=pnpm@%~1"

echo.
echo  [DSHOME] update pnpm
echo  [DSHOME] dir: %NODE_DIR%
echo.

if not exist "%NODE_EXE%" goto :no_node
if not exist "%NPM_CMD%"  goto :no_node
if not exist "%PNPM_CMD%" echo  [i] pnpm is not installed yet - installing.

echo  [1/3] Current version:
set "OLD="
if exist "%PNPM_CMD%" for /f "delims=" %%v in ('"%PNPM_CMD%" --version 2^>nul') do set "OLD=%%v"
if defined OLD (echo        pnpm %OLD%) else (echo        pnpm [none])

if /i "%MODE%"=="check" goto :check_only

echo  [2/3] Installing %TARGET% from %REGISTRY% ...
call "%NPM_CMD%" install -g %TARGET% --registry=%REGISTRY%
if errorlevel 1 goto :retry_official

:after_install
echo  [3/3] Verifying:
set "NEW="
for /f "delims=" %%v in ('"%PNPM_CMD%" --version 2^>nul') do set "NEW=%%v"
if not defined NEW goto :fail_verify
echo        pnpm %NEW%
if defined OLD if not "%OLD%"=="%NEW%" echo        -^> updated: %OLD% to %NEW%
if defined OLD if "%OLD%"=="%NEW%" echo        -^> already up to date, nothing changed.
echo.
echo  [ok] done. To sync repository dependencies next: pnpm install
goto :done

:check_only
echo  [2/3] Querying the newest build on %REGISTRY% (nothing is changed) ...
set "AVAIL="
for /f "delims=" %%v in ('call "%NPM_CMD%" view %TARGET% version --registry=%REGISTRY% 2^>nul') do set "AVAIL=%%v"
if not defined AVAIL goto :check_fail
echo        available: %AVAIL%
echo  [3/3] Run this script with no argument to install it.
echo.
echo  [ok] check only - nothing was changed.
goto :done

:retry_official
echo.
echo  [warn] mirror failed, retrying with the official registry ...
call "%NPM_CMD%" install -g %TARGET% --registry=%FALLBACK_REGISTRY%
if errorlevel 1 goto :fail_install
goto :after_install

:no_node
echo  [ERROR] DSHOME-bundled node was not found:
echo          %NODE_EXE%
echo  Run setup-dev.cmd in the repository root first (it installs node + pnpm).
goto :fail

:check_fail
echo  [warn] version query failed (network or mirror unreachable).
echo         Running this script without arguments will still try to install.
goto :done

:fail_install
echo  [ERROR] pnpm install failed (both registries unreachable, or the folder is not writable).
echo  Retry manually: "%NPM_CMD%" install -g %TARGET% --registry=%FALLBACK_REGISTRY%
goto :fail

:fail_verify
echo  [ERROR] install reported success but pnpm --version returns nothing.
echo  Please inspect: %PNPM_CMD%
goto :fail

:fail
set "EXITCODE=1"

:done
echo.
rem Keep the window open only when double-clicked (cmdcmdline then names this
rem script); a command-line call must never block on a keypress.
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause
endlocal & exit /b %EXITCODE%
