# perf-bench process-tree sampler (#376/#375 real-device reading).
#
# Measures WorkingSet64 of the WHOLE tree: the pylon.exe host plus its msedgewebview2.exe
# child processes (renderer/gpu/utility/crashpad are separate processes; the page JS heap is
# only a fraction of the group). Page-side readings (performance.memory / CDP
# HeapProfiler.collectGarbage) are separate -- see README "memory domain".
#
# IMPORTANT: this file is deliberately ASCII-only. Windows PowerShell 5.x decodes .ps1 files
# without a BOM using the ANSI codepage (CP936 on Chinese Windows); a multi-byte character at
# the end of a comment can then swallow the following CRLF and comment out the next line
# (this file previously had exactly that bug: a Chinese comment ate a newline and turned the
# steady-state computation into a comment). Keep every comment ASCII.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/perf-bench/proc-tree.ps1 -RootName pylon.exe -Seconds 60 -IntervalMs 500
#   powershell -ExecutionPolicy Bypass -File scripts/perf-bench/proc-tree.ps1 -RootPid 12345 -Seconds 30 -OutCsv mem.csv
#
# Output: one CSV row per sample (time / per-process-name totals / tree total), then a summary
# line with steady / peak / peak-steady per group. The acceptance criterion is a RATIO
# (host and renderer group each <= 2x), so no absolute MB is asserted here.

[CmdletBinding()]
param(
  [string]$RootName = 'pylon.exe',
  [int]$RootPid = 0,
  [int]$Seconds = 60,
  [int]$IntervalMs = 500,
  [string]$OutCsv = '',
  [string]$GroupPattern = 'pylon|msedgewebview2|WebView2|node|python'
)

function Get-ProcessTable {
  Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize
}

function Get-TreeRows {
  param($Table, [int[]]$Roots)
  $byParent = @{}
  foreach ($row in $Table) {
    $parent = [int]$row.ParentProcessId
    if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = New-Object System.Collections.ArrayList }
    [void]$byParent[$parent].Add($row)
  }
  $seen = @{}
  $queue = New-Object System.Collections.Queue
  foreach ($root in $Roots) { $queue.Enqueue($root) }
  $result = New-Object System.Collections.ArrayList
  while ($queue.Count -gt 0) {
    # NOTE: do not name this $pid -- $pid is a READ-ONLY automatic variable in PowerShell and
    # assigning to it raises a non-terminating error, leaving the loop operating on the
    # PowerShell process itself (that silently measured the wrong tree).
    $currentId = [int]$queue.Dequeue()
    if ($seen.ContainsKey($currentId)) { continue }
    $seen[$currentId] = $true
    $row = $Table | Where-Object { [int]$_.ProcessId -eq $currentId } | Select-Object -First 1
    if ($null -ne $row) { [void]$result.Add($row) }
    if ($byParent.ContainsKey($currentId)) {
      foreach ($child in $byParent[$currentId]) { $queue.Enqueue([int]$child.ProcessId) }
    }
  }
  return $result
}

function Get-Roots {
  param($Table)
  if ($RootPid -gt 0) { return @($RootPid) }
  $matched = @($Table | Where-Object { $_.Name -like $RootName })
  return @($matched | ForEach-Object { [int]$_.ProcessId })
}

