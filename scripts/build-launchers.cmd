@echo off
rem DSHOME launcher/uninstaller build (ISSUE-003)
rem Uses the Windows built-in .NET Framework csc.exe; zero third-party deps.
rem Outputs at repo root: DSHOME.exe (launcher) + UninstallDSHOME.exe (uninstaller)
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] csc.exe not found: %CSC%
  exit /b 1
)
set "ROOT=%~dp0.."
"%CSC%" /nologo /target:winexe /platform:x64 /out:"%ROOT%\DSHOME.exe" "%~dp0launcher.cs" || exit /b 1
"%CSC%" /nologo /target:winexe /platform:x64 /out:"%ROOT%\UninstallDSHOME.exe" "%~dp0uninstaller.cs" || exit /b 1
echo [DSHOME] launchers built:
echo   %ROOT%\DSHOME.exe
echo   %ROOT%\UninstallDSHOME.exe
endlocal
