# All operations are called by a finite Node wrapper; native children belong to non-breakaway jobs.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 required' }
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-native.cs')
    $request = $env:CANOPY_NATIVE_REQUEST | ConvertFrom-Json
    $env:CANOPY_NATIVE_REQUEST = $null
    switch ($request.operation) {
        'run' { $file = (Get-Command -Name $request.file -CommandType Application -ErrorAction Stop).Source; $result = [CanopyNative]::Run($file, [string[]]$request.args, $request.timeoutMs, $false) }
        'launch' { $result = [CanopyNative]::Run($request.file, @(), 10000, $true) }
        'verify' {
            $signature = Get-AuthenticodeSignature -LiteralPath $request.path
            if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or -not $signature.TimeStamperCertificate) { throw 'Embedded signature/timestamp rejected' }
            $result = [CanopyNative]::Trust($request.path)
            if ($result.thumbprint -cne $signature.SignerCertificate.Thumbprint -or $result.timestampThumbprint -cne $signature.TimeStamperCertificate.Thumbprint) { throw 'Native signer mismatch' }
            $sdk = [CanopyNative]::Run($env:CANOPY_SIGNTOOL, @('verify','/pa','/all','/tw',$request.path), 90000, $false)
            if (-not $sdk.ok) { $result = $sdk; break }
            $result['status'] = 'Valid'; $result['timestamp'] = $true; $result['revocation'] = 'online'
            $result['sha256'] = (Get-FileHash -LiteralPath $request.path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        'snapshot' {
            $guid = $request.guid
            if ($guid -notmatch '^[a-f0-9-]{36}$') { throw 'NSIS identity required' }
            $install = 'Software/' + $guid
            $uninstall = 'Software/Microsoft/Windows/CurrentVersion/Uninstall/' + $guid
            $registrations = [Collections.Generic.List[object]]::new()
            foreach ($hive in @('CurrentUser','LocalMachine')) {
                foreach ($view in @('Registry32','Registry64')) {
                    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
                    try {
                        foreach ($key in @($install,$uninstall)) {
                            $entry = $base.OpenSubKey($key.Replace('/','\'))
                            if ($entry) {
                                try { $registrations.Add(@{ hive=$hive; view=$view; key=$key; location=$entry.GetValue('InstallLocation'); present=$true }) }
                                finally { $entry.Dispose() }
                            }
                        }
                        $all = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
                        if ($all) {
                            try {
                                foreach ($name in $all.GetSubKeyNames()) {
                                    $entry = $all.OpenSubKey($name)
                                    try {
                                        if ($entry -and ($entry.GetValue('DisplayName') -match '^Canopy(?: \d|$)' -or $name -eq $guid)) {
                                            $registrations.Add(@{ hive=$hive; view=$view; key=$name; location=$entry.GetValue('InstallLocation'); present=$true })
                                        }
                                    } finally { if ($entry) { $entry.Dispose() } }
                                }
                            } finally { $all.Dispose() }
                        }
                    } finally { $base.Dispose() }
                }
            }
            $userPrograms = [CanopyNative]::KnownFolder('5CD7AEE2-2219-4A67-B85D-6C9CE15660CB')
            $directory = Join-Path $userPrograms 'Canopy'
            $desktop = [Environment]::GetFolderPath('Desktop')
            $menu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
            $roots = @($desktop,$menu,[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('CommonPrograms'))
            $candidates = @($directory,(Join-Path $env:LOCALAPPDATA 'Programs/Canopy'),
                (Join-Path $env:ProgramFiles 'Canopy'), (Join-Path ${env:ProgramFiles(x86)} 'Canopy'),
                (Join-Path $env:APPDATA 'canopy'), (Join-Path $env:LOCALAPPDATA 'canopy'))
            if ($request.profilePath) { $candidates += $request.profilePath }
            foreach ($folder in $roots) { $candidates += (Join-Path $folder 'Canopy.lnk'); $candidates += (Join-Path $folder 'Canopy') }
            $existing = @($candidates | Where-Object { Test-Path -LiteralPath $_ })
            $links = [Collections.Generic.List[object]]::new()
            $shell = New-Object -ComObject WScript.Shell
            foreach ($folder in $roots) {
                if (Test-Path -LiteralPath $folder) {
                    foreach ($link in (Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse)) {
                        $target = $shell.CreateShortcut($link.FullName).TargetPath
                        if ([IO.Path]::GetFileName($target) -ieq 'Canopy.exe') { $links.Add(@{ path=$link.FullName; target=$target }) }
                    }
                }
            }
            $running = @(Get-Process -Name Canopy -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
            $result = @{ registrations=$registrations.ToArray(); existingPaths=$existing; links=$links.ToArray(); running=$running;
                directory=$directory; desktop=(Join-Path $desktop 'Canopy.lnk'); menu=(Join-Path $menu 'Canopy.lnk');
                os=(Get-CimInstance Win32_OperatingSystem).Caption }
        }
        default { throw 'Unknown bounded operation' }
    }
    $result | ConvertTo-Json -Depth 8 -Compress
} catch {
    # No native exception text or credentials escape the helper. The controller records the stage separately.
    @{ ok=$false; error='Windows helper operation failed'; cleanupError=$null; ownedAbsent=$false } | ConvertTo-Json -Compress
}
