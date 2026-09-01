using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

// DSHOME 卸载器（源码布局 / 安装布局通用；目录即卸载哲学）
//   1) 确认框（防误删源码目录；选"否"即中止，不删任何东西）
//   2) 删除桌面/开始菜单的 DSHOME 相关快捷方式
//   3) 安全删除 profiles\node_modules 的 junction 集合（只删链接本身，不触达真实内容）
//   4) 延迟删除自身所在目录（含本 exe）——防"rd /s /q 顺 junction 删真实内容"的坑
//   失败明细写 %TEMP%\dshome-uninstall.log
// 构建：scripts\build-launchers.cmd（csc，零第三方依赖）
// 自检：UninstallDSHOME.exe --selfcheck  → 打印解析路径到 %TEMP%\dshome-uninstall-selfcheck.txt，不删除任何东西
static class DSHOMEUninstaller
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    private const uint MB_ICONWARNING = 0x30;
    private const uint MB_YESNO = 0x04;
    private const int IDYES = 6;
    private static string LogFile = Path.Combine(Path.GetTempPath(), "dshome-uninstall.log");

    [STAThread]
    private static int Main(string[] args)
    {
        string home = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

        if (args.Length > 0 && args[0] == "--selfcheck")
        {
            string report = string.Join(Environment.NewLine, new string[]
            {
                "home=" + home,
                "log=" + LogFile,
                "mode=selfcheck (no deletion)",
            });
            File.WriteAllText(
                Path.Combine(Path.GetTempPath(), "dshome-uninstall-selfcheck.txt"),
                report);
            return 0;
        }

        int rc = MessageBoxW(IntPtr.Zero,
            "确定要卸载 DSHOME 吗？\n\n将删除整个目录（含用户数据）：\n" + home +
            "\n\n此操作不可撤销。",
            "卸载 DSHOME", MB_ICONWARNING | MB_YESNO);
        if (rc != IDYES) return 1; // 用户取消：不删任何东西

        File.WriteAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " uninstall start: " + home + Environment.NewLine);
        try
        {
            RemoveShortcuts();
            RemoveJunctions(Path.Combine(home, "profiles", "node_modules"));
            File.AppendAllText(LogFile, "cleanup done" + Environment.NewLine);
        }
        catch (Exception ex)
        {
            File.AppendAllText(LogFile, "cleanup error: " + ex + Environment.NewLine);
            // 尽力而为：个别条目删除失败不阻断整体卸载
        }

        // 延迟自删：等本进程退出后 rd 整目录 + del 本 exe（cmd 内联延迟）
        string self = Path.Combine(home, "UninstallDSHOME.exe");
        string cmd = "/c ping -n 4 127.0.0.1 >nul & rd /s /q \"" + home + "\" & del /f /q \"" + self + "\"";
        var psi = new ProcessStartInfo("cmd.exe", cmd)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        Process.Start(psi);
        return 0;
    }

    private static void RemoveShortcuts()
    {
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        string startMenu = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DSHOME");
        foreach (string dir in new[] { desktop, startMenu })
        {
            if (!Directory.Exists(dir)) continue;
            foreach (string f in Directory.GetFiles(dir, "*.lnk"))
            {
                string name = Path.GetFileNameWithoutExtension(f);
                if (name.Contains("DSHOME") || name.Contains("卸载"))
                {
                    try { File.Delete(f); }
                    catch (Exception ex) { File.AppendAllText(LogFile, "shortcut delete failed: " + f + " -> " + ex.Message + Environment.NewLine); }
                }
            }
        }
    }

    // junction = reparse point：Directory.Delete 只删链接本身，不递归目标。
    // 扁平 fallback 顶层为真实目录（@scope）或直接 junction（包名），递归处理。
    private static void RemoveJunctions(string dir)
    {
        if (!Directory.Exists(dir)) return;
        foreach (string sub in Directory.GetDirectories(dir))
        {
            var info = new DirectoryInfo(sub);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                try { Directory.Delete(sub); }
                catch (Exception ex) { File.AppendAllText(LogFile, "junction delete failed: " + sub + " -> " + ex.Message + Environment.NewLine); }
            }
            else
            {
                RemoveJunctions(sub);
            }
        }
    }
}
