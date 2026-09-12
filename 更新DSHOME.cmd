@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DSHOME - Update checkout to latest

rem ============================================================
rem  One-click update for an existing DSHOME checkout -- the
rem  "I worked on the other computer, now I am home" case:
rem
rem    1. sanity: git + bundled node/pnpm + electron must exist
rem    2. block only when TRACKED files have local changes
rem       (untracked files are reported but never block a pull)
rem    3. git pull --ff-only
rem    4. pnpm install   <- the step that actually syncs node_modules
rem                         with the package.json / pnpm-lock.yaml just pulled
rem    5. verify installed versions against the declared exact pins
rem
rem  This script NEVER starts DSHOME -- run the launcher afterwards.
rem
rem  Usage:
rem    (double-click)        full update
rem    ... update            same as double-click
rem    ... check             report only: git state + pin check, nothing changed
rem
rem  Exit code: 0 = ok / up to date, 1 = stopped, needs attention.
rem  ASCII-only on purpose: cmd.exe parses batch files with the OEM codepage,
rem  so non-ASCII prose in here can be misparsed (keep the wording in README).
rem ============================================================

set "MODE=update"
if /i "%~1"=="check" set "MODE=check"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%" || goto :fail_cd

set "NODE_DIR=%LOCALAPPDATA%\dshome-dev\node"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "PNPM_CMD=%NODE_DIR%\pnpm.cmd"
set "ELECTRON=node_modules\electron\dist\electron.exe"
set "PIN_SCRIPT=scripts\verify-pin-vs-installed.mjs"
rem core.quotepath=false keeps CJK file names readable in the git output.
set "GIT=git -c core.quotepath=false"

echo.
echo  [DSHOME] update checkout
echo  [DSHOME] root: %ROOT%
echo.

echo  [1/5] Checking prerequisites ...
where git >nul 2>nul
if errorlevel 1 goto :no_git
if not exist "%NODE_EXE%" goto :no_node
if not exist "%PNPM_CMD%" goto :no_node
if not exist "%ELECTRON%" goto :no_electron
echo        git / node / pnpm / electron: ok

echo  [2/5] Checking the git working tree ...
set "DIRTY="
rem NOTE: cmd re-parses the command inside for /f, and a key=value argument
rem like "-c core.quotepath=false" gets mangled there (the "=" reads as an
rem assignment, the key half is dropped, and git receives a stray "false"
rem subcommand). So this probe uses bare git: --flag=value is safe, key=value is not.
for /f "delims=" %%s in ('git status --porcelain --untracked-files=no') do set "DIRTY=1"
if not defined DIRTY goto :tree_clean
echo        [warn] uncommitted changes in TRACKED files:
%GIT% status --short --untracked-files=no
if /i "%MODE%"=="update" goto :dirty_tree
echo        check mode: reporting only, will not pull.
goto :after_tree

:tree_clean
echo        clean

:after_tree
%GIT% status --porcelain --untracked-files=all | findstr /c:"??" >nul
if not errorlevel 1 echo        [i] untracked files present - they do not block the update
if /i "%MODE%"=="check" goto :check_flow

echo  [3/5] git pull --ff-only ...
%GIT% pull --ff-only
if errorlevel 1 goto :fail_pull

echo  [4/5] pnpm install  (this is the step that syncs node_modules) ...
call "%PNPM_CMD%" install
if errorlevel 1 goto :fail_install
goto :pin_step

:check_flow
echo  [3/5] Local vs upstream (nothing is changed by this run):
%GIT% status -sb
echo  [4/5] Skipped pnpm install (check mode).

:pin_step
echo  [5/5] Verifying installed versions against declared pins ...
call "%NODE_EXE%" "%PIN_SCRIPT%"
if errorlevel 1 goto :pin_bad

echo.
echo  [ok] Checkout is up to date and installed packages match the pins.
echo       Next step: start DSHOME (the launcher exe, or the dev start cmd).
goto :done

:fail_cd
echo  [ERROR] cannot change directory into: %ROOT%
goto :fail

:no_git
echo  [ERROR] git is not on PATH.
echo  Install Git for Windows, or run this from a shell where "where git" works.
goto :fail

:no_node
echo  [ERROR] DSHOME-bundled node/pnpm was not found under:
echo          %NODE_DIR%
echo  Run setup-dev.cmd in the repository root first.
goto :fail

:no_electron
echo  [ERROR] the electron runtime is missing: %ELECTRON%
echo  Run setup-dev.cmd in the repository root (it installs dependencies + electron).
goto :fail

:dirty_tree
echo        [STOP] local changes found in TRACKED files - refusing to pull.
echo        Commit, stash or revert them, then run this script again.
echo        For a report-only run use:  check
goto :fail

:fail_pull
echo  [ERROR] git pull failed (diverged history, conflict, or network).
echo  Fix the git state manually, then run this script again.
goto :fail

:fail_install
echo  [ERROR] pnpm install failed - see the output above.
echo  Retry manually: "%PNPM_CMD%" install
goto :fail

:pin_bad
echo  [warn] installed packages do not match the declared pins (see above).
echo         Usually means pnpm install did not finish; re-run this script.
goto :fail

:fail
set "EXITCODE=1"

:done
echo.
rem Double-clicked (no argument) = keep the window open so the output can be read.
if "%~1"=="" pause
endlocal & exit /b %EXITCODE%
