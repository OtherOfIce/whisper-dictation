# Remove only the closed local-ASR experiment. Keep the two research reports.
# Preview: .\tools\cleanup-local-asr.ps1 -WhatIf
# Delete:  .\tools\cleanup-local-asr.ps1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

$ErrorActionPreference = 'Stop'
$expectedWorkspace = 'C:\Users\Liam\.t3\worktrees\local-whisper\research-offline-transcription'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ($workspace -ne $expectedWorkspace) {
    throw "This cleanup script is restricted to $expectedWorkspace. Found $workspace."
}

$targets = @(
    (Join-Path $workspace 'artifacts\local-asr'),
    (Join-Path $workspace 'tools\local-asr-eval'),
    (Join-Path $workspace 'docs\local-asr-model-manifest.json'),
    'C:\Users\Liam\AppData\Local\NeMoSpeech\models\nvidia\nemotron-speech-streaming-en-0.6b\ebe59e5a817142986528bbbee5dba8db7b38ed50'
)

# Validate every existing target before any deletion takes place.
$existingTargets = @()
$internalLinks = @{}
$logicalBytes = 0L
foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target)) {
        Write-Host "Already absent: $target"
        continue
    }
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if ($resolved -ne $target) { throw "Unexpected resolved target: $resolved" }
    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to follow a link or junction: $resolved"
    }
    if ($item.PSIsContainer) {
        $children = @(Get-ChildItem -LiteralPath $resolved -Recurse -Force)
        $links = @($children | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
        foreach ($link in $links) {
            if ($link.LinkType -notin @('Junction', 'SymbolicLink') -or @($link.Target).Count -ne 1) {
                throw "Unsupported link: $($link.FullName)"
            }
            $linkBase = [IO.Path]::GetDirectoryName($link.FullName)
            $linkDestination = if ([IO.Path]::IsPathRooted([string]$link.Target)) {
                [IO.Path]::GetFullPath([string]$link.Target)
            } else {
                [IO.Path]::GetFullPath((Join-Path $linkBase ([string]$link.Target)))
            }
            if (-not $linkDestination.StartsWith($resolved + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw "Link points outside cleanup target: $($link.FullName) -> $linkDestination"
            }
        }
        $internalLinks[$resolved] = $links
        $bytes = ($children | Where-Object { -not $_.PSIsContainer } | Measure-Object Length -Sum).Sum
    } else {
        $bytes = $item.Length
    }
    $logicalBytes += $bytes
    Write-Host ('{0:N2} GiB: {1}' -f ($bytes / 1GB), $resolved)
    $existingTargets += $resolved
}

foreach ($target in $existingTargets) {
    if ($PSCmdlet.ShouldProcess($target, 'Permanently delete closed local-ASR experiment files')) {
        # Unlink the Python version alias without recursively touching its destination.
        foreach ($link in $internalLinks[$target]) {
            Remove-Item -LiteralPath $link.FullName -Force -ErrorAction Stop
        }
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $target) { throw "Deletion incomplete: $target" }
    }
}

if ($WhatIfPreference) {
    Write-Host ('Preview complete. Selected {0:N2} GiB; no files deleted.' -f ($logicalBytes / 1GB))
} else {
    $remaining = @($targets | Where-Object { Test-Path -LiteralPath $_ })
    if ($remaining.Count) { throw ('Cleanup incomplete or skipped: ' + ($remaining -join ', ')) }
    Write-Host 'Cleanup complete. Models, isolated runtimes, copied corpus, raw results and benchmark scripts are absent.'
    Write-Host 'The two research reports and this cleanup script were kept.'
}
