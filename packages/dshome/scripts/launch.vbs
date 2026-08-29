' DSHOME launcher: starts the backend hidden and the window pops up.
' Installed layout: reads ..\install.env (INSTALL dir + PROFILE dir) and runs
' the bundled Node + the profile-installed dsh CLI.
' Fallback: standalone dsh on PATH (dev usage).
Option Explicit
Dim wsh, fso, here, envFile, instDir, profDir, nodeExe, cliBin, cmdline, desktopDshCmd
Set wsh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If wsh.Environment("PROCESS")("DSHOME_LAUNCH_TEST") = "1" Then
    wsh.Run "cmd /c echo ok > %TEMP%\dshome-launch-test.txt", 0, True
    WScript.Quit 0
End If

here = fso.GetParentFolderName(WScript.ScriptFullName)
envFile = fso.BuildPath(fso.GetParentFolderName(here), "install.env")
If fso.FileExists(envFile) Then
    Dim f, lines
    Set f = fso.OpenTextFile(envFile, 1)
    lines = Split(f.ReadAll, vbCrLf)
    f.Close
    ' install.env lines: "install-dir" / INSTALL / PROFILE
    instDir = lines(1)
    profDir = lines(2)
    nodeExe = fso.BuildPath(fso.BuildPath(instDir, "runtime"), "node.exe")
    cliBin = fso.BuildPath(fso.BuildPath(fso.BuildPath(profDir, "node_modules"), "@deepseek-ai\dsh"), "lib\bin.js")
    cmdline = """" & nodeExe & """ """ & cliBin & """ --profile dshome"
Else
    desktopDshCmd = wsh.ExpandEnvironmentStrings("%APPDATA%") & "\DSH Desktop\host-commands\desktop\bin\dsh.cmd"
    If fso.FileExists(desktopDshCmd) Then
        cmdline = """" & desktopDshCmd & """ --profile dshome"
    Else
        cmdline = "dsh --profile dshome"
    End If
End If

wsh.Run cmdline, 0, False