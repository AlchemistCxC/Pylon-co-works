<#
mem-accounting.ps1 -- De-duplicated memory accounting for a Pylon (Tauri/WebView2) process tree.

WHY: summing WorkingSet across the cluster double counts every shared page. This cluster maps the
same 332 MB msedge.dll into 5-7 processes, so the naive sum overstates by ~1.6x. Task Manager's
per-process numbers cannot be added up.

HOW: for every process in the tree we enumerate the working set page by page (QueryWorkingSet),
then classify each resident page:
  * IMAGE / file-backed MAPPED -> identity = (mapped file, page offset). A page with the same
    identity in several processes is ONE physical page -> union across processes.
  * PRIVATE -> unique by definition -> sum.
  * anonymous (pagefile-backed) MAPPED -> cannot be de-duplicated in user mode (no PFN access),
    reported separately: sum, plus the single-process max as an upper bound.
Result: deduped total = private sum + image union + mapped-file union + [anon sum .. anon max].

GOTCHA (learned the hard way): QueryWorkingSet does NOT return an entry count. If the buffer is
not zeroed, reading "until a zero entry" re-reads stale page addresses from the previous call and
inflates per-module resident bytes. This script zeroes the buffer and de-duplicates page addresses.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\mem-accounting\mem-accounting.ps1
  ... -Json                 # machine readable
  ... -ProcessName foo.exe  # account some other WebView2 host instead of pylon.exe
