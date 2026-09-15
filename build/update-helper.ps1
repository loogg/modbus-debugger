param([Parameter(Mandatory=$true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Add-Type -AssemblyName System.IO.Compression.FileSystem
$utf8 = New-Object System.Text.UTF8Encoding($false)
$planData = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$jobRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PlanPath))
$dataRoot = [IO.Path]::GetFullPath($planData.dataRoot).TrimEnd('\')
$installRoot = [IO.Path]::GetFullPath($planData.installDir).TrimEnd('\')
$backupRoot = Join-Path $dataRoot ('data\updates\backups\' + (Split-Path -Leaf $jobRoot))
$stageRoot = Join-Path $jobRoot 'stage'
$statusPath = Join-Path $jobRoot 'status.json'
$resultPath = Join-Path $dataRoot 'data\updates\last-install.json'
$committed = $false
$modified = $false
$startedApp = $null
$installer = $null
$registryBackup = $null
$registryKey = $null
$changedFiles = New-Object 'System.Collections.Generic.List[string]'
$backedFiles = New-Object 'System.Collections.Generic.List[string]'
$tempFiles = New-Object 'System.Collections.Generic.List[string]'

function Write-Json($file, $value) {
  $parent = Split-Path -Parent $file
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $text = ConvertTo-Json -InputObject $value -Depth 12
  $tempFile = $file + '.tmp'
  [IO.File]::WriteAllText($tempFile, $text, $utf8)
  Move-Item -LiteralPath $tempFile -Destination $file -Force
}
function Status($phase, $message) {
  Write-Json $statusPath @{phase=$phase; message=$message; nonce=$planData.nonce}
}
function Result($phase, $message) {
  Write-Json $resultPath @{phase=$phase; message=$message; previousVersion=$planData.currentVersion; version=$planData.version; at=[DateTime]::UtcNow.ToString('o'); backupDirectory=$backupRoot; jobDirectory=$jobRoot}
}
function Assert-NotLink($file) {
  if (Test-Path -LiteralPath $file) {
    if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point rejected: $file" }
  }
}
function Safe-Path($root, [string]$relative) {
  if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains('\') -or $relative -match '[<>:"|?*\x00-\x1f]') { throw "Invalid program path: $relative" }
  foreach ($part in $relative.Split('/')) {
    if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or $part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw "Unsafe program path: $relative" }
  }
  $base = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $target = [IO.Path]::GetFullPath((Join-Path $base $relative))
  if (!$target.StartsWith($base+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped its root' }
  $cursor = $target
  while ($cursor.Length -ge $base.Length) { Assert-NotLink $cursor; if ($cursor -eq $base) { break }; $cursor=Split-Path -Parent $cursor }
  return $target
}
function Hash($file) {
  $algorithm=[Security.Cryptography.SHA256]::Create(); $stream=[IO.File]::OpenRead($file)
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Read-Manifest($file, $version) {
  $manifestData=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifestData.schemaVersion -ne 1 -or ($version -and $manifestData.version -ne $version)) { throw 'Manifest version mismatch' }
  $seen=@{}
  $entries=@($manifestData.files)
  if ($entries.Count -eq 0 -or $entries.Count -gt 20000) { throw 'Invalid manifest length' }
  foreach($entry in $entries) {
    $null=Safe-Path $installRoot $entry.path
    if ($entry.path.Split('/')[0] -in @('data','cache','logs','temp') -or $entry.path -eq 'resources/app-files.json' -or $seen.ContainsKey($entry.path) -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Unsafe manifest entry' }
    $seen[$entry.path]=$true
  }
  if (!$seen.ContainsKey('modbus-debugger.exe') -or !$seen.ContainsKey('resources/app.asar')) { throw 'Incomplete application manifest' }
  return @($entries) + @([pscustomobject]@{path='resources/app-files.json';sha256=(Hash $file)})
}
function Verify-Files($root, $entries) {
  foreach($entry in $entries) {
    $file=Safe-Path $root $entry.path
    if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Hash $file) -ne $entry.sha256.ToLowerInvariant()) { throw "Program checksum mismatch: $($entry.path)" }
  }
}
function Copy-Atomic($source, $target) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
  $temporary=$target+'.update-'+$planData.nonce
  $tempFiles.Add($temporary)
  Copy-Item -LiteralPath $source -Destination $temporary -Force
  for($attempt=0; $attempt -lt 80; $attempt++) {
    try {
      if ([IO.File]::Exists($target)) { [IO.File]::Replace($temporary,$target,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary,$target) }
      return
    } catch { if ($attempt -eq 79) { throw }; Start-Sleep -Milliseconds 250 }
  }
}
function Quote-Argument([string]$value) {
  return '"' + [regex]::Replace([regex]::Replace($value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Start-App([bool]$candidate) {
  $startInfo=New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName=$planData.targetExe
  $startInfo.WorkingDirectory=$installRoot
  $launchArguments=@($planData.restartArgs)
  if ($candidate) { $launchArguments+=@(('--update-session='+$jobRoot),('--update-token='+$planData.nonce)) }
  $startInfo.Arguments=($launchArguments | ForEach-Object { Quote-Argument $_ }) -join ' '
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $startInfo.EnvironmentVariables.Remove('MODBUS_E2E_WORKSPACE')
  return [Diagnostics.Process]::Start($startInfo)
}
function Remove-Stage {
  if (Test-Path -LiteralPath $stageRoot) {
    if ([IO.Path]::GetFullPath($stageRoot) -ne (Join-Path $jobRoot 'stage')) { throw 'Unsafe staging cleanup' }
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
}

try {
  if ($planData.schemaVersion -ne 1 -or $planData.nonce -notmatch '^[a-f0-9]{32}$' -or (Split-Path -Parent $jobRoot) -ne (Join-Path $dataRoot 'temp\self-update') -or (Split-Path -Leaf $jobRoot) -notmatch '^install-[a-f0-9-]{36}$') { throw 'Invalid update session' }
  if ($installRoot -eq [IO.Path]::GetPathRoot($installRoot).TrimEnd('\') -or [IO.Path]::GetFullPath((Split-Path -Parent $planData.targetExe)).TrimEnd('\') -ne $installRoot) { throw 'Unsafe installation target' }
  Assert-NotLink $installRoot; Assert-NotLink $jobRoot; Assert-NotLink $planData.assetPath
  if ($planData.kind -notin @('zip','portable','setup')) { throw 'Unsupported update format' }
  Status 'preparing' 'Verifying update package'
  if ((Get-Item -LiteralPath $planData.assetPath).Length -ne $planData.size -or (Hash $planData.assetPath) -ne $planData.sha256) { throw 'Update package checksum mismatch' }
  [IO.Directory]::CreateDirectory($stageRoot) | Out-Null
  $stagedAsset=Join-Path $stageRoot 'package.exe'
  $sourceRoot=$null
  if ($planData.kind -eq 'zip') {
    $archive=[IO.Compression.ZipFile]::OpenRead($planData.assetPath)
    try {
      $total=[long]0
      if ($archive.Entries.Count -gt 30000) { throw 'Too many ZIP entries' }
      foreach($zipEntry in $archive.Entries) {
        $relative=$zipEntry.FullName.Replace('\','/').TrimEnd('/')
        if (!$relative) { continue }
        $target=Safe-Path $stageRoot $relative
        if ((([int64]$zipEntry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'ZIP symlink rejected' }
        $total+=$zipEntry.Length
        if ($total -gt 2147483648) { throw 'Expanded update package is too large' }
        if (!$zipEntry.Name) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
        [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($zipEntry,$target,$false)
      }
    } finally { $archive.Dispose() }
    $manifestFiles=@(Get-ChildItem -LiteralPath $stageRoot -Filter 'app-files.json' -File -Recurse | Where-Object { (Split-Path -Leaf $_.DirectoryName) -eq 'resources' })
    if ($manifestFiles.Count -ne 1) { throw 'Update ZIP must contain one application manifest' }
    $sourceRoot=Split-Path -Parent $manifestFiles[0].DirectoryName
    $newFiles=@(Read-Manifest $manifestFiles[0].FullName $planData.version)
    Verify-Files $sourceRoot $newFiles
  } else {
    Copy-Item -LiteralPath $planData.assetPath -Destination $stagedAsset
    if ((Hash $stagedAsset) -ne $planData.sha256) { throw 'Staged executable checksum mismatch' }
    if ($planData.kind -eq 'portable') {
      $newFiles=@([pscustomobject]@{path=(Split-Path -Leaf $planData.targetExe);sha256=$planData.sha256})
    } else {
      Assert-NotLink $planData.manifestPath
      if ((Hash $planData.manifestPath) -ne $planData.manifestSha256) { throw 'Update manifest checksum mismatch' }
      $newFiles=@(Read-Manifest $planData.manifestPath $planData.version)
    }
  }
  if ($planData.kind -eq 'portable') { $oldFiles=@([pscustomobject]@{path=(Split-Path -Leaf $planData.targetExe);sha256=(Hash $planData.targetExe)}) }
  else {
    $oldFiles=@(Read-Manifest (Join-Path $installRoot 'resources\app-files.json') $planData.currentVersion)
    if ($planData.kind -eq 'setup' -and (Test-Path -LiteralPath (Join-Path $installRoot 'Uninstall modbus-debugger.exe'))) { $oldFiles+=@([pscustomobject]@{path='Uninstall modbus-debugger.exe';sha256=(Hash (Join-Path $installRoot 'Uninstall modbus-debugger.exe'))}) }
  }
  $oldNames=@{}; foreach($entry in $oldFiles) { $oldNames[$entry.path]=$true }
  foreach($entry in @($newFiles)+@($oldFiles)) {
    $target=Safe-Path $installRoot $entry.path
    if ((Test-Path -LiteralPath $target) -and !$oldNames.ContainsKey($entry.path)) { throw "Update conflicts with a user file: $($entry.path)" }
    foreach($protected in $planData.protectedPaths) { $protectedFull=[IO.Path]::GetFullPath($protected).TrimEnd('\'); if ($target.Equals($protectedFull,[StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($protectedFull+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'User data overlaps program files' } }
  }
  $probe=Join-Path $installRoot ('.update-probe-'+$planData.nonce)
  [IO.File]::WriteAllText($probe,'',$utf8); Remove-Item -LiteralPath $probe
  $waiters=@()
  foreach($reference in $planData.waitProcesses) {
    $processItem=Get-Process -Id $reference.id -ErrorAction Stop
    if (!$processItem.Path.Equals($reference.path,[StringComparison]::OrdinalIgnoreCase)) { throw 'Update parent process identity mismatch' }
    $waiters+=,$processItem
  }
  Status 'ready' 'Update package prepared'
  $deadline=[DateTime]::UtcNow.AddSeconds(120)
  while (!(Test-Path -LiteralPath (Join-Path $jobRoot 'commit.json'))) {
    if ((Test-Path -LiteralPath (Join-Path $jobRoot 'abort')) -or [DateTime]::UtcNow -gt $deadline) { throw 'Update preparation cancelled' }
    Start-Sleep -Milliseconds 100
  }
  $commitData=Get-Content -LiteralPath (Join-Path $jobRoot 'commit.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($commitData.nonce -ne $planData.nonce) { throw 'Invalid update commit token' }
  $committed=$true
  foreach($processItem in $waiters) { if (!$processItem.WaitForExit(60000)) { throw 'Application did not exit' }; $processItem.Dispose() }
  if ($planData.kind -eq 'setup' -and @(Get-Process -Name 'modbus-debugger' -ErrorAction SilentlyContinue).Count -gt 0) { throw 'Close other Modbus Debugger instances before installing' }
  if ($planData.kind -eq 'zip') { Verify-Files $sourceRoot $newFiles } elseif ((Hash $stagedAsset) -ne $planData.sha256) { throw 'Prepared executable changed' }
  Status 'installing' 'Backing up program files'
  [IO.Directory]::CreateDirectory($backupRoot) | Out-Null
  foreach($entry in $oldFiles) {
    $source=Safe-Path $installRoot $entry.path
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      $saved=Safe-Path $backupRoot $entry.path
      [IO.Directory]::CreateDirectory((Split-Path -Parent $saved)) | Out-Null
      Copy-Item -LiteralPath $source -Destination $saved
      if ((Hash $source) -ne (Hash $saved)) { throw 'Program backup verification failed' }
      $backedFiles.Add($entry.path)
    }
  }
  Write-Json (Join-Path $backupRoot 'recovery.json') @{plan=$planData;oldFiles=$backedFiles.ToArray();newFiles=@($newFiles | ForEach-Object {$_.path})}
  $modified=$true
  if ($planData.kind -eq 'setup') {
    $uninstallPrefix='"'+(Join-Path $installRoot 'Uninstall modbus-debugger.exe')+'"'
    $keys=@(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties['UninstallString'] -and $_.UninstallString.StartsWith($uninstallPrefix,[StringComparison]::OrdinalIgnoreCase) })
    if($keys.Count -ne 1){throw 'Cannot identify the current Setup registration'}
    $registryKey=$keys[0].PSPath.Replace('Microsoft.PowerShell.Core\Registry::','')
    $registryBackup=Join-Path $backupRoot 'installation.reg'
    & reg.exe export $registryKey $registryBackup /y | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Cannot back up Setup registration'}
    foreach($entry in $newFiles) {$changedFiles.Add($entry.path)}
    $installer=Start-Process -FilePath $stagedAsset -ArgumentList @('/S',('/D='+$installRoot)) -WindowStyle Hidden -PassThru
    if (!$installer.WaitForExit(240000)) { throw 'Setup timed out' }
    if ($installer.ExitCode -ne 0) { throw "Setup failed: $($installer.ExitCode)" }; $installer.Dispose(); $installer=$null
    Verify-Files $installRoot $newFiles
  } else {
    foreach($entry in $newFiles) {
      $changedFiles.Add($entry.path)
      $source=if($planData.kind -eq 'portable'){$stagedAsset}else{Safe-Path $sourceRoot $entry.path}
      Copy-Atomic $source (Safe-Path $installRoot $entry.path)
    }
    $newNames=@{}; foreach($entry in $newFiles){$newNames[$entry.path]=$true}
    foreach($entry in $oldFiles){if(!$newNames.ContainsKey($entry.path)){ $changedFiles.Add($entry.path); $obsolete=Safe-Path $installRoot $entry.path; if(Test-Path -LiteralPath $obsolete){Remove-Item -LiteralPath $obsolete -Force} }}
    Verify-Files $installRoot $newFiles
  }
  Status 'restarting' 'Starting the updated application'
  $startedApp=Start-App $true
  $deadline=[DateTime]::UtcNow.AddMilliseconds($planData.bootTimeoutMs)
  $booted=$false
  while([DateTime]::UtcNow -lt $deadline) {
    if(Test-Path -LiteralPath (Join-Path $jobRoot 'boot-ok.json')) {
      try {$boot=Get-Content -LiteralPath (Join-Path $jobRoot 'boot-ok.json') -Raw -Encoding UTF8 | ConvertFrom-Json; if($boot.nonce -eq $planData.nonce -and $boot.version -eq $planData.version){$booted=$true;break}} catch {}
    }
    if($startedApp.HasExited){throw 'Updated application exited before startup confirmation'}
    Start-Sleep -Milliseconds 200
  }
  if(!$booted){throw 'Updated application did not confirm startup'}
  Status 'success' 'Update completed'; Result 'success' '软件已更新并重新启动。'
  try {Remove-Stage} catch { [IO.File]::WriteAllText((Join-Path $jobRoot 'cleanup-warning.txt'),$_.Exception.Message,$utf8) }
  exit 0
} catch {
  $failure=$_.Exception.Message
  if($installer -and !$installer.HasExited) { & taskkill.exe /PID $installer.Id /T /F 2>$null | Out-Null; $installer.WaitForExit(15000) | Out-Null; $installer.Dispose() }
  if($startedApp -and !$startedApp.HasExited) { & taskkill.exe /PID $startedApp.Id /T /F 2>$null | Out-Null; $startedApp.WaitForExit(15000) | Out-Null; $startedApp.Dispose() }
  try {
    if($modified) {
      foreach($relative in @($changedFiles.ToArray() | Select-Object -Unique)) {
        $target=Safe-Path $installRoot $relative
        if($backedFiles.Contains($relative)) {Copy-Atomic (Safe-Path $backupRoot $relative) $target}
        elseif(Test-Path -LiteralPath $target -PathType Leaf){Remove-Item -LiteralPath $target -Force}
      }
      foreach($relative in $backedFiles) {if(!$changedFiles.Contains($relative)){Copy-Atomic (Safe-Path $backupRoot $relative) (Safe-Path $installRoot $relative)}}
      if($registryBackup -and (Test-Path -LiteralPath $registryBackup)){ & reg.exe import $registryBackup | Out-Null; if($LASTEXITCODE -ne 0){throw 'Could not restore Setup registration'} }
    }
    Status 'failed' $failure
    if($committed){Result 'rolled-back' ('升级失败，已恢复旧程序：'+$failure); $null=Start-App $false}
  } catch { Status 'failed' ($failure+'; rollback: '+$_.Exception.Message); if($committed){Result 'failed' ('自动回滚未完成，旧程序备份保留在：'+$backupRoot)} }
  try {Remove-Stage} catch {}
  exit 1
} finally {
  foreach($temporary in $tempFiles) { if(Test-Path -LiteralPath $temporary -PathType Leaf){Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue} }
}
