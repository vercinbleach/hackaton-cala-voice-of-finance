[CmdletBinding()]
param(
    [switch]$Json,
    [switch]$Strict,
    [switch]$SkipHyperFrames,
    [switch]$AllowNpxDownload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Protect-Text {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $safe = $Value -replace '(?i)((?:api[ _-]?key|token|secret|password|authorization)\s*[:=]\s*)("[^"]*"|''[^'']*''|\S+)', '$1[REDACTED]'
    $safe = $safe -replace '(?i)Bearer\s+\S+', 'Bearer [REDACTED]'
    foreach ($homePath in @($env:USERPROFILE, $env:HOME)) {
        if (-not [string]::IsNullOrWhiteSpace($homePath)) {
            $safe = $safe -replace [regex]::Escape($homePath), '~'
        }
    }
    if ($safe.Length -gt 240) { $safe = $safe.Substring(0, 240) }
    return $safe.Trim()
}

function Invoke-External {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $isFile = Test-Path -LiteralPath $FilePath -PathType Leaf
    $command = Get-Command -Name $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $isFile -and $null -eq $command) {
        return [pscustomobject]@{ Started = $false; ExitCode = $null; Output = '' }
    }

    try {
        $global:LASTEXITCODE = 0
        $lines = @(& $FilePath @Arguments 2>&1 | ForEach-Object { $_.ToString() })
        return [pscustomobject]@{
            Started = $true
            ExitCode = [int]$LASTEXITCODE
            Output = ($lines -join "`n")
        }
    }
    catch {
        return [pscustomobject]@{
            Started = $true
            ExitCode = 1
            Output = $_.Exception.Message
        }
    }
}

function Get-FirstLine {
    param([AllowNull()][string]$Value)
    $line = @($Value -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
    if ($line.Count -eq 0) { return '' }
    return Protect-Text $line[0]
}

function New-ToolCheck {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $result = Invoke-External -FilePath $Command -Arguments $Arguments
    if (-not $result.Started) {
        return [pscustomobject]@{ id = $Id; label = $Label; required = $true; status = 'failed'; version = $null; detail = "$Label was not found on PATH" }
    }
    if ($result.ExitCode -ne 0) {
        return [pscustomobject]@{ id = $Id; label = $Label; required = $true; status = 'failed'; version = $null; detail = "$Label exited with code $($result.ExitCode)" }
    }
    return [pscustomobject]@{ id = $Id; label = $Label; required = $true; status = 'passed'; version = (Get-FirstLine $result.Output); detail = 'available' }
}

function ConvertFrom-EmbeddedJson {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $start = $Value.IndexOf('{')
    $end = $Value.LastIndexOf('}')
    if ($start -lt 0 -or $end -le $start) { return $null }
    try { return $Value.Substring($start, $end - $start + 1) | ConvertFrom-Json }
    catch { return $null }
}

function Test-StandardChrome {
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidates.Add((Join-Path $root 'Google\Chrome\Application\chrome.exe'))
        $candidates.Add((Join-Path $root 'Microsoft\Edge\Application\msedge.exe'))
    }
    return @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }).Count -gt 0
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$doctorSummary = $null
$doctorChromeReady = $false