#>
param(
    [string]$ProcessName = 'pylon.exe',
    [switch]$Json,
    [int]$TopFiles = 12
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class MemAccounting
{
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_VM_READ = 0x0010;
    const uint MEM_COMMIT = 0x1000;
    const uint MEM_IMAGE = 0x1000000;
    const uint MEM_MAPPED = 0x40000;
    const uint PAGE_EXECUTE = 0x10, PAGE_EXECUTE_READ = 0x20, PAGE_EXECUTE_READWRITE = 0x40, PAGE_EXECUTE_WRITECOPY = 0x80;

    [StructLayout(LayoutKind.Sequential)]
    struct MEMORY_BASIC_INFORMATION
    {
        public IntPtr BaseAddress; public IntPtr AllocationBase;
        public uint AllocationProtect; public uint align1; public IntPtr RegionSize;
        public uint State; public uint Protect; public uint Type; public uint align2;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_MEMORY_COUNTERS_EX
    {
        public uint cb; public uint PageFaultCount; public IntPtr PeakWorkingSetSize; public IntPtr WorkingSetSize;
        public IntPtr a; public IntPtr b; public IntPtr c; public IntPtr d; public IntPtr e; public IntPtr f; public IntPtr PrivateUsage;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MODULEINFO { public IntPtr lpBaseOfDll; public uint SizeOfImage; public IntPtr EntryPoint; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr a, out MEMORY_BASIC_INFORMATION m, IntPtr l);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool QueryWorkingSet(IntPtr h, IntPtr buf, uint size);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool GetProcessMemoryInfo(IntPtr h, out PROCESS_MEMORY_COUNTERS_EX c, uint s);
    [DllImport("psapi.dll", CharSet = CharSet.Unicode)] static extern uint GetMappedFileName(IntPtr h, IntPtr a, StringBuilder n, uint s);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool EnumProcessModulesEx(IntPtr h, IntPtr[] m, uint s, out uint n, uint f);
    [DllImport("psapi.dll", CharSet = CharSet.Unicode)] static extern uint GetModuleFileNameEx(IntPtr h, IntPtr m, StringBuilder n, uint s);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool GetModuleInformation(IntPtr h, IntPtr m, out MODULEINFO i, uint s);

    class Mod { public ulong Base; public ulong Size; public string Name; }

    struct Region
    {
        public ulong Base;        // identity base: module base (IMAGE) or allocation base (MAPPED)
        public ulong Size;
        public uint Type;
        public uint Protect;
        public string File;       // module file name or mapped file name; null => anonymous
    }

    public class ProcessResult
    {
        public int Pid;
        public string Role = "?";
        public long WorkingSet;
        public long PrivateUsage;
        public long PrivateResident;
        public long ImageResident;
        public long MappedFileResident;
        public long AnonResident;
        // file -> page offset set, merged by the caller for de-duplication
        public Dictionary<string, HashSet<long>> FilePages = new Dictionary<string, HashSet<long>>();
        public Dictionary<string, long> PerFileSum = new Dictionary<string, long>();
        public long Error;
    }

    static void Zero(IntPtr p, int size) { byte[] z = new byte[size]; Marshal.Copy(z, 0, p, size); }

    static List<Mod> Modules(IntPtr h)
    {
        var res = new List<Mod>();
        var buf = new IntPtr[4096]; uint needed;
        if (!EnumProcessModulesEx(h, buf, (uint)(buf.Length * IntPtr.Size), out needed, 0x03)) return res;
        int count = (int)(needed / (uint)IntPtr.Size);
        for (int i = 0; i < count && i < buf.Length; i++)
        {
            var sb = new StringBuilder(1024);
            if (GetModuleFileNameEx(h, buf[i], sb, 1024) == 0) continue;
            MODULEINFO info;
            if (!GetModuleInformation(h, buf[i], out info, (uint)Marshal.SizeOf(typeof(MODULEINFO)))) continue;
            res.Add(new Mod { Base = (ulong)buf[i].ToInt64(), Size = info.SizeOfImage, Name = System.IO.Path.GetFileName(sb.ToString()) });
        }
        return res;
    }

    static List<Region> Regions(IntPtr h)
    {
        var list = new List<Region>();
        ulong addr = 0;
        int mbi = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
        while (true)
        {
            MEMORY_BASIC_INFORMATION r;
            if (VirtualQueryEx(h, (IntPtr)(long)addr, out r, (IntPtr)mbi) == IntPtr.Zero) break;
            ulong b = (ulong)r.BaseAddress.ToInt64(), size = (ulong)r.RegionSize.ToInt64();
            if (size == 0) break;
            if (r.State == MEM_COMMIT && (r.Type == MEM_IMAGE || r.Type == MEM_MAPPED))
            {
                var sb = new StringBuilder(2048);
                uint n = GetMappedFileName(h, (IntPtr)(long)b, sb, 2048);
                string file = n > 0 ? sb.ToString() : null;
                var reg = new Region { Base = (ulong)r.AllocationBase.ToInt64(), Size = size, Type = r.Type, Protect = r.Protect };
                if (!string.IsNullOrEmpty(file) && file.IndexOf("Pagefile", StringComparison.OrdinalIgnoreCase) < 0)
                    reg.File = System.IO.Path.GetFileName(file);
                list.Add(reg);
            }
            ulong next = b + size;
            if (next <= addr) break;
            addr = next;
        }
        return list;
    }

    static bool IsExec(uint p) { return (p & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) != 0; }

    public static ProcessResult Analyze(int pid, string role)
    {
        var res = new ProcessResult { Pid = pid, Role = role };
        IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (h == IntPtr.Zero) { res.Error = Marshal.GetLastWin32Error(); return res; }
        try
        {
            PROCESS_MEMORY_COUNTERS_EX c;
            if (!GetProcessMemoryInfo(h, out c, (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS_EX)))) { res.Error = -1; return res; }
            res.WorkingSet = c.WorkingSetSize.ToInt64();
            res.PrivateUsage = c.PrivateUsage.ToInt64();

            var regions = Regions(h);
            var mods = Modules(h);

            long pages = res.WorkingSet / 4096 + 8192;
            IntPtr buf = Marshal.AllocHGlobal((int)(pages * 8));
            var resident = new HashSet<long>();
            try
            {
                Zero(buf, (int)(pages * 8));
                if (!QueryWorkingSet(h, buf, (uint)(pages * 8)))
                {
                    Marshal.FreeHGlobal(buf);
                    pages *= 4;
                    buf = Marshal.AllocHGlobal((int)(pages * 8));
                    Zero(buf, (int)(pages * 8));
                }
                if (QueryWorkingSet(h, buf, (uint)(pages * 8)))
                {
                    for (long i = 0; i < pages; i++)
                    {
                        long va = Marshal.ReadInt64(buf, (int)(i * 8));
                        if (va == 0) break;
                        resident.Add(va);
                    }
                }
            }
            finally { Marshal.FreeHGlobal(buf); }

            foreach (long va in resident)
            {
                ulong u = (ulong)va;
                Region? hit = null;
                foreach (var r in regions)
                {
                    if (u >= r.Base && u < r.Base + r.Size) { hit = r; break; }
                }
                if (hit == null) { res.PrivateResident += 4096; continue; }
                var reg = hit.Value;
                if (reg.File == null) { res.AnonResident += 4096; continue; }
                if (reg.File != null)
                {
                    long off = (long)((u - reg.Base) / 4096);
                    HashSet<long> set;
                    if (!res.FilePages.TryGetValue(reg.File, out set)) { set = new HashSet<long>(); res.FilePages[reg.File] = set; }
                    set.Add(off);
                    long cur; res.PerFileSum.TryGetValue(reg.File, out cur);
                    res.PerFileSum[reg.File] = cur + 4096;
                    if (reg.Type == MEM_IMAGE) res.ImageResident += 4096; else res.MappedFileResident += 4096;
                }
                else { res.AnonResident += 4096; }
            }
            res.PrivateResident = res.WorkingSet - res.ImageResident - res.MappedFileResident - res.AnonResident;
        }
        finally { CloseHandle(h); }
        return res;
    }
}
'@ -Language CSharp

# ---- process tree -----------------------------------------------------------
$all = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $ProcessName -or $_.Name -eq 'msedgewebview2.exe' }
$byParent = @{}
foreach ($p in $all) {
    $k = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($k)) { $byParent[$k] = @() }
    $byParent[$k] += $p
}
$tree = New-Object System.Collections.Generic.List[object]
foreach ($root in @($all | Where-Object { $_.Name -eq $ProcessName })) {
    $tree.Add(@{ proc = $root; role = 'app' })
    foreach ($c in @($byParent[[int]$root.ProcessId])) {
        $cl = [string]$c.CommandLine
        $role = 'browser'
        if ($cl -match '--type=([a-zA-Z\-]+)') { $role = $matches[1] }
        $tree.Add(@{ proc = $c; role = $role })
        foreach ($g in @($byParent[[int]$c.ProcessId])) {
            $gcl = [string]$g.CommandLine
            $grole = 'child'
            if ($gcl -match '--type=([a-zA-Z\-]+)') { $grole = $matches[1] }
            $tree.Add(@{ proc = $g; role = $grole })
        }
    }
}
if ($tree.Count -eq 0) { Write-Output "no '$ProcessName' process found"; exit 1 }

