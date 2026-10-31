[CmdletBinding()]
param(
    [switch]$InstallSystemDeps,
    [switch]$InstallNode,
    [string]$NodeVersion = '24.14.0',
    [switch]$TestNodeVersionOnly,
    [switch]$Help
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Help) {
    Write-Output 'Usage: powershell -NoProfile -File scripts/install.ps1 [-InstallSystemDeps] [-InstallNode] [-NodeVersion 24.14.0]'
    Write-Output 'Builds this checkout. No service startup, proxy changes, data deletion or global process cleanup.'
    Write-Output '-InstallSystemDeps permits Git/MSVC installation with winget. -InstallNode permits an official verified per-user Node.js download.'
    exit 0
}
if ($env:OS -ne 'Windows_NT' -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64') {
    throw 'This installer supports Windows x64. Use scripts/install.sh on Linux/macOS.'
}
if ($NodeVersion -notmatch '^24\.\d+\.\d+$' -or [version]$NodeVersion -lt [version]'24.14.0') {
    throw 'NodeVersion must be >=24.14.0 and <25.'
}
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot
if (!(Test-Path -LiteralPath 'package-lock.json') -or !(Test-Path -LiteralPath 'apps/web/package-lock.json')) {
    throw 'A complete source checkout with both lockfiles is required.'
}
function Test-NodeVersion {
    if (!(Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    # Windows PowerShell 5.1 drops embedded double quotes when passing native
    # arguments, so parse the version in PowerShell instead of via node -e.
    $version = & node --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.(\d+)\.\d+') { return $false }
    return ([int]$Matches[1] -eq 24 -and [int]$Matches[2] -ge 14)
}
# Test-only entry point: execute the real version check under Windows PowerShell 5.1
# without touching npm, the toolchain, services, or the checkout.
if ($TestNodeVersionOnly) {
    if (Test-NodeVersion) { Write-Output 'NODE_VERSION_OK'; exit 0 }
    Write-Output 'NODE_VERSION_UNSUPPORTED'; exit 1
}
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Executable" }
}
function Install-WingetPackage([string]$Id, [string[]]$ExtraArguments = @()) {
    if (!(Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget is unavailable. Install $Id manually and rerun."
    }
    & winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements @ExtraArguments
    if ($LASTEXITCODE -eq 3010) { throw 'System dependencies require a restart. Restart Windows and rerun the installer.' }
    if ($LASTEXITCODE -ne 0) { throw "winget installation failed for $Id ($LASTEXITCODE)." }
}
$ToolchainDir = Join-Path $env:LOCALAPPDATA "NashAgents\toolchains\node-v$NodeVersion-win-x64"
if (!(Test-NodeVersion) -and (Test-Path -LiteralPath (Join-Path $ToolchainDir 'node.exe'))) {
    $env:PATH = "$ToolchainDir;$env:PATH"
}
if (!(Test-NodeVersion)) {
    if (!$InstallNode) { throw 'Node.js >=24.14.0 <25 is required. Install it or rerun with -InstallNode.' }
    $InstallTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('nash-agents-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $InstallTemp | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $Archive = "node-v$NodeVersion-win-x64.zip"
        $ArchivePath = Join-Path $InstallTemp $Archive
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/$Archive" -OutFile $ArchivePath -TimeoutSec 300
        $Sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -TimeoutSec 60).Content
        $Pattern = '(?m)^([a-fA-F0-9]{64})\s+' + [regex]::Escape($Archive) + '\r?$'
        $Match = [regex]::Match($Sums, $Pattern)
        if (!$Match.Success) { throw 'Official Node.js checksum is missing.' }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash -ne $Match.Groups[1].Value) { throw 'Node.js download checksum mismatch.' }
        if (Test-Path -LiteralPath $ToolchainDir) { throw "Toolchain directory exists; inspect it before retrying: $ToolchainDir" }
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $InstallTemp
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ToolchainDir) | Out-Null
        Move-Item -LiteralPath (Join-Path $InstallTemp "node-v$NodeVersion-win-x64") -Destination $ToolchainDir
        $env:PATH = "$ToolchainDir;$env:PATH"
    } finally {
        Remove-Item -LiteralPath $InstallTemp -Recurse -Force
    }
}
if (!(Test-NodeVersion)) { throw 'Unsupported Node.js version.' }
if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    if (!$InstallSystemDeps) { throw 'Git is required.' }
    Install-WingetPackage 'Git.Git'
    $env:PATH = "$ToolchainDir;$env:PATH;" + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
$Vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$Msvc = @()
if (Test-Path -LiteralPath $Vswhere) {
    $Msvc = @(& $Vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
}
if ($Msvc.Count -eq 0) {
    if (!$InstallSystemDeps) { throw 'Visual Studio 2022 Build Tools with Desktop development with C++ and Windows SDK are required.' }
    Install-WingetPackage 'Microsoft.VisualStudio.2022.BuildTools' @('--override', '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
}
Write-Output 'Installing locked dependencies and building this checkout...'
Invoke-Checked 'npm.cmd' @('ci', '--no-audit')
Invoke-Checked 'npm.cmd' @('ci', '--prefix', 'apps/web', '--no-audit')
Invoke-Checked 'npm.cmd' @('run', 'build:helper:win32')
Invoke-Checked 'npm.cmd' @('run', 'build:all')
Write-Output 'Build complete. Initialize explicitly: node dist/index.js init'
Write-Output "Current Node.js: $((Get-Command node).Source)"
Write-Output "For a new PowerShell session, add this toolchain directory to PATH when used: $ToolchainDir"
