# Prepared fixture only. Run after fresh source review and a lead-issued exclusive native token.
param(
    [Parameter(Mandatory)][string]$ReviewedCommit,
    [Parameter(Mandatory)][string]$PreviousInstaller,
    [Parameter(Mandatory)][string]$PreviousSha256,
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Sha256
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [Environment]::Is64BitProcess -ne $true -or
    $env:CANOPY_DISPOSABLE_WINDOWS_ACCOUNT -ne '1' -or -not $env:CANOPY_WINDOWS_NATIVE_TOKEN -or
    $ReviewedCommit -cnotmatch '^[a-f0-9]{40}$' -or (git rev-parse HEAD) -cne $ReviewedCommit -or
    (git status --porcelain) -or $Sha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $PreviousSha256 -cnotmatch '^[a-f0-9]{64}$' -or $Sha256 -eq $PreviousSha256) {
    throw 'Fresh reviewed source, exclusive token, disposable x64 Windows account and distinct upgrade hashes required'
}
if ($env:CANOPY_WINDOWS_PFX -or $env:CANOPY_WINDOWS_PFX_PASSWORD) { throw 'Native fixture must receive no signing credentials' }
if ((Get-CimInstance Win32_OperatingSystem).Caption -notlike '*Windows 11*') { throw 'Windows 11 required' }
$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs/Canopy'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Canopy.lnk'
$startShortcut = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs/Canopy.lnk'
foreach ($path in @($installDirectory, $desktopShortcut, $startShortcut, (Join-Path $env:APPDATA 'canopy'))) {
    if (Test-Path -LiteralPath $path) { throw 'Fresh disposable account required; existing Canopy state preserved' }
}
if (Get-Process -Name Canopy -ErrorAction SilentlyContinue) { throw 'Existing Canopy process preserved' }
if (Get-ChildItem 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall' | Where-Object {
    (Get-ItemProperty $_.PSPath).DisplayName -eq 'Canopy'
}) { throw 'Existing Canopy registration preserved' }
foreach ($pair in @(@($PreviousInstaller, $PreviousSha256), @($Installer, $Sha256))) {
    if ((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]) { throw 'Installer hash mismatch' }
    node (Join-Path $PSScriptRoot 'windows-signing.mjs') verify $pair[0]
    if ($LASTEXITCODE -ne 0) { throw 'Installer or embedded executable trust verification failed' }
}
$owned = Join-Path ([IO.Path]::GetTempPath()) ('canopy-native-' + [Guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $owned
$previousProfile = $env:CANOPY_USER_DATA
$env:CANOPY_USER_DATA = Join-Path $owned 'profile'
$null = New-Item -ItemType Directory -Path $env:CANOPY_USER_DATA
$marker = Join-Path $env:CANOPY_USER_DATA 'fixture-marker.txt'
Set-Content -LiteralPath $marker -Value 'owned disposable fixture'
$checks = [Collections.Generic.List[string]]::new()
$stage = 'install'
$installed = $false
function Run-Finite([string]$File, [string]$Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
    if (-not $process.WaitForExit(120000)) {
        & taskkill /PID $process.Id /T /F *> $null
        throw 'Native process timed out'
    }
    if ($process.ExitCode -ne 0) { throw 'Native process failed' }
}
function Check-Installed {
    $exe = Join-Path $installDirectory 'Canopy.exe'
    $env:CANOPY_SIGN_FILE = $exe
    & (Join-Path $PSScriptRoot 'windows-authenticode.ps1') -Mode verify
    if ($LASTEXITCODE -ne 0) { throw 'Installed executable verification failed' }
    $shell = New-Object -ComObject WScript.Shell
    foreach ($link in @($desktopShortcut, $startShortcut)) {
        if (-not (Test-Path -LiteralPath $link) -or $shell.CreateShortcut($link).TargetPath -ine $exe) { throw 'Shortcut target mismatch' }
    }
    $app = Start-Process -FilePath $exe -PassThru
    try {
        Start-Sleep -Seconds 10
        $app.Refresh()
        if ($app.HasExited -or -not $app.Responding) { throw 'First launch exited or stopped responding' }
    } finally {
        if (-not $app.HasExited) { & taskkill /PID $app.Id /T /F *> $null }
    }
    # A process surviving is preliminary evidence; welcome/demo/credential interaction stays pending.
}
function Remove-Installed {
    $uninstaller = Join-Path $installDirectory 'Uninstall Canopy.exe'
    if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Partial installation lacks uninstaller; preserve VM for investigation' }
    Run-Finite $uninstaller '/S'
    $deadline = (Get-Date).AddSeconds(30)
    while ((Test-Path -LiteralPath (Join-Path $installDirectory 'Canopy.exe')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    foreach ($path in @((Join-Path $installDirectory 'Canopy.exe'), $desktopShortcut, $startShortcut)) {
        if (Test-Path -LiteralPath $path) { throw 'Uninstall left application or shortcuts' }
    }
    if (Get-ChildItem 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall' | Where-Object {
        (Get-ItemProperty $_.PSPath).DisplayName -eq 'Canopy'
    }) { throw 'Uninstall left Canopy registration' }
    if (-not (Test-Path -LiteralPath $marker)) { throw 'Uninstall removed retained owned profile' }
}
$failure = 'none'
try {
    $installed = $true # Include partial-install failures in uninstaller cleanup.
    Run-Finite $PreviousInstaller '/S'
    Check-Installed
    $checks.Add('previous install, shortcut targets, preliminary launch')
    $stage = 'upgrade'
    Run-Finite $Installer '/S'
    Check-Installed
    if ((Get-Content -LiteralPath $marker) -cne 'owned disposable fixture') { throw 'Owned profile marker changed' }
    $checks.Add('upgrade, shortcut targets, preliminary launch, owned profile marker')
    $stage = 'remove-upgrade'
    Remove-Installed
    $installed = $false
    $checks.Add('upgraded application and shortcuts removed; owned profile retained')
    $stage = 'clean-current-install'
    $env:CANOPY_USER_DATA = Join-Path $owned 'clean-profile'
    $null = New-Item -ItemType Directory -Path $env:CANOPY_USER_DATA
    $marker = Join-Path $env:CANOPY_USER_DATA 'fixture-marker.txt'
    Set-Content -LiteralPath $marker -Value 'owned disposable fixture'
    $installed = $true
    Run-Finite $Installer '/S'
    Check-Installed
    $checks.Add('current clean install, shortcut targets, preliminary launch')
    $stage = 'uninstall'
} catch {
    $failure = $stage
    throw
} finally {
    $cleanup = 'pending'
    try {
        if ($installed) {
            Remove-Installed
            $cleanup = 'passed'
        }
    } finally {
        $env:CANOPY_USER_DATA = $previousProfile
        [ordered]@{ reviewedCommit = $ReviewedCommit; previousSha256 = $PreviousSha256;
            sha256 = $Sha256; stage = $stage; failure = $failure; preliminaryChecks = @($checks); cleanup = $cleanup;
            nativeChecks = 'pending'; profile = $owned;
            remaining = 'Interactive welcome/demo/relaunch, saved preferences, authorized credentials, Installed apps, wizard, icons and SmartScreen checks' } |
            ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $owned 'lifecycle-report.json')
        Write-Output "Preliminary evidence retained at $owned; native acceptance remains pending"
    }
}
