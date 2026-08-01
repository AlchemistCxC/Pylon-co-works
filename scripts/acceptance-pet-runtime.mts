import { execFileSync } from 'node:child_process'

interface RuntimeProbe {
  processName: string
  pid: number
  title: string
}

function probePylon(): RuntimeProbe[] {
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-Process pylon -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress',
    ], { encoding: 'utf8' }).trim()
    if (!output) return []
    const value: unknown = JSON.parse(output)
    const rows = Array.isArray(value) ? value : [value]
    return rows.map((row: any) => ({
      processName: String(row.ProcessName ?? ''),
      pid: Number(row.Id),
      title: String(row.MainWindowTitle ?? ''),
    }))
  } catch {
    return []
  }
}

const probes = probePylon()
const evidence = {
  task: 'G-04/G-05',
  command: 'npm run tauri dev',
  process: probes,
  runtimeEntered: probes.length > 0,
  invokeEvidence: false,
  eventEvidence: false,
  localStorageEvidence: false,
  conclusion: probes.length > 0 ? '需要人工窗口验收' : 'blocked: 当前没有运行中的 Pylon Tauri 进程',
}

console.log(JSON.stringify(evidence, null, 2))
process.exitCode = probes.length > 0 ? 0 : 2
