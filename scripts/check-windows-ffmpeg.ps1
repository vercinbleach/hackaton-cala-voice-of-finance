[CmdletBinding()]
param(
    [switch]$Json,
    [switch]$Strict
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ToolState {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        return [pscustomobject]@{ name = $Name; available = $false; version = $null }
    }

    try {
        $global:LASTEXITCODE = 0
        $output = @(& $Name @Arguments 2>&1 | ForEach-Object { $_.ToString() })
        $firstLine = @($output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
        return [pscustomobject]@{
            name = $Name
            available = ($LASTEXITCODE -eq 0)
            version = $(if ($firstLine.Count) { $firstLine[0] } else { $null })
        }
    }
    catch {
        return [pscustomobject]@{ name = $Name; available = $false; version = $null }
    }
}

$ffmpeg = Get-ToolState -Name 'ffmpeg' -Arguments @('-version')
$ffprobe = Get-ToolState -Name 'ffprobe' -Arguments @('-version')
$wingetAvailable = $null -ne (Get-Command -Name 'winget' -ErrorAction SilentlyContinue | Select-Object -First 1)
$ready = $ffmpeg.available -and $ffprobe.available

$guidance = [ordered]@{
    packageId = 'Gyan.FFmpeg'
    review = 'winget show --id Gyan.FFmpeg --exact --source winget'
    install = 'winget install --id Gyan.FFmpeg --exact --source winget --accept-package-agreements --accept-source-agreements'
    verify = '.\scripts\check-windows-ffmpeg.ps1 -Strict'
    note = 'Review package metadata first. Installation is never performed by this check script. Open a new shell before verification so PATH refreshes.'
}

$report = [ordered]@{
    ready = $ready
    ffmpeg = $ffmpeg
    ffprobe = $ffprobe
    wingetAvailable = $wingetAvailable
    installGuidance = $guidance
}

if ($Json) {
    $report | ConvertTo-Json -Depth 5
}
else {
    Write-Output "Windows FFmpeg check: $(if ($ready) { 'READY' } else { 'NOT READY' })"
    Write-Output "[$(if ($ffmpeg.available) { 'PASS' } else { 'FAIL' })] FFmpeg"
    Write-Output "[$(if ($ffprobe.available) { 'PASS' } else { 'FAIL' })] FFprobe"
    if (-not $ready) {
        if (-not $wingetAvailable) {
            Write-Output 'winget is unavailable. Install a trusted Windows build from ffmpeg.org and add its bin directory to PATH.'
        }
        else {
            Write-Output 'Review:'
            Write-Output "  $($guidance.review)"
            Write-Output 'Install only after review:'
            Write-Output "  $($guidance.install)"
            Write-Output 'Then open a new PowerShell window and verify:'
            Write-Output "  $($guidance.verify)"
        }
    }
}

if ($Strict -and -not $ready) { exit 1 }
exit 0
