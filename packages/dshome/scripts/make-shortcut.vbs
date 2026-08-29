' Create the DSHOME desktop shortcut (hidden launcher via launch.vbs).
Option Explicit
Dim wsh, fso, scriptsDir, desktop, sc, iconPath
Set wsh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptsDir = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = wsh.SpecialFolders("Desktop")
Set sc = wsh.CreateShortcut(desktop & "\DSHOME.lnk")
sc.TargetPath = "wscript.exe"
sc.Arguments = """" & scriptsDir & "\launch.vbs"""
sc.WorkingDirectory = fso.GetParentFolderName(scriptsDir)
iconPath = scriptsDir & "\..\shell-app\icon-official.png,0"
sc.IconLocation = iconPath
sc.Description = "DSHOME - DeepSeek Harness personal client"
sc.Save