# ---- account ----------------------------------------------------------------
$results = New-Object System.Collections.Generic.List[object]
foreach ($entry in $tree) {
    $results.Add([MemAccounting]::Analyze($entry.proc.ProcessId, $entry.role))
}

$fileSets = @{}
$fileSum = @{}
foreach ($r in $results) {
    foreach ($kv in $r.FilePages.GetEnumerator()) {
        if (-not $fileSets.ContainsKey($kv.Key)) { $fileSets[$kv.Key] = New-Object 'System.Collections.Generic.HashSet[long]' }
        $fileSets[$kv.Key].UnionWith($kv.Value)
    }
    foreach ($kv in $r.PerFileSum.GetEnumerator()) {
        if (-not $fileSum.ContainsKey($kv.Key)) { $fileSum[$kv.Key] = 0 }
        $fileSum[$kv.Key] += $kv.Value
    }
}

$mb = 1048576.0
$wsSum = ($results | Measure-Object WorkingSet -Sum).Sum
$privSum = ($results | Measure-Object PrivateResident -Sum).Sum
$privUsageSum = ($results | Measure-Object PrivateUsage -Sum).Sum
$imgSum = ($results | Measure-Object ImageResident -Sum).Sum
$mapSum = ($results | Measure-Object MappedFileResident -Sum).Sum
$anonSum = ($results | Measure-Object AnonResident -Sum).Sum
$anonMax = ($results | Measure-Object AnonResident -Maximum).Maximum

$fileUnion = 0L
foreach ($kv in $fileSets.GetEnumerator()) { $fileUnion += $kv.Value.Count * 4096 }
# split the union back into image vs mapped-file by re-checking each file's dominant kind is not
# tracked separately; we report the combined file-backed union plus the naive sums.
$dedupLow = $privSum + $fileUnion + $anonMax
$dedupHigh = $privSum + $fileUnion + $anonSum

