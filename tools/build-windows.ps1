$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$distRoot = Join-Path $repoRoot 'dist'
$desktopDirectory = Join-Path $repoRoot 'desktop'
$desktopElectronPath = Join-Path $desktopDirectory 'node_modules\electron\dist\electron.exe'
$engineProject = Join-Path $repoRoot 'src\LocalWhisper\LocalWhisper.csproj'
$appPath = Join-Path $distRoot 'electron\LocalWhisper-win32-x64\LocalWhisper.exe'
$projectDistPattern = Join-Path $distRoot '*'

Write-Host 'Stopping Local Whisper processes from this project...'
$runningProcesses = Get-CimInstance Win32_Process |
    Where-Object {
        ($_.Name -eq 'LocalWhisper.exe' -and ($_.ExecutablePath -like $projectDistPattern -or $_.CommandLine -like "*$distRoot*")) -or
        ($_.Name -eq 'electron.exe' -and ($_.ExecutablePath -eq $desktopElectronPath -or $_.CommandLine -like "*$desktopDirectory*"))
    }

foreach ($runningProcess in $runningProcesses) {
    Write-Host ("  Stopping PID {0}: {1}" -f $runningProcess.ProcessId, $runningProcess.ExecutablePath)
    Stop-Process -Id $runningProcess.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host 'Building the native engine...'
& dotnet publish $engineProject -c Release -r win-x64 --self-contained true -o (Join-Path $distRoot 'engine')
if ($LASTEXITCODE -ne 0) { throw "Native engine build failed with exit code $LASTEXITCODE." }

Push-Location $desktopDirectory
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Host 'Installing desktop dependencies...'
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw "Desktop dependency installation failed with exit code $LASTEXITCODE." }
    }

    Write-Host 'Packaging the Windows app...'
    & npm run package
    if ($LASTEXITCODE -ne 0) { throw "Windows app packaging failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

if (-not (Test-Path $appPath)) { throw "Packaged app was not found at $appPath." }
Write-Host 'Launching Local Whisper...'
$launchEnvironment = @{ ELECTRON_RUN_AS_NODE = $null }
Start-Process -FilePath $appPath -WorkingDirectory (Split-Path $appPath) -Environment $launchEnvironment
Write-Host ("Running: {0}" -f $appPath)
