# Puts a "2A Portal" icon on the Windows desktop (and in the Start menu) that runs
# scripts\launch-app.ps1. Run once: powershell -ExecutionPolicy Bypass -File scripts\install-desktop-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$png = Join-Path $root 'public\icons\icon-512.png'
$ico = Join-Path $root 'public\icons\app.ico'

# Windows icon file with 16-256 px sizes, each stored as PNG (supported since Vista).
$src = [System.Drawing.Image]::FromFile($png)
$images = foreach ($size in 256, 48, 32, 16) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $size, $size)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  [pscustomobject]@{ Size = $size; Bytes = $ms.ToArray() }
}
$src.Dispose()
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($i in $images) {
  $dim = if ($i.Size -ge 256) { 0 } else { $i.Size }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$i.Bytes.Length); $w.Write([uint32]$offset)
  $offset += $i.Bytes.Length
}
foreach ($i in $images) { $w.Write($i.Bytes) }
[System.IO.File]::WriteAllBytes($ico, $out.ToArray())

# Shortcuts: hidden PowerShell runs the launcher, so no console window appears.
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) '2A Portal.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) '2A Portal.lnk')
)
foreach ($t in $targets) {
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\launch-app.ps1`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$ico,0"
  $lnk.Description = '2A Group Corp immigration case portal'
  $lnk.WindowStyle = 7
  $lnk.Save()
  Write-Output "Created $t"
}
