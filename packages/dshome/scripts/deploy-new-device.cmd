@echo off
rem DSHOME deploy on a new device.
rem Prereq (either):
rem   A. standalone: Node.js 22/24 + `npm i -g pnpm` + `npm i -g @deepseek-ai/dsh@0.1.1-rc.2`
rem   B. DSH Desktop installed (bundles CLI + pnpm; zero Node setup)
rem Repo paths on the new machine must match the file: deps in profile/package.json:
rem   E:\DSH\dshome and E:\DSH\packages\dshome-theme
setlocal
set "PROFILE=%USERPROFILE%\.dsh\profiles\dshome"

rem 1) Profile + dependencies (official npm flow, all pinned 0.1.1-rc.2)
if exist "%PROFILE%\package.json" (
    echo DSHOME profile already exists: %PROFILE%
    echo Skipping install (remove the folder to redeploy).
) else (
    mkdir "%PROFILE%" 2>nul
    copy /y "%~dp0..\profile-template\package.json" "%PROFILE%\package.json" >nul
    copy /y "%~dp0..\profile-template\pnpm-workspace.yaml" "%PROFILE%\pnpm-workspace.yaml" >nul
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

rem 2) Electron runtime for the shell window (installed into the dshome package)
if not exist "E:\DSH\dshome\node_modules\electron\dist\electron.exe" (
    pushd "E:\DSH\dshome"
    echo Installing Electron (mirror for CN networks)...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    call npm install --save-dev electron@43.4.0
    popd
    if not exist "E:\DSH\dshome\node_modules\electron\dist\electron.exe" (
        echo Electron install failed. Download the zip from the mirror manually.
    )
)

rem 3) Desktop shortcut: hidden launcher -> backend + window
wscript.exe "%~dp0make-shortcut.vbs"
echo Shortcut created: Desktop\DSHOME.lnk
echo Done. Double-click DSHOME to start (backend runs hidden, window pops up).
endlocal