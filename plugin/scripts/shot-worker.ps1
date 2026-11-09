# Resident screen capturer used by dsh-feishu-shot.
#
# Protocol: one request per stdin line, "<target>|<absolute output path>", where target is `all`, `left` or `right`;
# one compact JSON result per stdout line. The process stays alive so the cold start of PowerShell and the
# System.Drawing/Windows.Forms load happen once, not on every capture.
#
# `left` and `right` follow the monitor order on the virtual desktop: the smallest X bounds is the left monitor and the
# largest X is the right one, which is what a person means by 左屏/右屏 on a multi-monitor desk.
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName 'System.Windows.Forms', 'System.Drawing'

$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$utf8 = New-Object System.Text.UTF8Encoding $false
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true

[Console]::Out.WriteLine('{"ok":true,"ready":true}')

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }

  $parts = $line.Split('|', 2)
  $target = $parts[0]
  $out = $parts[1]
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $bitmap = $null
  $graphics = $null
  try {
    $bounds = if ($target -eq 'all') {
      [System.Windows.Forms.SystemInformation]::VirtualScreen
    } else {
      $ordered = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X })
      if ($ordered.Count -eq 0) { throw 'No monitor is attached' }
      if ($target -eq 'left') { $ordered[0].Bounds } else { $ordered[$ordered.Count - 1].Bounds }
    }
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)
    $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
    $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 88
    $bitmap.Save($out, $jpeg, $parameters)
    $watch.Stop()
    $result = [ordered]@{ ok = $true; path = $out; width = $bounds.Width; height = $bounds.Height; left = $bounds.X; ms = $watch.ElapsedMilliseconds }
  } catch {
    $watch.Stop()
    $result = [ordered]@{ ok = $false; error = $_.Exception.Message }
  } finally {
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
  }
  $stdout.WriteLine(($result | ConvertTo-Json -Compress))
}
