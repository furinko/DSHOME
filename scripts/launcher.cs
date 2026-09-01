using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

// DSHOME 统一启动器（源码布局 / 安装布局通用，逻辑与 开发启动.cmd 一致）
//   - DSH_HOME = 本 exe 所在目录
//   - PATH 前置：node 目录（%LOCALAPPDATA%\dshome-dev\node 开发 / <home>\runtime 安装包）+ C:\Windows\System32;C:\Windows（bsdtar 修复，同 开发启动.cmd）
//   - 设 DSHOME_BACKEND_CMD（后端由 Electron 壳拉起/守护）
//   - 启动 Electron 壳 <home>\packages\dshome\shell-app
// 构建：scripts\build-launchers.cmd（csc，零第三方依赖）
// 验证：DSHOME.exe --selfcheck  → 解析路径写入 %TEMP%\dshome-launcher-selfcheck.txt 后退出 0
static class DSHOMELauncher
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    private const uint MB_ICONERROR = 0x10;

    [STAThread]
    private static int Main(string[] args)
    {
        string home = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

        string nodeDev = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "dshome-dev", "node");
        string runtimeDir = Path.Combine(home, "runtime");
        // 与 开发启动.cmd 对齐：node 目录之后前置 System32/Windows，
        // 保证 tar 命中 bsdtar（dsh-evolve 备份/回滚/fold 依赖，GNU tar 不支持 Windows 绝对路径）。
        const string SysDir = "C:\\Windows\\System32;C:\\Windows;";
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        if (File.Exists(Path.Combine(nodeDev, "node.exe")))
            path = nodeDev + ";" + SysDir + path;
        else if (File.Exists(Path.Combine(runtimeDir, "node.exe")))
            path = runtimeDir + ";" + SysDir + path;
        Environment.SetEnvironmentVariable("PATH", path);
        Environment.SetEnvironmentVariable("DSH_HOME", home);

        string dshBin = Path.Combine(home, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
        string backendCmd = "node \"" + dshBin + "\" --profile dshome --no-open --port 3099";
        Environment.SetEnvironmentVariable("DSHOME_BACKEND_CMD", backendCmd);

        string electron = Path.Combine(home, "node_modules", "electron", "dist", "electron.exe");
        string shellApp = Path.Combine(home, "packages", "dshome", "shell-app");

        if (args.Length > 0 && args[0] == "--selfcheck")
        {
            string report = string.Join(Environment.NewLine, new string[]
            {
                "home=" + home,
                "nodeDev=" + nodeDev,
                "runtime=" + runtimeDir,
                "dshBin=" + dshBin,
                "electron=" + electron,
                "shellApp=" + shellApp,
                "backendCmd=" + backendCmd,
                "PATH=" + path,
            });
            File.WriteAllText(
                Path.Combine(Path.GetTempPath(), "dshome-launcher-selfcheck.txt"),
                report);
            return 0;
        }

        if (!File.Exists(electron) || !Directory.Exists(shellApp))
        {
            MessageBoxW(IntPtr.Zero,
                "未找到 Electron 壳：\n" + electron + "\n" + shellApp +
                "\n\n请确认这是完整的 DSHOME 目录（源码或安装布局）。",
                "DSHOME 启动失败", MB_ICONERROR);
            return 1;
        }

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = electron,
                Arguments = "\"" + shellApp + "\"",
                WorkingDirectory = home,
                UseShellExecute = false,
            };
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            MessageBoxW(IntPtr.Zero, "启动 Electron 失败：\n" + ex.Message,
                "DSHOME 启动失败", MB_ICONERROR);
            return 1;
        }
    }
}
