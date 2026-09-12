@echo off
rem DSHOME dev launcher (v0.3.1)
rem Starts the Electron shell; the shell launches+guards the backend via DSHOME_BACKEND_CMD.
rem No extra console windows. Closing this cmd does NOT stop DSHOME.
rem To stop: tray menu -> Exit (or close DSHOME window and tray).
set "DSH_HOME=%~dp0"
rem Auto-detect local dev node (installed by setup-dev.cmd) without touching user PATH.
if exist "%LOCALAPPDATA%\dshome-dev\node\node.exe" (
  set "PATH=%LOCALAPPDATA%\dshome-dev\node;C:\Windows\System32;C:\Windows;%PATH%"
)
rem 安装版兜底：仓库自带 node 运行时（打包安装时 payload\runtime\node.exe）。
if not exist "%LOCALAPPDATA%\dshome-dev\node\node.exe" (
  if exist "%~dp0runtime\node.exe" set "PATH=%~dp0runtime;C:\Windows\System32;C:\Windows;%PATH%"
)
rem Electron 图标自检：任务栏按钮图标取「运行进程 exe 内嵌图标」（这正是不打补丁就显示原子图标的原因）。
rem clone 出来的机器 node_modules 不跟踪 ⇒ 必然重下原版 electron.exe，补丁脚本必须真跑过。
rem 这里只体检、不改文件（自检失败就中止并指路，改文件交给 install-electron 一条链做）。
where node >nul 2>nul
if not errorlevel 1 (
  node "%~dp0scripts\patch-electron-icon.mjs" --verify-only --quiet
  if errorlevel 1 (
    echo [DSHOME] electron.exe 未带 DSHOME 图标 ^(任务栏会显示 Electron 原子图标^)。
    echo [DSHOME] 修：先关掉 DSHOME，再跑  node scripts\install-electron.mjs
    pause
    exit /b 1
  )
) else (
  echo [DSHOME] 找不到 node，跳过图标自检。^(装机版请用安装包自带的 node^)
)
set "DSHOME_BACKEND_CMD=node %DSH_HOME%node_modules\@deepseek-ai\dsh\lib\bin.js --profile dshome --no-open --port 3099"
if not defined DEEPSEEK_API_KEY (
  echo [hint] For chat, set your key first:
  echo        set DEEPSEEK_API_KEY=sk-xxxxxxxx
)
start "" "%DSH_HOME%node_modules\electron\dist\electron.exe" "%DSH_HOME%packages\dshome\shell-app"
echo DSHOME starting... window will open. You can close this window now.
