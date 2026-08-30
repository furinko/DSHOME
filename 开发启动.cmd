@echo off
rem DSHOME dev launcher (E:\DSHOME v0.2.0)
rem Backend runs in a minimized window; this cmd exits immediately.
rem Closing this cmd does NOT stop the backend.
rem To stop: close the minimized "DSHOME-backend" window (or taskkill).
set "DSH_HOME=%~dp0"
if not defined DEEPSEEK_API_KEY (
  echo [hint] For chat, set your key first:
  echo        set DEEPSEEK_API_KEY=sk-xxxxxxxx
)
echo Starting DSHOME backend (minimized window)...
start "DSHOME-backend" /min node "%DSH_HOME%node_modules\@deepseek-ai\dsh\lib\bin.js" --profile dshome --no-open --port 3099
echo Backend starting... DSHOME window will open shortly. You can close this window now.
