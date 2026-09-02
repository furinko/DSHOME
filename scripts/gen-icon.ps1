# DSHOME icon generator (zero third-party deps, System.Drawing only)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gen-icon.ps1
# Input : packages\dshome\shell-app\icon-official.png (1024x1024 ARGB brand image)
# Output: packages\dshome\shell-app\icon.ico (16/24/32/48/64/128/256, classic BMP-DIB)
# Used  : DSHOME.exe/UninstallDSHOME.exe (csc /win32icon) + Inno Setup (SetupIconFile/IconFilename)
# NOTE  : keep this file pure ASCII (Windows PowerShell 5.1 misreads UTF-8-no-BOM comments)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $root 'packages\dshome\shell-app\icon-official.png'
$outPath = Join-Path $root 'packages\dshome\shell-app\icon.ico'

$src = [System.Drawing.Image]::FromFile($srcPath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)

# 1) Render each size: XOR data (32bpp BGRA, bottom-up DIB) + AND mask (all zero, alpha in XOR)
$xors = @($null) * $sizes.Count
$ands = @($null) * $sizes.Count
for ($si = 0; $si -lt $sizes.Count; $si++) {
    $s = $sizes[$si]
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()

    $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
    $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $srcStride = $bd.Stride
    $buf = New-Object byte[] ($srcStride * $s)
    [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $buf, 0, $buf.Length)
    $bmp.UnlockBits($bd)
    $bmp.Dispose()

    $rowBytes = $s * 4
    $xor = New-Object byte[] ($rowBytes * $s)
    for ($row = 0; $row -lt $s; $row++) {
        $from = ($s - 1 - $row) * $srcStride   # GDI+ top-down -> DIB bottom-up
        $to   = $row * $rowBytes
        [Array]::Copy($buf, $from, $xor, $to, $rowBytes)
    }
    $maskRow = [int][Math]::Ceiling($s / 32.0) * 4
    $and = New-Object byte[] ($maskRow * $s)   # zero mask
    $xors[$si] = $xor
    $ands[$si] = $and
}
$src.Dispose()

# 2) Build blobs first (BITMAPINFOHEADER + XOR + AND), then header with real len/offset
$blobs = @($null) * $sizes.Count
for ($si = 0; $si -lt $sizes.Count; $si++) {
    $s = $sizes[$si]
    $xor = $xors[$si]
    $and = $ands[$si]
    $b = New-Object System.Collections.Generic.List[byte]
    $b.AddRange([BitConverter]::GetBytes([int32]40))                 # biSize
    $b.AddRange([BitConverter]::GetBytes([int32]$s))                 # biWidth
    $b.AddRange([BitConverter]::GetBytes([int32]($s * 2)))           # biHeight (incl AND)
    $b.AddRange([BitConverter]::GetBytes([uint16]1))                 # biPlanes
    $b.AddRange([BitConverter]::GetBytes([uint16]32))                # biBitCount
    $b.AddRange([BitConverter]::GetBytes([uint32]0))                 # biCompression
    $b.AddRange([BitConverter]::GetBytes([uint32]($xor.Length + $and.Length)))  # biSizeImage
    $b.AddRange([BitConverter]::GetBytes([int32]0))                  # biXPels
    $b.AddRange([BitConverter]::GetBytes([int32]0))                  # biYPels
    $b.AddRange([BitConverter]::GetBytes([uint32]0))                 # biClrUsed
    $b.AddRange([BitConverter]::GetBytes([uint32]0))                 # biClrImportant
    $b.AddRange($xor)
    $b.AddRange($and)
    $blobs[$si] = $b.ToArray()
}

$all = New-Object System.Collections.Generic.List[byte]
$all.AddRange([byte[]](0, 0))                    # ICONDIR reserved
$all.AddRange([BitConverter]::GetBytes([uint16]1))  # type = icon
$all.AddRange([BitConverter]::GetBytes([uint16]$sizes.Count))
$off = [uint32](6 + 16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $blob = $blobs[$i]
    $all.Add([byte]($(if ($s -ge 256) { 0 } else { $s })))  # width (0 = 256)
    $all.Add([byte]($(if ($s -ge 256) { 0 } else { $s })))  # height
    $all.Add([byte]0)                            # color count
    $all.Add([byte]0)                            # reserved
    $all.AddRange([BitConverter]::GetBytes([uint16]1))   # planes
    $all.AddRange([BitConverter]::GetBytes([uint16]32))  # bit count
    $all.AddRange([BitConverter]::GetBytes([uint32]$blob.Length))
    $all.AddRange([BitConverter]::GetBytes([uint32]$off))
    $off += [uint32]$blob.Length
}
foreach ($blob in $blobs) { $all.AddRange($blob) }

[System.IO.File]::WriteAllBytes($outPath, $all.ToArray())
$size = (Get-Item $outPath).Length
Write-Host "icon.ico written: $outPath ($size bytes, $($sizes.Count) sizes)"

# 3) Selfcheck: every entry must start with biSize=40 (28 00 00 00)
$b = [System.IO.File]::ReadAllBytes($outPath)
$count = [BitConverter]::ToUInt16($b, 4)
$ok = $true
for ($i = 0; $i -lt $count; $i++) {
    $o = 6 + $i * 16
    $off = [BitConverter]::ToUInt32($b, $o + 12)
    $first = [BitConverter]::ToInt32($b, $off)
    if ($first -ne 40) { $ok = $false; Write-Host "BAD entry $($i+1): first4=$first at off=$off" }
}
if ($ok) { Write-Host "SELFCHECK: all entries start with biSize=40" } else { Write-Host "SELFCHECK FAILED" }