if ($SkipHyperFrames) {
    $doctorCheck = [pscustomobject]@{
        id = 'hyperframes-doctor'; label = 'HyperFrames doctor'; required = $true; status = 'skipped'; version = $null; detail = 'skipped by command-line option'
    }
}
else {
    $doctorCandidates = [System.Collections.Generic.List[object]]::new()
    $localHyperFrames = Join-Path $repoRoot 'node_modules\.bin\hyperframes.cmd'
    if (Test-Path -LiteralPath $localHyperFrames -PathType Leaf) {
        $doctorCandidates.Add([pscustomobject]@{ Command = $localHyperFrames; Arguments = @('doctor', '--json'); Source = 'local' })
    }
    if ($null -ne (Get-Command hyperframes -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        $doctorCandidates.Add([pscustomobject]@{ Command = 'hyperframes'; Arguments = @('doctor', '--json'); Source = 'PATH' })
    }
    if ($null -ne (Get-Command npx -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        $doctorCandidates.Add([pscustomobject]@{ Command = 'npx'; Arguments = @('--no-install', 'hyperframes', 'doctor', '--json'); Source = 'npx-cache' })
        if ($AllowNpxDownload) {
            $doctorCandidates.Add([pscustomobject]@{ Command = 'npx'; Arguments = @('--yes', 'hyperframes', 'doctor', '--json'); Source = 'npx-download' })
        }
    }

    $doctorData = $null
    $doctorSource = $null
    foreach ($candidate in $doctorCandidates) {
        $doctorResult = Invoke-External -FilePath $candidate.Command -Arguments $candidate.Arguments
        if (-not $doctorResult.Started) { continue }
        $parsed = ConvertFrom-EmbeddedJson $doctorResult.Output
        if ($null -ne $parsed -and $null -ne $parsed.checks) {
            $doctorData = $parsed
            $doctorSource = $candidate.Source
            break
        }
    }

    if ($null -eq $doctorData) {
        $doctorCheck = [pscustomobject]@{
            id = 'hyperframes-doctor'; label = 'HyperFrames doctor'; required = $true; status = 'failed'; version = $null; detail = 'HyperFrames doctor did not return JSON'
        }
    }
    else {
        $requiredNames = @('Version', 'Node.js', 'FFmpeg', 'FFprobe', 'Chrome')
        $requiredDoctorChecks = @()
        foreach ($name in $requiredNames) {
            $match = @($doctorData.checks | Where-Object { $_.name -eq $name } | Select-Object -First 1)
            $requiredDoctorChecks += [pscustomobject]@{ name = $name; ok = ($match.Count -eq 1 -and $match[0].ok -eq $true) }
        }
        $optionalDoctorChecks = @($doctorData.checks | Where-Object { $requiredNames -notcontains $_.name } | ForEach-Object {
            [pscustomobject]@{ name = [string]$_.name; ok = ($_.ok -eq $true) }
        })
        $requiredReady = @($requiredDoctorChecks | Where-Object { -not $_.ok }).Count -eq 0
        $doctorChromeReady = @($requiredDoctorChecks | Where-Object { $_.name -eq 'Chrome' -and $_.ok }).Count -eq 1
        $doctorCheck = [pscustomobject]@{
            id = 'hyperframes-doctor'
            label = 'HyperFrames doctor'
            required = $true
            status = $(if ($requiredReady) { 'passed' } else { 'failed' })
            version = $null
            detail = "doctor JSON parsed; required $(@($requiredDoctorChecks | Where-Object { $_.ok }).Count)/$($requiredDoctorChecks.Count); optional unavailable $(@($optionalDoctorChecks | Where-Object { -not $_.ok }).Count)"
        }
        $doctorSummary = [pscustomobject]@{
            source = $doctorSource
            parsed = $true
            requiredChecks = $requiredDoctorChecks
            optionalChecks = $optionalDoctorChecks
        }
    }
}

$chromeReady = Test-StandardChrome
if (-not $chromeReady -and $doctorChromeReady) { $chromeReady = $true }
$chromeDetail = if (Test-StandardChrome) {
    'Chrome-compatible browser detected in a standard Windows location'
} elseif ($doctorChromeReady) {
    'HyperFrames doctor detected a managed Chrome-compatible browser'
} else {
    'Chrome was not found directly or by HyperFrames doctor'
}
$chromeCheck = [pscustomobject]@{
    id = 'chrome'; label = 'Chrome'; required = $true; status = $(if ($chromeReady) { 'passed' } else { 'failed' }); version = $null; detail = $chromeDetail
}

$checks = @(
    (New-ToolCheck -Id 'bun' -Label 'Bun' -Command 'bun' -Arguments @('--version'))
    (New-ToolCheck -Id 'node' -Label 'Node.js' -Command 'node' -Arguments @('--version'))
    (New-ToolCheck -Id 'codex' -Label 'Codex CLI' -Command 'codex' -Arguments @('--version'))
    $doctorCheck
    $chromeCheck
    (New-ToolCheck -Id 'ffmpeg' -Label 'FFmpeg' -Command 'ffmpeg' -Arguments @('-version'))
    (New-ToolCheck -Id 'ffprobe' -Label 'FFprobe' -Command 'ffprobe' -Arguments @('-version'))
)

$ready = @($checks | Where-Object { $_.required -and $_.status -ne 'passed' }).Count -eq 0
$report = [ordered]@{
    ready = $ready
    platform = 'win32'
    architecture = $env:PROCESSOR_ARCHITECTURE
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    checks = $checks
    hyperframesDoctor = $doctorSummary
}

if ($Json) {
    $report | ConvertTo-Json -Depth 8
}
else {
    Write-Output "Environment preflight: $(if ($ready) { 'READY' } else { 'NOT READY' })"
    foreach ($check in $checks) {
        $marker = if ($check.status -eq 'passed') { 'PASS' } elseif ($check.status -eq 'skipped') { 'SKIP' } else { 'FAIL' }
        $message = if (-not [string]::IsNullOrWhiteSpace($check.version)) { $check.version } else { $check.detail }
        Write-Output "[$marker] $($check.label): $message"
    }
}

if ($Strict -and -not $ready) { exit 1 }
exit 0
