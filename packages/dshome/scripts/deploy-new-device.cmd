@echo off
rem DSHOME deploy on a new device.
rem Prereq (either):
rem   A. standalone: Node.js 22/24 + `npm i -g pnpm` + `npm i -g @deepseek-ai/dsh@0.1.1-rc.2`
rem   B. DSH Desktop installed (bundles CLI + pnpm; zero Node setup)
rem The template's file: deps use the E:/DSH placeholder; deploy re-points it to the
rem actual clone location (see REPO below), so the repo can live at any path.
setlocal
set "PROFILE=%USERPROFILE%\.dsh\profiles\dshome"
rem Repo root = this script's location (packages\dshome\scripts -> repo root).
set "REPO=%~dp0..\..\.."

rem 1) Profile + dependencies (official npm flow, all pinned 0.1.1-rc.2)
if exist "%PROFILE%\package.json" (
    echo DSHOME profile already exists: %PROFILE%
    echo Skipping install (remove the folder to redeploy).
) else (
    mkdir "%PROFILE%" 2>nul
    copy /y "%~dp0..\profile-template\package.json" "%PROFILE%\package.json" >nul
    copy /y "%~dp0..\profile-template\pnpm-workspace.yaml" "%PROFILE%\pnpm-workspace.yaml" >nul
    rem Re-point the E:/DSH placeholder in the copied profile to this clone's real path.
    node -e "const f=process.argv[1],path=require('path'),a=path.resolve(process.argv[2]).replace(/\\/g,'/'),c=require('fs').readFileSync(f,'utf8'),o=c.split('E:/DSH').join(a);require('fs').writeFileSync(f,o)" "%PROFILE%\package.json" "%REPO%"
    pushd "%PROFILE%"
    echo Installing DSHOME dependencies (pnpm install)...
    call pnpm install
    popd
    if not exist "%PROFILE%\node_modules\@deepseek-ai\dsh-base" (
        echo pnpm install did not produce the expected tree. Check connectivity / mirror.
        exit /b 1
    )
    echo DSHOME profile installed at %PROFILE%
)

rem 2) 灵魂行为层：AGENTS.md / soul/ / skills/ 拷到目标 DSH_HOME（新设备从零获得框架模板，之后各自自进化）
set "DEST_HOME=%USERPROFILE%\.dsh"
if not exist "%DEST_HOME%\AGENTS.md" copy /y "%REPO%\AGENTS.md" "%DEST_HOME%\AGENTS.md" >nul 2>&1
if not exist "%DEST_HOME%\soul\Learn.md" (
    mkdir "%DEST_HOME%\soul" 2>nul
    copy /y "%REPO%\soul\Learn.md" "%DEST_HOME%\soul\Learn.md" >nul 2>&1
)
if not exist "%DEST_HOME%\skills\dsh-evolve-integration\SKILL.md" (
    mkdir "%DEST_HOME%\skills" 2>nul
    robocopy "%REPO%\skills" "%DEST_HOME%\skills" /E /NFL /NDL /NJH /NJS >nul 2>&1
)

rem 3) Electron runtime for the shell window (installed into the dshome package)
set "DSHOME_PKG=%REPO%\packages\dshome"
if not exist "%DSHOME_PKG%\node_modules\electron\dist\electron.exe" (
    pushd "%DSHOME_PKG%"
    echo Installing Electron (mirror for CN networks)...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    call npm install --save-dev electron@43.4.0
    popd
    if not exist "%DSHOME_PKG%\node_modules\electron\dist\electron.exe" (
        echo Electron install failed. Download the zip from the mirror manually.
    )
)

rem 4) Desktop shortcut: hidden launcher -> backend + window
wscript.exe "%~dp0make-shortcut.vbs"
echo Shortcut created: Desktop\DSHOME.lnk
echo Done. Double-click DSHOME to start (backend runs hidden, window pops up).
endlocal