# No certificate-store writes or private-key files. Secrets arrive only via environment.
param([ValidateSet('sign', 'verify')][string]$Mode = 'verify')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$certificate = $null
$bytes = $null
try {
    if (-not $IsWindows) { throw 'Windows required' }
    $path = $env:CANOPY_SIGN_FILE
    $subject = $env:CANOPY_WINDOWS_SUBJECT
    $thumbprint = $env:CANOPY_WINDOWS_THUMBPRINT
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf) -or
        -not $subject -or $thumbprint -cnotmatch '^[A-F0-9]{40}$') { throw 'Missing signing identity or file' }
    if ($Mode -eq 'sign') {
        if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
            $env:GITHUB_EVENT_NAME -ne 'push' -or $env:GITHUB_REF -notmatch '^refs/tags/v' -or
            -not $env:CANOPY_WINDOWS_PFX -or -not $env:CANOPY_WINDOWS_PFX_PASSWORD) { throw 'Protected tag signing credentials required' }
        $bytes = [Convert]::FromBase64String($env:CANOPY_WINDOWS_PFX)
        $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
            $bytes, $env:CANOPY_WINDOWS_PFX_PASSWORD,
            [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
        if (-not $certificate.HasPrivateKey -or $certificate.Subject -cne $subject -or
            $certificate.Thumbprint -cne $thumbprint -or $certificate.NotBefore -gt (Get-Date) -or
            $certificate.NotAfter -le (Get-Date) -or
            '1.3.6.1.5.5.7.3.3' -notin @($certificate.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } | ForEach-Object { $_.EnhancedKeyUsages.Value })) { throw 'Unqualified signing certificate' }
        $null = Set-AuthenticodeSignature -LiteralPath $path -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'https://timestamp.digicert.com' -IncludeChain NotRoot
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate -or
        $signature.SignerCertificate.Subject -cne $subject -or
        $signature.SignerCertificate.Thumbprint -cne $thumbprint -or
        $signature.SignerCertificate.NotBefore -gt (Get-Date) -or
        $signature.SignerCertificate.NotAfter -le (Get-Date)) { throw 'Signature, timestamp or publisher verification failed' }
    # SignTool independently applies the Authenticode trust policy to every signature.
    # SDK path is runner-local, public configuration; never a signing credential.
    if (-not $env:CANOPY_SIGNTOOL -or -not (Test-Path -LiteralPath $env:CANOPY_SIGNTOOL -PathType Leaf)) { throw 'Windows SDK SignTool required' }
    & $env:CANOPY_SIGNTOOL verify /pa /all /tw $path *> $null
    if ($LASTEXITCODE -ne 0) { throw 'SignTool verification failed' }
    [ordered]@{ status = 'Valid'; subject = $subject; thumbprint = $thumbprint;
        timestamp = $true; notBefore = $signature.SignerCertificate.NotBefore.ToUniversalTime().ToString('o');
        notAfter = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o'); sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json -Compress
} catch {
    # Do not print exception details: certificate import errors may contain sensitive inputs.
    [Console]::Error.WriteLine('Windows Authenticode operation failed')
    exit 1
} finally {
    if ($certificate) { $certificate.Dispose() }
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    $env:CANOPY_WINDOWS_PFX = $null
    $env:CANOPY_WINDOWS_PFX_PASSWORD = $null
}
