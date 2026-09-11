# ============================================================
#  DSHOME - patch the embedded icon of the Electron executable
# ============================================================
#  WHY: on Windows the taskbar button icon follows the running
#  process identity (AppUserModelID, or the executable itself when no
#  AUMID is registered). BrowserWindow's `icon` option only sets the
#  window icon and does NOT drive the taskbar. DSHOME launches a stock
#  electron.exe carrying the Electron logo, so the taskbar showed the
#  Electron icon no matter what main.cjs did.
#  This script replaces the RT_GROUP_ICON / RT_ICON resources of the
#  target exe with DSHOME's icon.ico (7 sizes), using Win32 resource
#  APIs only - zero third-party dependencies, same spirit as gen-icon.ps1.
#
#  USAGE (defaults fit the repo + dev install):
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patch-electron-icon.ps1
#    powershell ... -File scripts\patch-electron-icon.ps1 -Target <exe> -Icon <ico>
#    powershell ... -File scripts\patch-electron-icon.ps1 -VerifyOnly [-PreviewPath <png>]
#
#  EXIT CODES: 0 = ok, 1 = failure (missing file / locked exe / bad ico /
#              verification mismatch)
#
#  NOTE: keep this file PURE ASCII - Windows PowerShell 5.1 misreads
#        UTF-8-without-BOM non-ASCII text (same rule as gen-icon.ps1).
#        The resource work lives in C#: PS 5.1's dynamic binder breaks on
#        repeated [Type]::BoolMethod() call sites, so PS only orchestrates.
# ============================================================
param(
    [string]$Target = '',
    [string]$Icon = '',
    [switch]$VerifyOnly,
    [string]$PreviewPath = '',
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $Target) { $Target = Join-Path $root 'node_modules\electron\dist\electron.exe' }
if (-not $Icon)   { $Icon   = Join-Path $root 'packages\dshome\shell-app\icon.ico' }

