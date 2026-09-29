param(
    [string]$Serial,
    [string]$Package = 'org.localwhisper.keyboard.debug',
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$adbExecutable = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adbExecutable)) { $adbExecutable = (Get-Command adb -ErrorAction Stop).Source }
if (-not $Serial) {
    $devices = @(& $adbExecutable devices | Where-Object { $_ -match '^\S+\s+device$' } | ForEach-Object { ($_ -split '\s+')[0] })
    if ($devices.Count -ne 1) { throw 'Connect one authorized Android device, or specify -Serial.' }
    $Serial = $devices[0]
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $PSScriptRoot ('..\artifacts\android-recordings\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
$remoteDirectory = 'no_backup/recording-diagnostics'
& $adbExecutable -s $Serial shell run-as $Package true
if ($LASTEXITCODE -ne 0) { throw 'Could not access app-private storage. Install the development APK.' }
& $adbExecutable -s $Serial shell run-as $Package test -d $remoteDirectory
if ($LASTEXITCODE -ne 0) { Write-Output 'No diagnostic recordings saved yet.'; return }
$files = @(& $adbExecutable -s $Serial shell run-as $Package ls $remoteDirectory)
if ($LASTEXITCODE -ne 0) { throw 'Could not access diagnostic recordings. Install the development APK and enable Recording diagnostics.' }
$files = @($files | Where-Object { $_ -match '^[a-f0-9-]{36}\.(wav|json)$' })
if ($files.Count -eq 0) { Write-Output 'No diagnostic recordings saved yet.'; return }
[System.IO.Directory]::CreateDirectory($destination) | Out-Null
foreach ($name in $files) {
    $target = Join-Path $destination $name
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $adbExecutable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('-s', $Serial, 'exec-out', 'run-as', $Package, 'cat', "$remoteDirectory/$name")) { $start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $errorOutput = $process.StandardError.ReadToEndAsync()
        $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew)
        try { $process.StandardOutput.BaseStream.CopyTo($stream) } finally { $stream.Dispose() }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            Remove-Item -LiteralPath $target
            throw "Could not pull $name. A recording may have expired; try again."
        }
        $errorOutput.GetAwaiter().GetResult() | Out-Null
    } finally { $process.Dispose() }
}
Write-Output "Pulled $($files.Count) diagnostic files to $destination"
