param([Parameter(Mandatory=$true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installer = [IO.Path]::GetFullPath($InstallerPath)
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'output\release')) + [IO.Path]::DirectorySeparatorChar
$destination = [IO.Path]::GetFullPath((Join-Path $projectRoot '.build\install-smoke'))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.build')) + [IO.Path]::DirectorySeparatorChar
if (!$installer.StartsWith($releaseRoot, [StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Use a built installer from this project output/release directory.' }
if (!$destination.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install smoke destination escaped the project build folder.' }
$process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$destination") -WindowStyle Hidden -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(120)
while (!$process.WaitForExit(1000)) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Silent install did not finish within 120 seconds.' } }
if ($process.ExitCode -ne 0) { throw "Installer returned exit code $($process.ExitCode)." }
$files = @('ghostwheel.exe', 'ghostwheel-backend.exe')
$buildReceipt = Get-Content -LiteralPath (Join-Path $projectRoot 'output\release\build-receipt.json') -Raw | ConvertFrom-Json
if ($buildReceipt.gnu_compatibility_build) { $files += 'WebView2Loader.dll' }
$installed = @()
foreach ($name in $files) {
    $file = Join-Path $destination $name
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Installer did not supply $name." }
    $actualHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $expected = $buildReceipt.artifacts | Where-Object { $_.file -eq ('portable/' + $name) } | Select-Object -First 1
    if (!$expected) { throw "No final release receipt entry for $name." }
    $expectedHash = $expected.sha256
    $comparison = 'byte-identical to portable artifact'
    if ($name -eq 'ghostwheel.exe' -and $actualHash -ne $expectedHash) {
        # Tauri bundles a copy patched to NSS, then restores the portable UNK marker.
        # Only this unique, three-byte upstream bundle-type substitution is allowed.
        $portablePath = Join-Path $projectRoot ('output\release\portable\' + $name)
        $bytes = [IO.File]::ReadAllBytes($portablePath)
        $latin1 = [Text.Encoding]::GetEncoding(28591)
        $binaryText = $latin1.GetString($bytes)
        $marker = '__TAURI_BUNDLE_TYPE_VAR_UNK'
        $offset = $binaryText.IndexOf($marker, [StringComparison]::Ordinal)
        if ($offset -lt 0 -or $offset -ne $binaryText.LastIndexOf($marker, [StringComparison]::Ordinal)) { throw 'Expected one unique upstream Tauri bundle marker.' }
        $offset += '__TAURI_BUNDLE_TYPE_VAR_'.Length
        $bytes[$offset] = 78; $bytes[$offset+1] = 83; $bytes[$offset+2] = 83
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $expectedHash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
        $comparison = 'exact Tauri bundle marker transformation UNK -> NSS; all other bytes identical'
    }
    if ($actualHash -ne $expectedHash) { throw "Installed $name differs from the expected final artifact." }
    $installed += @{ file=$name; bytes=(Get-Item -LiteralPath $file).Length; sha256=$actualHash; portable_sha256=$expected.sha256; expected_installed_sha256=$expectedHash; matches_release=$true; comparison=$comparison }
}
$receipt = @{ status='passed'; installer=(Split-Path -Leaf $installer); installer_sha256=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(); destination=$destination; exit_code=$process.ExitCode; installed=$installed; scope='Per-user NSIS silent install into verified project-local .build/install-smoke directory'; launched=$false }
$verification = Join-Path $projectRoot 'output\verification'
New-Item -ItemType Directory -Path $verification -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $verification 'desktop-install-smoke.json'), ($receipt | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
Write-Output 'Silent installation passed. Receipt: output/verification/desktop-install-smoke.json'
