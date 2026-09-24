; DSHOME Setup Script — Inno Setup 7（全量自包含安装包，含 node_modules 与自带 node 运行时）
; 构建：ISCC.exe DSHOME.iss  →  build-stage\DSHOME-setup-0.3.5.exe
; ISSUE-003 修复（2026-09-01）：
;   ① [Files] Excludes 排除 profiles\node_modules（dsh 首启自愈重建为 junction，不得随包分发）
;   ② 启动入口 exe 化：快捷方式/装后启动直接指向 {app}\DSHOME.exe（布局无关启动器，无控制台闪烁）
;   ③ Uninstallable=yes + CreateUninstallRegKey=no：生成卸载 exe（unins000.exe）但零注册表残留
#define MyAppName "DSHOME"
#define MyAppVersion "0.3.5"
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
; ⚠️ 两条实测坑（2026-09-14 补正——此前"必然生效"的断言是错的）：
;   ① Inno 字符串里 `\n` 是换行转义，掩码不能写成 "profiles\node_modules"（实测失效，毒树被打进包）；
;   ② **本参数的分隔符只能是逗号或空格——写成【分号】会让整串被当成"一个"模式，本行所有规则全部哑火。**
;      最小复现（本机 Inno 7.1.0，同源三组对照）：`update-pnpm.cmd;*DSHOME.cmd`（分号）→ 3 文件全进包；
;      `update-pnpm.cmd,*DSHOME.cmd`（逗号）→ 仅剩 keep.cmd；单模式 `update-pnpm.cmd` → 该文件被排掉。
;      ⇒ v0.3.3 及更早的包是在本行「排除全哑」状态下发出去的（毒树实际靠 verify-payload 前置门禁拦截，
;      Excludes 从未兜住过底）。**改本行前请先跑一遍最小复现，别再信"写了就生效"。**
;   掩码按**文件名**匹配（不含反斜杠的 `node_modules.stale-*`、`*DSHOME.cmd` 才可靠；带路径的写法匹配不到文件名）。
; 2026-09-12 增：开发态工具不进装机版——`更新DSHOME.cmd`（拉取 + pnpm install）与 `update-pnpm.cmd`
; 都只认开发态布局：装机版既没有 .git，node 也不在 %LOCALAPPDATA% 的 dshome-dev 目录下（而在 {app}
; 的 runtime 目录里）⇒ 使用者一跑必退、提示还是误导。装机版的升级路径是「下载新版安装包覆盖安装」，
; 故排除这两个；中文名用 `*DSHOME.cmd` 文件名掩码匹配（不含反斜杠，规避 Inno 反斜杠转义坑，
; 也不误伤 setup-dev.cmd / 开发启动.cmd）。
Source: "payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; Excludes: "node_modules.stale-*,profiles/node_modules,profiles/node_modules.stale-*,update-pnpm.cmd,*DSHOME.cmd"

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
