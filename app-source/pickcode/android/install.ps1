param(
    [string]$Apk = (Join-Path $PSScriptRoot 'app/build/outputs/apk/debug/app-debug.apk'),
    [ValidateSet('Production', 'Benchmark', 'BenchmarkTest')][string]$Target = 'Production',
    [switch]$CheckOnly,
    [string]$SdkRoot = 'F:/Android/Sdk',
    [string]$JavaRoot = 'F:/Java/OpenJDK17U-jdk_x64_windows_hotspot_17.0.19_10/jdk-17.0.19+10',
    [string]$ConsolePath = 'O:/leidian/LDPlayer14/ldconsole.exe'
)
$ErrorActionPreference = 'Stop'

function Invoke-InstallTool([string]$Executable, [string[]]$Arguments) {
    $output = @(& $Executable @Arguments 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { throw "Tool failed (exit $LASTEXITCODE): $Executable`n$($output -join "`n")" }
    return $output
}

function Get-OrdinaryEmulator([string]$ConsolePath) {
    $savedEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)
        $instances = @(Invoke-InstallTool $ConsolePath @('list2'))
    } finally { [Console]::OutputEncoding = $savedEncoding }
    $ordinary = @($instances | Where-Object { $_ -match '^\d+,雷电模拟器,' })
    if ($ordinary.Count -ne 1) { throw 'Exactly one LDPlayer instance named 雷电模拟器 is required; JDYK is forbidden.' }
    $fields = $ordinary[0].Split(',')
    if ($fields[4] -ne '1') { throw 'The ordinary LDPlayer instance is not running.' }
    $serial = @(Invoke-InstallTool $ConsolePath @('adb', '--index', $fields[0], '--command', 'get-serialno'))
    $serial = @($serial | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($serial.Count -ne 1 -or $serial[0] -notmatch '^emulator-\d+$') { throw 'Cannot verify the ordinary emulator serial.' }
    return [pscustomobject]@{ name = $fields[1]; index = [int]$fields[0]; serial = $serial[0] }
}

function Get-ApkIdentity([string]$Path, [hashtable]$Tools) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    # aapt on Windows cannot open a full path containing Chinese characters.
    Push-Location (Split-Path -Parent $resolved)
    try {
        $leaf = Split-Path -Leaf $resolved
        $badging = @(Invoke-InstallTool $Tools.aapt @('dump', 'badging', $leaf))
        $certs = @(Invoke-InstallTool $Tools.java @('-jar', $Tools.signer, 'verify', '--print-certs', $leaf))
    } finally { Pop-Location }
    $packageLine = @($badging | Where-Object { $_ -match '^package:' })
    if ($packageLine.Count -ne 1 -or $packageLine[0] -notmatch "^package: name='([^']+)' versionCode='(\d*)' versionName='([^']*)'") { throw 'Cannot parse APK package/version.' }
    $packageId = $Matches[1]; $versionCode = if ($Matches[2]) { [long]$Matches[2] } else { 0 }; $versionName = $Matches[3]
    $digests = @($certs | ForEach-Object { if ($_ -match '^(?:Signer #\d+|V[1-4] Signer(?: #\d+)?):? certificate SHA-256 digest: ([0-9a-fA-F]{64})$') { $Matches[1].ToLowerInvariant() } } | Sort-Object -Unique)
    if (-not $digests.Count) { throw 'APK signing certificate is unavailable.' }
    $label = @($badging | ForEach-Object { if ($_ -match "^application-label:'(.*)'$") { $Matches[1] } }) -join ''
    return [pscustomobject]@{ package = $packageId; versionCode = $versionCode; versionName = $versionName; label = $label; signers = $digests; sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Assert-ApkReplacement($Candidate, $Installed, [string]$Target) {
    $expected = @{ Production = 'local.pickcode.assistant'; Benchmark = 'local.pickcode.assistant.benchmark'; BenchmarkTest = 'local.pickcode.assistant.benchmark.test' }[$Target]
    if (-not $expected -or $Candidate.package -ne $expected) { throw "Wrong application ID for $Target. Expected $expected; received $($Candidate.package)." }
    if ($Target -eq 'Benchmark' -and $Candidate.label -ne '取件码助手·基准测试') { throw 'Benchmark APK must be visibly labelled 取件码助手·基准测试; prepare a new disposable build.' }
    if ($Target -eq 'Production' -and $Candidate.versionCode -le 0) { throw 'Production APK must declare a versionCode.' }
    if ($Installed) {
        if ($Installed.package -ne $expected) { throw 'Installed application ID differs from the expected target.' }
        if (($Candidate.signers -join ',') -ne ($Installed.signers -join ',')) { throw 'Signing certificate mismatch. Installation stopped; keep the existing app and data.' }
        if ($Candidate.versionCode -lt $Installed.versionCode) { throw 'Version downgrade refused. Installation stopped; keep the existing app and data.' }
    }
}

function Get-InstalledApkIdentity([string]$Package, [string]$Serial, [hashtable]$Tools) {
    $packages = @(Invoke-InstallTool $Tools.adb @('-s', $Serial, 'shell', 'pm', 'list', 'packages', $Package))
    if ($packages -notcontains "package:$Package") { return $null }
    $paths = @(Invoke-InstallTool $Tools.adb @('-s', $Serial, 'shell', 'pm', 'path', $Package))
    $base = @($paths | Where-Object { $_ -match '^package:/data/app/[^\s]+/base\.apk$' })
    if ($base.Count -ne 1) { throw 'Cannot verify the installed base APK.' }
    $temporaryApk = Join-Path ([IO.Path]::GetTempPath()) ("pickcode-installed-" + [guid]::NewGuid().ToString('N') + '.apk')
    try {
        Invoke-InstallTool $Tools.adb @('-s', $Serial, 'pull', $base[0].Substring(8), $temporaryApk) | Out-Null
        return Get-ApkIdentity $temporaryApk $Tools
    } finally {
        if (Test-Path -LiteralPath $temporaryApk) { Remove-Item -LiteralPath $temporaryApk }
    }
}

function Install-PickCodeApk([string]$Apk, [string]$Target, [bool]$CheckOnly, [hashtable]$Tools, [string]$ConsolePath) {
    $device = Get-OrdinaryEmulator $ConsolePath
    $candidate = Get-ApkIdentity $Apk $Tools
    Assert-ApkReplacement $candidate $null $Target
    $installed = Get-InstalledApkIdentity $candidate.package $device.serial $Tools
    Assert-ApkReplacement $candidate $installed $Target
    $result = [ordered]@{ mode = 'check-only'; device = $device; target = $Target; candidate = $candidate; installed = $installed; compatible = $true; changed = $false }
    if ($CheckOnly) { return [pscustomobject]$result }
    if ($installed -and $installed.sha256 -eq $candidate.sha256) {
        $result.mode = 'already-installed'
        return [pscustomobject]$result
    }
    $confirmedDevice = Get-OrdinaryEmulator $ConsolePath
    if ($confirmedDevice.serial -ne $device.serial -or $confirmedDevice.index -ne $device.index) { throw 'Emulator mapping changed before installation.' }
    # Do not add -d, uninstall, pm clear, or a failure-recovery reinstall here.
    $output = @(Invoke-InstallTool $Tools.adb @('-s', $device.serial, 'install', '-r', (Resolve-Path -LiteralPath $Apk).Path))
    if ($output -notcontains 'Success') { throw "APK install did not report Success. Existing data was not cleared.`n$($output -join "`n")" }
    $after = Get-InstalledApkIdentity $candidate.package $device.serial $Tools
    if (-not $after -or $after.sha256 -ne $candidate.sha256) { throw 'Installed APK verification differs from the candidate; no recovery action was performed.' }
    $result.mode = 'installed'; $result.changed = $true; $result.installed = $after
    return [pscustomobject]$result
}

if ($MyInvocation.InvocationName -ne '.') {
    $buildTools = @(Get-ChildItem -LiteralPath (Join-Path $SdkRoot 'build-tools') -Directory | Sort-Object { [version]$_.Name } -Descending | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'lib/apksigner.jar') })
    if (-not $buildTools.Count) { throw 'Android build-tools with apksigner are required.' }
    $tools = @{ adb = Join-Path $SdkRoot 'platform-tools/adb.exe'; aapt = Join-Path $buildTools[0].FullName 'aapt.exe'; signer = Join-Path $buildTools[0].FullName 'lib/apksigner.jar'; java = Join-Path $JavaRoot 'bin/java.exe' }
    foreach ($toolPath in @($tools.Values) + @($ConsolePath)) { if (-not (Test-Path -LiteralPath $toolPath)) { throw "Missing installation tool: $toolPath" } }
    Install-PickCodeApk $Apk $Target $CheckOnly.IsPresent $tools $ConsolePath | ConvertTo-Json -Depth 6
}
