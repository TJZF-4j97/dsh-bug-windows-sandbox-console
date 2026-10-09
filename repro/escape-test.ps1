<#
.SYNOPSIS
  Runs an escape-write probe INSIDE the confined child and writes the verdict
  into the sandbox workspace (the only place the confined child may write).

.DESCRIPTION
  Executed as the child of `dsh-sandbox-windows-acl/runner.js` under
  `--mode workspace-write`. Every out-of-workspace target must be DENIED and must
  not exist on disk afterwards; the in-workspace target must be ALLOWED.

  NOTE on temp: under `workspace-write` the runner rewrites `TMP`/`TEMP` of the
  process it spawns to the session's private temp directory, which the sandbox
  deliberately grants. `$env:TEMP` inside this script is therefore *not* an
  out-of-workspace target — the probe below uses the literal user temp path
  instead, so it tests a path the sandbox has no grant for.

.PARAMETER Workspace
  The sandbox workspace directory (the runner's --workspace).

.PARAMETER ExtraTarget
  Additional out-of-workspace paths to attempt.

.EXAMPLE
  powershell -File escape-test.ps1 -Workspace 'D:\work\proj'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  [string]$ReportName = 'escape-report.txt',
  [string[]]$ExtraTarget = @()
)

$ErrorActionPreference = 'Continue'

$userTempLiteral = Join-Path $env:USERPROFILE 'AppData\Local\Temp\dsh-escape-probe.txt'
$outside = @(
  (Join-Path $env:USERPROFILE 'dsh-escape-probe.txt'),
  "$([System.IO.Path]::GetPathRoot($Workspace))dsh-escape-probe.txt",
  (Join-Path $env:SystemRoot 'Temp\dsh-escape-probe.txt'),
  $userTempLiteral
) + $ExtraTarget

$lines = @()
foreach ($target in $outside | Select-Object -Unique) {
  try {
    Set-Content -LiteralPath $target -Value 'x' -ErrorAction Stop
    $lines += "ALLOWED  $target   <-- ESCAPE: out-of-workspace write succeeded"
  } catch {
    $lines += "DENIED   $target"
  }
}

$inside = Join-Path $Workspace 'inside-ok.txt'
try {
  Set-Content -LiteralPath $inside -Value 'ok' -ErrorAction Stop
  $lines += "ALLOWED  $inside   (in-workspace, expected)"
} catch {
  $lines += "DENIED   $inside   <-- UNEXPECTED: in-workspace write was refused"
}

$lines += "note: TMP/TEMP inside the sandbox = $env:TEMP (granted private temp; not an escape target)"

$report = Join-Path $Workspace $ReportName
Set-Content -LiteralPath $report -Value ($lines -join [Environment]::NewLine) -ErrorAction Stop
$lines -join [Environment]::NewLine