if ($Json) {
    [pscustomobject]@{
        processes = @($results | ForEach-Object {
            [pscustomobject]@{ pid = $_.Pid; role = $_.Role; wsMB = [math]::Round($_.WorkingSet / $mb, 1); privateMB = [math]::Round($_.PrivateResident / $mb, 1); imageMB = [math]::Round($_.ImageResident / $mb, 1); mappedFileMB = [math]::Round($_.MappedFileResident / $mb, 1); anonMB = [math]::Round($_.AnonResident / $mb, 1); error = $_.Error }
        })
        wsSumMB = [math]::Round($wsSum / $mb, 1)
        privateSumMB = [math]::Round($privSum / $mb, 1)
        imageSumMB = [math]::Round($imgSum / $mb, 1)
        mappedFileSumMB = [math]::Round($mapSum / $mb, 1)
        fileBackedUnionMB = [math]::Round($fileUnion / $mb, 1)
        anonSumMB = [math]::Round($anonSum / $mb, 1)
        anonMaxMB = [math]::Round($anonMax / $mb, 1)
        dedupedMB = @([math]::Round($dedupLow / $mb, 1), [math]::Round($dedupHigh / $mb, 1))
        topFiles = @($fileSum.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First $TopFiles | ForEach-Object {
            [pscustomobject]@{ file = $_.Key; summedMB = [math]::Round($_.Value / $mb, 1); unionMB = [math]::Round($fileSets[$_.Key].Count * 4096 / $mb, 1); processes = @($results | Where-Object { $_.FilePages.ContainsKey($_.Key) }).Count }
        })
    } | ConvertTo-Json -Depth 4
    exit 0
}

Write-Output "=== $ProcessName cluster memory accounting ==="
Write-Output ""
Write-Output ("{0,-18} {1,7} {2,9} {3,9} {4,8} {5,8} {6,8}" -f 'role', 'pid', 'WS_MB', 'privRes', 'fileImg', 'fileMap', 'anon')
foreach ($r in ($results | Sort-Object WorkingSet -Descending)) {
    if ($r.Error -ne 0) { Write-Output ("{0,-18} {1,7}  ERROR {2}" -f $r.Role, $r.Pid, $r.Error); continue }
    Write-Output ("{0,-18} {1,7} {2,9} {3,9} {4,8} {5,8} {6,8}" -f `
        $r.Role, $r.Pid, ([math]::Round($r.WorkingSet / $mb, 1)), ([math]::Round($r.PrivateResident / $mb, 1)), `
        ([math]::Round($r.ImageResident / $mb, 1)), ([math]::Round($r.MappedFileResident / $mb, 1)), ([math]::Round($r.AnonResident / $mb, 1)))
}
Write-Output ""
Write-Output ("WS sum (adds shared pages once per process) = {0} MB" -f [math]::Round($wsSum / $mb, 1))
Write-Output ("  private/resident, unique by definition   = {0} MB   (commit: {1} MB)" -f [math]::Round($privSum / $mb, 1), [math]::Round($privUsageSum / $mb, 1))
Write-Output ("  file-backed, summed                      = {0} MB" -f [math]::Round(($imgSum + $mapSum) / $mb, 1))
Write-Output ("  file-backed, UNION across processes       = {0} MB   <-- de-duplicated" -f [math]::Round($fileUnion / $mb, 1))
Write-Output ("  pagefile-backed anonymous, summed        = {0} MB   (single-process max {1} MB)" -f [math]::Round($anonSum / $mb, 1), [math]::Round($anonMax / $mb, 1))
Write-Output ""
Write-Output ("Task Manager 'Memory' column = private working set, summed = {0} MB  (commit {1} MB)" -f [math]::Round($privSum / $mb, 1), [math]::Round($privUsageSum / $mb, 1))
Write-Output ("DEDUPED PHYSICAL (est.) = {0} .. {1} MB" -f [math]::Round($dedupLow / $mb, 1), [math]::Round($dedupHigh / $mb, 1))
Write-Output ("  (= private + file union + anonymous[{0}..{1}])" -f [math]::Round($anonMax / $mb, 1), [math]::Round($anonSum / $mb, 1))
Write-Output ("  the naive WS sum overstates by ~{0} MB ({1}%)" -f [math]::Round(($wsSum - $dedupHigh) / $mb, 1), [math]::Round(($wsSum - $dedupHigh) / $wsSum * 100, 0))
Write-Output ""
Write-Output "top duplicated file-backed mappings:"
Write-Output ("{0,-34} {1,9} {2,9} {3,8} {4,7}" -f 'file', 'summed', 'union', 'dup', 'procs')
foreach ($kv in ($fileSum.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First $TopFiles)) {
    $u = $fileSets[$kv.Key].Count * 4096
    $n = @($results | Where-Object { $_.FilePages.ContainsKey($kv.Key) }).Count
    Write-Output ("{0,-34} {1,9} {2,9} {3,8} {4,7}" -f $kv.Key, [math]::Round($kv.Value / $mb, 1), [math]::Round($u / $mb, 1), [math]::Round(($kv.Value - $u) / $mb, 1), $n)
}
