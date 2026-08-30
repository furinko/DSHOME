@echo off
rem DSHOME dev launcher (E:\DSHOME v0.2.0)
rem Starts backend; the dshome-shell plugin auto-opens the Electron window.
set "DSH_HOME=%~dp0"
if not defined DEEPSEEK_API_KEY (
  echo [hint] For chat, set your key first:
  echo        set DEEPSEEK_API_KEY=sk-xxxxxxxx
)
echo Starting DSHOME backend...
node "%DSH_HOME%node_modules\@deepseek-ai\dsh\lib\bin.js" --profile dshome --no-open --port 3099
