# Source parsing/compilation needs no native test token. The process harness requires a separate explicit opt-in.
param([switch]$ProcessHarness)
$ErrorActionPreference = 'Stop'
foreach ($path in (Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'windows-*.ps1')) {
    $tokens=$null; $errors=$null
    $null=[System.Management.Automation.Language.Parser]::ParseFile($path.FullName,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw "PowerShell parse failed: $($path.Name)" }
}
Add-Type -Path (Join-Path $PSScriptRoot 'windows-native.cs')
if ($ProcessHarness) {
    if ($env:CANOPY_WINDOWS_NATIVE_TOKEN -eq $null -or $env:CANOPY_DISPOSABLE_WINDOWS_ACCOUNT -ne '1') { throw 'Disposable native harness token required' }
    $node=(Get-Command node).Source
    foreach ($fixture in @(
        @{ args=@('-e','process.exit(0)'); timeout=1000; ok=$true },
        @{ args=@('-e','process.exit(17)'); timeout=1000; ok=$false },
        @{ args=@('-e','setInterval(()=>{},100)'); timeout=500; ok=$false },
        @{ args=@('-e', 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},100)"],{stdio:"ignore"});setTimeout(()=>process.exit(0),100)'); timeout=1000; ok=$false }
    )) {
        $result=[CanopyNative]::Run($node,$fixture.args,$fixture.timeout,$false)
        if ($result.ok -ne $fixture.ok -or -not $result.ownedAbsent) { throw 'Owned job control failed' }
    }
}
Write-Output 'Windows source controls passed; no signing, registry or installation qualification'
