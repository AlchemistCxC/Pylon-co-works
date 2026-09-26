# perf-bench · 进程树采样器（#376/#375 的实机口径）
#
# 量的是**整棵进程树**的 WorkingSet64：pylon.exe 宿主 + 它的 msedgewebview2.exe 子进程组
# （renderer/gpu/utility/crashpad 各是独立进程，页面 JS 堆只是其中一小部分）。
# 页面内读数（performance.memory / CDP HeapProfiler.collectGarbage）另算，见 README。
#
# 用法（ASCII-only，避免 PowerShell 编码坑）：
#   powershell -ExecutionPolicy Bypass -File scripts/perf-bench/proc-tree.ps1 -RootName pylon.exe -Seconds 60 -IntervalMs 500
#   powershell -ExecutionPolicy Bypass -File scripts/perf-bench/proc-tree.ps1 -RootPid 12345 -Seconds 30 -OutCsv mem.csv
#
# 输出：每采样一行 CSV（时间 / 各进程名合计 / 树总计），末行是峰值小结。
# 判据用**比值**：峰值 / 稳态（同一轮里取最后 20% 采样的中位作为稳态）。

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

function Expand-Tree {
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
    $pid = [int]$queue.Dequeue()
    if ($seen.ContainsKey($pid)) { continue }
    $seen[$pid] = $true
    $row = $Table | Where-Object { [int]$_.ProcessId -eq $pid } | Select-Object -First 1
    if ($null -ne $row) { [void]$result.Add($row) }
    if ($byParent.ContainsKey($pid)) {
      foreach ($child in $byParent[$pid]) { $queue.Enqueue([int]$child.ProcessId) }
    }
  }
  return $result
}

function Resolve-Roots {
  param($Table)
  if ($RootPid -gt 0) { return @($RootPid) }
  $matches = $Table | Where-Object { $_.Name -like $RootName }
  if (-not $matches) { throw "no process named '$RootName' found (start the app first, or pass -RootPid)" }
  return @($matches | ForEach-Object { [int]$_.ProcessId })
}

$samples = New-Object System.Collections.ArrayList
$deadline = (Get-Date).AddSeconds($Seconds)
Write-Host "sampling process tree of '$RootName' for ${Seconds}s every ${IntervalMs}ms ..."
while ((Get-Date) -lt $deadline) {
  $table = Get-ProcessTable
  $roots = Resolve-Roots -Table $table
  $tree = Expand-Tree -Table $table -Roots $roots
  $groups = @{}
  $total = 0
  foreach ($row in $tree) {
    $name = [string]$row.Name
    $bytes = [int64]$row.WorkingSetSize
    $total += $bytes
    $key = 'other'
    if ($name -match $GroupPattern) { $key = $name }
    if (-not $groups.ContainsKey($key)) { $groups[$key] = [int64]0 }
    $groups[$key] = $groups[$key] + $bytes
  }
  $sample = [pscustomobject]@{ at = (Get-Date).ToString('s'); total = $total; groups = $groups }
  [void]$samples.Add($sample)
  Start-Sleep -Milliseconds $IntervalMs
}

if ($samples.Count -eq 0) { throw 'no samples collected' }

$groupNames = @()
foreach ($sample in $samples) { foreach ($name in $sample.groups.Keys) { if ($groupNames -notcontains $name) { $groupNames += $name } } }

$csv = New-Object System.Collections.ArrayList
[void]$csv.Add((@('at', 'totalMB') + ($groupNames | ForEach-Object { "$_`MB" })) -join ',')
foreach ($sample in $samples) {
  $cells = @($sample.at, [math]::Round($sample.total / 1MB, 1))
  foreach ($name in $groupNames) {
    $value = 0
    if ($sample.groups.ContainsKey($name)) { $value = $sample.groups[$name] }
    $cells += [math]::Round($value / 1MB, 1)
  }
  [void]$csv.Add(($cells -join ','))
}
if ($OutCsv -ne '') { $csv | Set-Content -Path $OutCsv -Encoding utf8 }
$csv | ForEach-Object { Write-Host $_ }

# 稳态 = 末 20% 采样的中位数；峰值 = 全程最大。输出比值（本仓验收口径）。
$tailCount = [math]::Max(1, [int]($samples.Count * 0.2))
$tail = $samples | Select-Object -Last $tailCount
$steadyTotal = ($tail | ForEach-Object { $_.total } | Sort-Object)[[int]($tailCount / 2)]
$peakTotal = ($samples | ForEach-Object { $_.total } | Measure-Object -Maximum).Maximum
Write-Host ''
Write-Host ('samples={0}  steady={1:N1}MB  peak={2:N1}MB  peak/steady={3:N2}x' -f `
  $samples.Count, ($steadyTotal / 1MB), ($peakTotal / 1MB), ($peakTotal / [math]::Max(1, $steadyTotal)))
foreach ($name in $groupNames) {
  $steadyGroup = ($tail | ForEach-Object { if ($_.groups.ContainsKey($name)) { $_.groups[$name] } else { 0 } } | Sort-Object)[[int]($tailCount / 2)]
  $peakGroup = ($samples | ForEach-Object { if ($_.groups.ContainsKey($name)) { $_.groups[$name] } else { 0 } } | Measure-Object -Maximum).Maximum
  Write-Host ('  {0,-20} steady={1,8:N1}MB  peak={2,8:N1}MB  peak/steady={3:N2}x' -f `
    $name, ($steadyGroup / 1MB), ($peakGroup / 1MB), ($peakGroup / [math]::Max(1, $steadyGroup)))
}
