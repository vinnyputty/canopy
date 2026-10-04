# Prepared adapter only. Node owns finite native-operation deadlines and the error/evidence controller.
param([Parameter(Mandatory)][string]$ReviewedCommit,
      [Parameter(Mandatory)][string]$PreviousInstaller,
      [Parameter(Mandatory)][string]$PreviousSha256,
      [Parameter(Mandatory)][string]$Installer,
      [Parameter(Mandatory)][string]$Sha256)
$oldOptions = $env:CANOPY_LIFECYCLE_OPTIONS
try {
    $env:CANOPY_LIFECYCLE_OPTIONS = @{ reviewedCommit=$ReviewedCommit; previousInstaller=$PreviousInstaller;
        previousSha256=$PreviousSha256; installer=$Installer; sha256=$Sha256 } | ConvertTo-Json -Compress
    & node (Join-Path $PSScriptRoot 'windows-lifecycle.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Lifecycle failed; retain VM, profiles and evidence' }
} finally { $env:CANOPY_LIFECYCLE_OPTIONS = $oldOptions }