if (-not (Test-Path -LiteralPath $Target)) { Write-Host "[patch-icon] FAIL: target exe not found: $Target"; exit 1 }
if (-not (Test-Path -LiteralPath $Icon))   { Write-Host "[patch-icon] FAIL: icon file not found: $Icon"; exit 1 }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class DshIconPatcher
{
    private delegate bool EnumResNameProc(IntPtr hModule, IntPtr lpType, IntPtr lpName, IntPtr lParam);
    private delegate bool EnumResLangProc(IntPtr hModule, IntPtr lpType, IntPtr lpName, ushort wIDLanguage, IntPtr lParam);

    private static readonly IntPtr RT_ICON = new IntPtr(3);
    private static readonly IntPtr RT_GROUP_ICON = new IntPtr(14);
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResourceW(string pFileName, bool bDeleteExistingResources);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool UpdateResourceW(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "UpdateResourceW")]
    private static extern bool UpdateResourceDeleteW(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, IntPtr lpData, uint cbData);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResourceW(IntPtr hUpdate, bool fDiscard);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryExW(string lpFileName, IntPtr hFile, uint dwFlags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr hModule);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceNamesW(IntPtr hModule, IntPtr lpType, EnumResNameProc lpEnumFunc, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceLanguagesW(IntPtr hModule, IntPtr lpType, IntPtr lpName, EnumResLangProc lpEnumFunc, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindResourceExW(IntPtr hModule, IntPtr lpType, IntPtr lpName, ushort wLanguage);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr hModule, IntPtr hResInfo);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LockResource(IntPtr hResData);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(IntPtr hModule, IntPtr hResInfo);

    private sealed class Entry
    {
        public byte W, H, CC, R;
        public ushort Planes, Bpp;
        public uint Size, Offset;
        public byte[] Data;
    }

    // ---------------- icon.ico parsing ----------------
    private static List<Entry> ParseIco(string iconPath, out string error)
    {
        error = null;
        byte[] b = File.ReadAllBytes(iconPath);
        if (b.Length < 22) { error = "ico too small: " + iconPath; return null; }
        int reserved = BitConverter.ToUInt16(b, 0);
        int type = BitConverter.ToUInt16(b, 2);
        int count = BitConverter.ToUInt16(b, 4);
        if (reserved != 0 || type != 1 || count < 1) { error = "not a valid .ico: " + iconPath; return null; }
        if (6 + 16 * count > b.Length) { error = "ico directory truncated: " + iconPath; return null; }
        List<Entry> list = new List<Entry>();
        for (int i = 0; i < count; i++)
        {
            int o = 6 + 16 * i;
            Entry e = new Entry();
            e.W = b[o]; e.H = b[o + 1]; e.CC = b[o + 2]; e.R = b[o + 3];
            e.Planes = BitConverter.ToUInt16(b, o + 4);
            e.Bpp = BitConverter.ToUInt16(b, o + 6);
            e.Size = BitConverter.ToUInt32(b, o + 8);
            e.Offset = BitConverter.ToUInt32(b, o + 12);
            if ((long)e.Offset + e.Size > b.Length) { error = "ico entry " + (i + 1) + " overflows file"; return null; }
            e.Data = new byte[e.Size];
            Array.Copy(b, (int)e.Offset, e.Data, 0, (int)e.Size);
            list.Add(e);
        }
        return list;
    }

    private static byte[] BuildGroupDirectory(List<Entry> entries)
    {
        MemoryStream ms = new MemoryStream();
        BinaryWriter w = new BinaryWriter(ms);
        w.Write((ushort)0);
        w.Write((ushort)1);
        w.Write((ushort)entries.Count);
        for (int i = 0; i < entries.Count; i++)
        {
            Entry e = entries[i];
            w.Write(e.W); w.Write(e.H); w.Write(e.CC); w.Write(e.R);
            w.Write(e.Planes); w.Write(e.Bpp);
            w.Write(e.Size);
            w.Write((ushort)(i + 1));
        }
        w.Flush();
        return ms.ToArray();
    }

    // ---------------- resource inspection ----------------
    private static int[] EnumNames(IntPtr hMod, IntPtr type)
    {
        List<int> ids = new List<int>();
        EnumResourceNamesW(hMod, type, delegate(IntPtr h, IntPtr t, IntPtr n, IntPtr l)
        {
            long v = n.ToInt64();
            if ((v >> 16) == 0) ids.Add((int)(v & 0xFFFF));
            return true;
        }, IntPtr.Zero);
        ids.Sort();
        return ids.ToArray();
    }

    private static ushort[] EnumLangs(IntPtr hMod, IntPtr type, int name)
    {
        List<ushort> ls = new List<ushort>();
        EnumResourceLanguagesW(hMod, type, new IntPtr(name), delegate(IntPtr h, IntPtr t, IntPtr n, ushort lang, IntPtr l)
        {
            ls.Add(lang);
            return true;
        }, IntPtr.Zero);
        return ls.ToArray();
    }

    private static byte[] ReadRes(IntPtr hMod, IntPtr type, int name, ushort lang)
    {
        IntPtr info = FindResourceExW(hMod, type, new IntPtr(name), lang);
        if (info == IntPtr.Zero) return null;
        uint size = SizeofResource(hMod, info);
        IntPtr data = LoadResource(hMod, info);
        if (data == IntPtr.Zero) return null;
        IntPtr ptr = LockResource(data);
        if (ptr == IntPtr.Zero) return null;
        byte[] buf = new byte[size];
        Marshal.Copy(ptr, buf, 0, (int)size);
        return buf;
    }

    private static bool BytesEqual(byte[] a, byte[] b)
    {
        if (a == null || b == null || a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
        return true;
    }

    // "" = patched correctly, otherwise the reason it does not match
    private static string CompareResources(IntPtr hMod, List<Entry> entries, byte[] groupBytes, int groupId, ushort lang)
    {
        int[] groups = EnumNames(hMod, RT_GROUP_ICON);
        if (groups.Length != 1) return "expected 1 RT_GROUP_ICON group, found " + groups.Length;
        if (groups[0] != groupId) return "unexpected group id " + groups[0] + " (expected " + groupId + ")";
        byte[] g = ReadRes(hMod, RT_GROUP_ICON, groupId, lang);
        if (g == null) return "cannot read RT_GROUP_ICON id=" + groupId + " lang=" + lang;
        if (!BytesEqual(g, groupBytes)) return "RT_GROUP_ICON bytes differ from icon.ico";
        for (int i = 0; i < entries.Count; i++)
        {
            int id = i + 1;
            byte[] d = ReadRes(hMod, RT_ICON, id, lang);
            if (d == null) return "RT_ICON id=" + id + " lang=" + lang + " missing";
            if (!BytesEqual(d, entries[i].Data)) return "RT_ICON id=" + id + " bytes differ from icon.ico";
        }
        return "";
    }

    // ---------------- main ----------------
    public static string Run(string target, string iconPath, bool verifyOnly, bool quiet, out int sizes, out int groupId, out int lang)
    {
        sizes = 0; groupId = 1; lang = 0;
        string error;
        List<Entry> entries = ParseIco(iconPath, out error);
        if (entries == null) return error;
        sizes = entries.Count;
        byte[] groupBytes = BuildGroupDirectory(entries);

        // which group id / language does the target already use?
        IntPtr hMod = LoadLibraryExW(target, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (hMod == IntPtr.Zero) return "cannot load target as datafile (err=" + Marshal.GetLastWin32Error() + ")";
        int[] groupIds;
        int[] iconIds;
        try
        {
            groupIds = EnumNames(hMod, RT_GROUP_ICON);
            iconIds = EnumNames(hMod, RT_ICON);
        }
        finally { FreeLibrary(hMod); }
        if (groupIds.Length > 0) groupId = groupIds[0];
        if (groupIds.Length > 0)
        {
            hMod = LoadLibraryExW(target, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
            if (hMod == IntPtr.Zero) return "cannot reload target as datafile (err=" + Marshal.GetLastWin32Error() + ")";
            try
            {
                ushort[] ls = EnumLangs(hMod, RT_GROUP_ICON, groupId);
                if (ls.Length > 0) lang = ls[0];
            }
            finally { FreeLibrary(hMod); }
        }

        if (verifyOnly)
        {
            hMod = LoadLibraryExW(target, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
            if (hMod == IntPtr.Zero) return "cannot load target as datafile (err=" + Marshal.GetLastWin32Error() + ")";
            string cmp;
            try { cmp = CompareResources(hMod, entries, groupBytes, groupId, (ushort)lang); }
            finally { FreeLibrary(hMod); }
            if (cmp != "") return "verify failed: " + cmp;
            if (!quiet) Console.WriteLine("[patch-icon] VERIFY OK: " + target + " carries DSHOME icon.ico (" + entries.Count + " sizes, group " + groupId + ", lang " + lang + ")");
            return "";
        }

        // already carrying our icon? then skip the write entirely (idempotent, and avoids a
        // needless failure when the exe is currently running/locked)
        hMod = LoadLibraryExW(target, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (hMod == IntPtr.Zero) return "cannot load target as datafile (err=" + Marshal.GetLastWin32Error() + ")";
        string pre;
        try { pre = CompareResources(hMod, entries, groupBytes, groupId, (ushort)lang); }
        finally { FreeLibrary(hMod); }
        if (pre == "")
        {
            if (!quiet) Console.WriteLine("[patch-icon] ALREADY PATCHED (skip write): " + target + " (" + entries.Count + " sizes, group " + groupId + ", lang " + lang + ")");
            return "";
        }

        // delete every existing icon resource (all ids, all languages), then write ours
        List<int> delGroups = new List<int>(), delIcons = new List<int>();
        List<ushort> delGroupLangs = new List<ushort>(), delIconLangs = new List<ushort>();
        hMod = LoadLibraryExW(target, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (hMod == IntPtr.Zero) return "cannot load target as datafile (err=" + Marshal.GetLastWin32Error() + ")";
        try
        {
            foreach (int gid in groupIds) { delGroups.Add(gid); foreach (ushort l in EnumLangs(hMod, RT_GROUP_ICON, gid)) delGroupLangs.Add(l); }
            foreach (int iid in iconIds) { delIcons.Add(iid); foreach (ushort l in EnumLangs(hMod, RT_ICON, iid)) delIconLangs.Add(l); }
        }
        finally { FreeLibrary(hMod); }

        IntPtr hUpd = BeginUpdateResourceW(target, false);
        if (hUpd == IntPtr.Zero)
        {
            int e = Marshal.GetLastWin32Error();
            if (e == 5 || e == 32) return "target exe is locked (err=" + e + ") - close DSHOME/Electron first: " + target;
            return "BeginUpdateResource failed (err=" + e + "): " + target;
        }
        bool committed = false;
        try
        {
            for (int i = 0; i < delGroups.Count && i < delGroupLangs.Count; i++)
                UpdateResourceDeleteW(hUpd, RT_GROUP_ICON, new IntPtr(delGroups[i]), delGroupLangs[i], IntPtr.Zero, 0);
            for (int i = 0; i < delIcons.Count && i < delIconLangs.Count; i++)
                UpdateResourceDeleteW(hUpd, RT_ICON, new IntPtr(delIcons[i]), delIconLangs[i], IntPtr.Zero, 0);

            for (int i = 0; i < entries.Count; i++)
            {
                bool ok = UpdateResourceW(hUpd, RT_ICON, new IntPtr(i + 1), (ushort)lang, entries[i].Data, entries[i].Size);
                if (!ok) return "UpdateResource(RT_ICON id=" + (i + 1) + ") failed (err=" + Marshal.GetLastWin32Error() + ")";
            }
            bool okGroup = UpdateResourceW(hUpd, RT_GROUP_ICON, new IntPtr(groupId), (ushort)lang, groupBytes, (uint)groupBytes.Length);
            if (!okGroup) return "UpdateResource(RT_GROUP_ICON id=" + groupId + ") failed (err=" + Marshal.GetLastWin32Error() + ")";
            if (!EndUpdateResourceW(hUpd, false)) return "EndUpdateResource(commit) failed (err=" + Marshal.GetLastWin32Error() + ")";
            committed = true;
        }
        finally
        {
            if (!committed) EndUpdateResourceW(hUpd, true);
        }

        // never trust the write path: re-read from disk
        hMod = LoadLibraryExW(target, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (hMod == IntPtr.Zero) return "post-patch load failed (err=" + Marshal.GetLastWin32Error() + ")";
        string post;
        try { post = CompareResources(hMod, entries, groupBytes, groupId, (ushort)lang); }
        finally { FreeLibrary(hMod); }
        if (post != "") return "post-patch verification failed: " + post;

        if (!quiet) Console.WriteLine("[patch-icon] PATCHED + VERIFIED: " + target + " (" + entries.Count + " sizes, group " + groupId + ", lang " + lang + ")");
        return "";
    }
}
'@

$sizes = 0; $groupId = 1; $lang = 0
$err = [DshIconPatcher]::Run($Target, $Icon, [bool]$VerifyOnly, [bool]$Quiet, [ref]$sizes, [ref]$groupId, [ref]$lang)
if ($err -ne '') {
    Write-Host "[patch-icon] FAIL: $err"
    exit 1
}

# best effort: remove an exe displaced by the "swap under a running lock" workaround
$stale = "$Target.pre-icon-replacement"
if (Test-Path -LiteralPath $stale) {
    try {
        Remove-Item -LiteralPath $stale -Force -ErrorAction Stop
        if (-not $Quiet) { Write-Host "[patch-icon] removed displaced exe: $stale" }
    } catch {
        if (-not $Quiet) { Write-Host "[patch-icon] displaced exe still locked (close DSHOME, then delete): $stale" }
    }
}

if ($PreviewPath) {
    Add-Type -AssemblyName System.Drawing
    $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($Target)
    $bmp = $ico.ToBitmap()
    $bmp.Save($PreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "[patch-icon] preview written: $PreviewPath ($($ico.Width)x$($ico.Height))"
}

exit 0
