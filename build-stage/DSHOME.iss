; DSHOME Setup Script — Inno Setup 7（全量自包含安装包，含 node_modules 与自带 node 运行时）
; 构建：ISCC.exe DSHOME.iss  →  build-stage\DSHOME-setup-0.2.0.exe
; ISSUE-003 修复（2026-09-01）：
;   ① [Files] Excludes 排除 profiles\node_modules（dsh 首启自愈重建为 junction，不得随包分发）
;   ② 启动入口 exe 化：快捷方式/装后启动直接指向 {app}\DSHOME.exe（布局无关启动器，无控制台闪烁）
;   ③ Uninstallable=yes + CreateUninstallRegKey=no：生成卸载 exe（unins000.exe）但零注册表残留
#define MyAppName "DSHOME"
#define MyAppVersion "0.3.0"
#define MyAppPublisher "furinko"
; 启动入口：DSHOME.exe（scripts\launcher.cs 编译的布局无关启动器，逻辑同 开发启动.cmd；
; Electron 壳在 <home>\packages\dshome\shell-app，后端由壳拉起/守护）
#define MyAppExe "DSHOME.exe"
; 快捷方式/安装程序图标：packages\dshome\shell-app\icon.ico（生成自 scripts\gen-icon.ps1）
#define MyAppIcon "{app}\packages\dshome\shell-app\icon.ico"

[Setup]
AppId={{B2E8F0A3-4C5D-4E6F-8A9B-0C1D2E3F4A5B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppVerName={#MyAppName} {#MyAppVersion}
; 安装程序自身图标（相对 build-stage\ 的仓库路径）
SetupIconFile=..\packages\dshome\shell-app\icon.ico
DefaultDirName={autopf}\DSHOME
DisableProgramGroupPage=yes
OutputDir=.
OutputBaseFilename=DSHOME-setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
; 卸载 exe：安装目录根 unins000.exe（双击即卸载），开始菜单另有"卸载 DSHOME"入口；
; CreateUninstallRegKey=no 保持零注册表残留（不做控制面板卸载项）
Uninstallable=yes
CreateUninstallRegKey=no
CloseApplications=no
RestartIfNeededByRun=no

[Files]
; Excludes：profiles\node_modules 是 dsh 首启自愈生成的 junction 集合，7z/Inno 均不保留
; junction 语义——随包分发必被实体化 → ensureSymlink 自检失败（ISSUE-003）。打包前应先跑
; `node scripts\verify-payload.mjs --fix` 隔离 payload 中的实体树，此处排除为双保险。
; ⚠️ 注意：Inno 字符串里 `\n` 是换行转义，掩码不能写成 "profiles\node_modules"（实测失效，
; 毒树被打进包）。这里用「基线名掩码 node_modules.stale-*」（不含反斜杠，按文件名匹配，
; 必然生效）排除隔离备份；前斜杠写法为兼容性兜底。
Source: "payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; Excludes: "node_modules.stale-*;profiles/node_modules;profiles/node_modules.stale-*"

[Icons]
; 开始菜单两项受 startmenuicon 勾选控制（默认勾选）；桌面项受 desktopicon 控制
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; WorkingDir: "{app}"; IconFilename: "{#MyAppIcon}"; Tasks: startmenuicon
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; WorkingDir: "{app}"; IconFilename: "{#MyAppIcon}"; Tasks: desktopicon
Name: "{autoprograms}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"; IconFilename: "{#MyAppIcon}"; Tasks: startmenuicon

[Tasks]
; 均默认勾选（Inno 无 Flags:unchecked 即默认选中）
Name: "desktopicon"; Description: "创建桌面快捷方式"
Name: "startmenuicon"; Description: "创建开始菜单快捷方式"

[Run]
; 装完直接以 DSHOME.exe 方式启动（无控制台闪烁）
Filename: "{app}\{#MyAppExe}"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; 目录即卸载：连首启生成的 junction 集与用户数据（sessions/storages）一起清掉
Type: filesandordirs; Name: "{app}"
