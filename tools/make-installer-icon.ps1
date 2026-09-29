$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$iconPath = Join-Path $PSScriptRoot '..\desktop\assets\app.ico'
$icon = [System.Drawing.Icon]::new($iconPath)
$small = $icon.ToBitmap()
$large = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($large)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$graphics.DrawImage($small, 0, 0, 256, 256)
$graphics.Dispose()

$images = [System.Collections.Generic.List[byte[]]]::new()
foreach ($bitmap in @($small, $large)) {
    $stream = [System.IO.MemoryStream]::new()
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $images.Add($stream.ToArray())
    $stream.Dispose()
    $bitmap.Dispose()
}
$icon.Dispose()

$output = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($output)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]2)
$offset = 6 + 2 * 16
for ($i = 0; $i -lt 2; $i++) {
    $size = if ($i -eq 0) { 32 } else { 256 }
    $writer.Write([byte]($size % 256))
    $writer.Write([byte]($size % 256))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$i].Length)
    $writer.Write([uint32]$offset)
    $offset += $images[$i].Length
}
foreach ($image in $images) { $writer.Write($image) }
[System.IO.File]::WriteAllBytes($iconPath, $output.ToArray())
$writer.Dispose()
$output.Dispose()
