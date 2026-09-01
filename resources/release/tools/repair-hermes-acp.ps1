<#
Pylon helper for the Hermes ACP/MSYS stdin deadlock.

The bug is in Hermes' source (tools/environments/local.py): the Git Bash
health probe inherited the ACP JSON-RPC stdin pipe.  This script is shipped as
an optional repair for source-based Hermes installs.  It never changes a
binary and always writes a timestamped backup before editing.
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Repair,
    [switch]$Restore,
    [string]$HermesRoot
)

$ErrorActionPreference = "Stop"

function Add-UniquePath([System.Collections.Generic.List[string]]$List, [string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    try { $full = [IO.Path]::GetFullPath($Path) } catch { return }
    if ((Test-Path -LiteralPath $full -PathType Container) -and -not $List.Contains($full)) {
        [void]$List.Add($full)
    }
}

function Resolve-HermesRoots {
    $roots = [System.Collections.Generic.List[string]]::new()
    Add-UniquePath $roots $HermesRoot
    Add-UniquePath $roots $env:HERMES_AGENT_HOME
    Add-UniquePath $roots $env:HERMES_HOME

    $command = Get-Command hermes -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        $bin = Split-Path -Parent $command.Source
        Add-UniquePath $roots $bin
        Add-UniquePath $roots (Split-Path -Parent $bin)
    }

    Add-UniquePath $roots (Join-Path $env:LOCALAPPDATA "hermes")
    Add-UniquePath $roots (Join-Path $env:USERPROFILE ".hermes")
    return $roots
}

function Find-HermesLocalFiles {
    $files = [System.Collections.Generic.List[string]]::new()
    foreach ($root in (Resolve-HermesRoots)) {
        # Most installs are either a checkout root or venv\Scripts.  Searching
        # only local.py below these roots avoids traversing unrelated user data.
        Get-ChildItem -LiteralPath $root -Filter local.py -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Directory.Name -eq "environments" -and
                $_.Directory.Parent -and $_.Directory.Parent.Name -eq "tools"
            } |
            ForEach-Object {
                $path = $_.FullName
                if (-not $files.Contains($path)) { [void]$files.Add($path) }
            }
    }
    return $files
}

function Read-Source([string]$Path) {
    return [IO.File]::ReadAllText($Path)
}

function Test-HermesPatch([string]$Text) {
    $function = [regex]::Match($Text, '(?ms)^def\s+_bash_starts\s*\(.*?(?=^def\s+|\z)')
    if (-not $function.Success) { return $false }
    return [regex]::IsMatch($function.Value, 'stdin\s*=\s*subprocess\.DEVNULL')
}

function Invoke-Check {
    $files = Find-HermesLocalFiles
    if ($files.Count -eq 0) {
        Write-Host "未找到 Hermes 源码（tools\environments\local.py）。"
        Write-Host "如果使用的是已编译 hermes.exe，请升级 Hermes 到包含 8f956812c 的版本。"
        return $false
    }
    $allFixed = $true
    foreach ($path in $files) {
        $fixed = Test-HermesPatch (Read-Source $path)
        $state = if ($fixed) { "已修复" } else { "需要修复" }
        Write-Host ("[{0}] {1}" -f $state, $path)
        if (-not $fixed) { $allFixed = $false }
    }
    return $allFixed
}

function Invoke-Repair {
    $files = Find-HermesLocalFiles
    if ($files.Count -eq 0) {
        Write-Host "未找到可修改的 Hermes 源码。请使用 Hermes 官方更新，或用 -HermesRoot 指定源码目录。"
        return $false
    }
    $changed = $false
    foreach ($path in $files) {
        $text = Read-Source $path
        if (Test-HermesPatch $text) {
            Write-Host "[已修复] $path"
            continue
        }

        $pattern = '(?m)(^\s*\[bash,\s*"--noprofile",\s*"--norc",\s*"-c",\s*_BASH_EXTERNAL_PROGRAM_PROBE\],\r?\n)(\s*)capture_output=True'
        $match = [regex]::Match($text, $pattern)
        if (-not $match.Success) {
            Write-Warning "无法识别 Hermes 版本，未修改：$path"
            continue
        }
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backup = "$path.pylon-backup-$stamp"
        Copy-Item -LiteralPath $path -Destination $backup -Force
        $replacement = $match.Groups[1].Value + $match.Groups[2].Value +
            "# ACP stdin is a JSON-RPC pipe; the health probe never reads it.`r`n" +
            $match.Groups[2].Value + "stdin=subprocess.DEVNULL,`r`n" +
            $match.Groups[2].Value + "capture_output=True"
        $patched = $text.Substring(0, $match.Index) + $replacement +
            $text.Substring($match.Index + $match.Length)
        [IO.File]::WriteAllText($path, $patched, [Text.UTF8Encoding]::new($false))
        Write-Host "[已修复] $path（备份：$backup）"
        $changed = $true
    }
    return $changed
}

function Invoke-Restore {
    $restored = $false
    foreach ($root in (Resolve-HermesRoots)) {
        Get-ChildItem -LiteralPath $root -Filter "local.py.pylon-backup-*" -File -Recurse -ErrorAction SilentlyContinue |
            Group-Object DirectoryName | ForEach-Object {
                $latest = $_.Group | Sort-Object LastWriteTime -Descending | Select-Object -First 1
                $target = Join-Path $_.DirectoryName "local.py"
                Copy-Item -LiteralPath $latest.FullName -Destination $target -Force
                Write-Host "[已还原] $target（来源：$($latest.Name)）"
                $restored = $true
            }
    }
    if (-not $restored) { Write-Host "未找到 Pylon 备份。" }
    return $restored
}

if (-not ($Check -or $Repair -or $Restore)) {
    Write-Host "Hermes ACP 修复工具"
    Write-Host "1) 检查  2) 修复（自动备份）  3) 还原最近备份  4) 退出"
    $choice = Read-Host "请选择"
    switch ($choice) {
        "1" { $Check = $true }
        "2" { $Repair = $true }
        "3" { $Restore = $true }
        default { exit 0 }
    }
}

if ($Check) { [void](Invoke-Check) }
if ($Repair) { [void](Invoke-Repair); [void](Invoke-Check) }
if ($Restore) { [void](Invoke-Restore); [void](Invoke-Check) }