$samples = New-Object System.Collections.ArrayList
$warnedRoots = ''
$deadline = (Get-Date).AddSeconds($Seconds)
Write-Host "sampling process tree of '$RootName' for ${Seconds}s every ${IntervalMs}ms ..."
$sawRoot = $false
while ((Get-Date) -lt $deadline) {
  $table = Get-ProcessTable
  $roots = Get-Roots -Table $table
  # A root that disappears mid-run must not discard the whole run: record a gap sample and keep
  # going (the sampler may be started slightly before the app, or one instance may exit).
  if ($roots.Count -eq 0) {
    [void]$samples.Add([pscustomobject]@{ at = (Get-Date).ToString('s'); total = $null; groups = @{} })
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }
  $sawRoot = $true
  $rootList = ($roots | Sort-Object) -join ','
  if ($rootList -ne $warnedRoots) {
    if ($roots.Count -gt 1) {
      Write-Warning "multiple processes match '$RootName' (pids $rootList) -- their trees are summed into one total; pass -RootPid to isolate one (e.g. the isolated copy's instance)."
    }
    $warnedRoots = $rootList
  }
  $tree = Get-TreeRows -Table $table -Roots $roots
  $groups = @{}
  $total = [int64]0
  foreach ($row in $tree) {
    $name = [string]$row.Name
    $bytes = [int64]$row.WorkingSetSize
    $total += $bytes
    $key = 'other'
    if ($name -match $GroupPattern) { $key = $name }
    if (-not $groups.ContainsKey($key)) { $groups[$key] = [int64]0 }
    $groups[$key] = $groups[$key] + $bytes
  }
  [void]$samples.Add([pscustomobject]@{ at = (Get-Date).ToString('s'); total = $total; groups = $groups })
  Start-Sleep -Milliseconds $IntervalMs
}

if (-not $sawRoot) { throw "no process named '$RootName' was ever observed (start the app first, or pass -RootPid)" }
$valid = @($samples | Where-Object { $null -ne $_.total })
if ($valid.Count -eq 0) { throw 'no valid samples collected' }

$groupNames = @()
foreach ($sample in $valid) { foreach ($name in $sample.groups.Keys) { if ($groupNames -notcontains $name) { $groupNames += $name } } }

$csv = New-Object System.Collections.ArrayList
[void]$csv.Add((@('at', 'totalMB') + ($groupNames | ForEach-Object { "$_`MB" })) -join ',')
foreach ($sample in $samples) {
  $cells = @($sample.at, '')
  if ($null -ne $sample.total) {
    $cells = @($sample.at, [math]::Round($sample.total / 1MB, 1))
    foreach ($name in $groupNames) {
      $value = [int64]0
      if ($sample.groups.ContainsKey($name)) { $value = $sample.groups[$name] }
      $cells += [math]::Round($value / 1MB, 1)
    }
  }
  [void]$csv.Add(($cells -join ','))
}

# Steady state = median of the LAST 20% of valid samples; peak = max over all samples.
$tailCount = [math]::Max(1, [int][math]::Ceiling($valid.Count * 0.2))
$tail = @($valid | Select-Object -Last $tailCount)
$steadyTotal = (@($tail | ForEach-Object { $_.total } | Sort-Object))[[int][math]::Floor($tailCount / 2)]
$peakTotal = ($valid | ForEach-Object { $_.total } | Measure-Object -Maximum).Maximum
Write-Host ''
Write-Host ('samples={0} (valid={1})  steady={2:N1}MB  peak={3:N1}MB  peak/steady={4:N2}x' -f `
  $samples.Count, $valid.Count, ($steadyTotal / 1MB), ($peakTotal / 1MB), ($peakTotal / [math]::Max([int64]1, $steadyTotal)))
foreach ($name in $groupNames) {
  $steadyGroup = (@($tail | ForEach-Object { if ($_.groups.ContainsKey($name)) { $_.groups[$name] } else { [int64]0 } } | Sort-Object))[[int][math]::Floor($tailCount / 2)]
  $peakGroup = ($valid | ForEach-Object { if ($_.groups.ContainsKey($name)) { $_.groups[$name] } else { [int64]0 } } | Measure-Object -Maximum).Maximum
  Write-Host ('  {0,-20} steady={1,8:N1}MB  peak={2,8:N1}MB  peak/steady={3:N2}x' -f `
    $name, ($steadyGroup / 1MB), ($peakGroup / 1MB), ($peakGroup / [math]::Max([int64]1, $steadyGroup)))
}

if ($OutCsv -ne '') { $csv | Set-Content -Path $OutCsv -Encoding utf8 }
$csv | ForEach-Object { Write-Host $_ }
