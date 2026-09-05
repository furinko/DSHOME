@echo off
rem DSHOME dev launcher (v0.3.0)
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
set "DSHOME_BACKEND_CMD=node %DSH_HOME%node_modules\@deepseek-ai\dsh\lib\bin.js --profile dshome --no-open --port 3099"
if not defined DEEPSEEK_API_KEY (
  echo [hint] For chat, set your key first:
  echo        set DEEPSEEK_API_KEY=sk-xxxxxxxx
)
start "" "%DSH_HOME%node_modules\electron\dist\electron.exe" "%DSH_HOME%packages\dshome\shell-app"
echo DSHOME starting... window will open. You can close this window now.
