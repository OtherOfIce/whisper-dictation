$ErrorActionPreference = 'Stop'
$projectDirectory = Join-Path $PSScriptRoot '..\android'
if (-not $env:JAVA_HOME) {
    $studioJava = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'
    if (Test-Path (Join-Path $studioJava 'bin\java.exe')) { $env:JAVA_HOME = $studioJava }
}
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
Push-Location $projectDirectory
try {
    & .\gradlew.bat :app:assembleDebugNoMinify --console=plain
    if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }
