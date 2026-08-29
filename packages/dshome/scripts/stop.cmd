@echo off
rem DSHOME 停止：结束 3081 端口上的 dsh 后端（窗口会切到离线页，从托盘退出）。
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3081 .*LISTENING"') do taskkill /F /PID %%p >nul 2>&1
echo DSHOME 后端已停止（若此前未运行请忽略）。