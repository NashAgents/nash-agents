[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$HomeDir,
    [Parameter(Mandatory=$true)][string]$Release,
    [string]$TaskName = 'NashAgentsProduct',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Windows is required.' }
if ($Release -cnotmatch '^[a-f0-9]{40}$') { throw 'Release must be a full lowercase commit ID.' }
if ($TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$') { throw 'Invalid task name.' }
$Root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$HomeDir = [System.IO.Path]::GetFullPath($HomeDir).TrimEnd('\')
if ($Root -notmatch '^[A-Za-z]:\\' -or $HomeDir -notmatch '^[A-Za-z]:\\' -or $Root -match '["%\r\n]' -or $HomeDir -match '["%\r\n]' -or $HomeDir.Length -lt 4) { throw 'Invalid installation or home path.' }
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Entry = Join-Path $Root 'dist\cli\windows-product-service-entry.js'
if (!(Test-Path -LiteralPath $Entry -PathType Leaf)) { throw 'The built Windows product service entry is missing.' }
if (!(Test-Path -LiteralPath (Join-Path $HomeDir 'product.db') -PathType Leaf)) { throw 'The product home is not initialized.' }
$BuildInfoPath = Join-Path $Root 'dist\build-info.json'
try { $BuildInfo = Get-Content -LiteralPath $BuildInfoPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Cannot read release metadata.' }
if ($BuildInfo.commit -cne $Release -or $BuildInfo.dirty -ne $false -or $BuildInfo.artifactSha256 -cnotmatch '^[a-f0-9]{64}$' -or $BuildInfo.artifactFileCount -lt 1) { throw 'Release metadata does not match the requested clean build.' }
$NodeVersion = (& $Node --version).TrimStart('v')
if ($LASTEXITCODE -ne 0 -or $NodeVersion -notmatch '^24\.\d+\.\d+$' -or [version]$NodeVersion -lt [version]'24.14.0') { throw 'Node.js >=24.14.0 <25 is required.' }
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) { throw 'A scheduled task with this name already exists; it will not be overwritten.' }
$Arguments = '"{0}" --home "{1}" --release {2}' -f $Entry, $HomeDir, $Release
$Account = (whoami).Trim()
if (!$Apply) {
    [pscustomobject]@{ mode='dry-run'; taskName=$TaskName; account=$Account; executable=$Node; arguments=$Arguments; workingDirectory=$Root; release=$Release; interval='PT1M'; boot=$true; daily=$true; stopAtDurationEnd=$false; multipleInstances='IgnoreNew' } | ConvertTo-Json -Compress
    return
}
# A running unmanaged product must be drained and stopped before enabling this
# task. Never infer process ownership from the PID alone or terminate it here.
$Record = Join-Path $HomeDir 'service.json'
if (Test-Path -LiteralPath $Record -PathType Leaf) {
    try { $Service = Get-Content -LiteralPath $Record -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Cannot read the existing service record; installation refused.' }
    if ($Service.pid -and (Get-Process -Id ([int]$Service.pid) -ErrorAction SilentlyContinue)) { throw 'An existing service process is present; establish a verified drain and stop it first.' }
}
$Lock = Join-Path $HomeDir 'service.lock'
if (Test-Path -LiteralPath $Lock -PathType Leaf) {
    $LockPid = (Get-Content -LiteralPath $Lock -Raw -Encoding UTF8).Trim()
    if ($LockPid -notmatch '^[1-9][0-9]{0,9}$') { throw 'Cannot verify the existing service lock; installation refused.' }
    if (Get-Process -Id ([int]$LockPid) -ErrorAction SilentlyContinue) { throw 'A service lock references a live process; installation refused.' }
}
$Action = New-ScheduledTaskAction -Execute $Node -Argument $Arguments -WorkingDirectory $Root
$Repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)
$Repeat.Repetition.StopAtDurationEnd = $false
$Boot = New-ScheduledTaskTrigger -AtStartup
$Boot.Repetition = $Repeat.Repetition
$Daily = New-ScheduledTaskTrigger -Daily -At '00:00'
$Daily.Repetition = $Repeat.Repetition
$Principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType S4U -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($Boot,$Daily,$Repeat) -Principal $Principal -Settings $Settings -Description "Nash product release $Release; drain before stopping." | Out-Null
Write-Output "Registered $TaskName. Startup is scheduled; verify actual readiness and release identity."
