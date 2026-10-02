# Preparation in the protected disposable release job only. No service authentication or signing here.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$owned = Join-Path $env:RUNNER_TEMP ('canopy-dlib-' + [Guid]::NewGuid())
try {
    $null = New-Item -ItemType Directory -Path $owned
    $package = Join-Path $owned 'client.zip'
    Invoke-WebRequest -Uri 'https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/1.0.128/microsoft.artifactsigning.client.1.0.128.nupkg' -OutFile $package -TimeoutSec 60 -MaximumRedirection 0
    if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -cne '74BD7D27E6CE1051409C38D9B46BC8DF0400ECD643D51FFBF2AC00869061E40B') { throw 'Pinned signing SDK package mismatch' }
    Expand-Archive -LiteralPath $package -DestinationPath (Join-Path $owned 'client')
    $dlib = Join-Path $owned 'client/bin/x64/Azure.CodeSigning.Dlib.dll'
    if (-not (Test-Path -LiteralPath $dlib)) { throw 'Pinned x64 dlib missing' }
    "CANOPY_SIGN_DLIB=$dlib" >> $env:GITHUB_ENV
    "CANOPY_SIGN_SDK_OWNED=$owned" >> $env:GITHUB_ENV
} catch {
    if (Test-Path -LiteralPath $owned) { Remove-Item -LiteralPath $owned -Recurse -Force }
    throw 'Signing SDK preparation failed'
}
