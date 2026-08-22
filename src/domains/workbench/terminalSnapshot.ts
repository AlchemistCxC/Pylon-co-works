/**
 * C07：content.terminal 结构化快照收窄。
 *
 * 卡面要求：terminal/log snapshot 必须区分 stdout/stderr、exitCode、status、
 * session/process identity、truncation（captured/omitted）与 error；不得把多路输出
 * 压成单一 message；killed、timeout、non-zero exit 分开；终态后迟到 chunk 按协议
 * 策略保留并标记诊断，不混入正常流计数。
 */

export interface TerminalStreamEntry {
  stream: 'stdout' | 'stderr' | string
  text: string
  ordinal?: number
  /** 协议策略：终态后到达的 chunk 保留但标记，不混入正常流。 */
  lateAfterTerminal?: boolean
}

export interface TerminalSnapshot {
  command?: string
  stdoutLines: readonly string[]
  stderrLines: readonly string[]
  /** 终态后到达的 chunk（协议保留 + 诊断元数据）。 */
  lateChunks: readonly TerminalStreamEntry[]
  exitCode?: number
  terminatedBy?: string
  status?: string
  durationMs?: number
  truncation?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 从 content.terminal part 收窄出 typed snapshot。
 * 非 terminal part 返回 null。
 */
export function terminalSnapshotFromPart(part: unknown): TerminalSnapshot | null {
  if (!isRecord(part)) return null
  if (part.kind !== 'terminal') return null

  const streamsRaw = Array.isArray(part.streams) ? part.streams : []
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  const lateChunks: TerminalStreamEntry[] = []

  for (const entry of streamsRaw) {
    if (!isRecord(entry)) continue
    const stream = typeof entry.stream === 'string' ? entry.stream : 'stdout'
    const text = typeof entry.text === 'string' ? entry.text : ''
    // C07：终态后迟到 chunk 按协议策略保留并标记，不混入正常流计数
    if (entry.lateAfterTerminal === true) {
      lateChunks.push({
        stream,
        text,
        ...(Number.isInteger(entry.ordinal) ? { ordinal: entry.ordinal as number } : {}),
        lateAfterTerminal: true,
      })
      continue
    }
    if (stream === 'stderr') {
      if (text) stderrLines.push(text)
    } else {
      if (text) stdoutLines.push(text)
    }
  }

  const toInt = (value: unknown): number | undefined =>
    Number.isInteger(value) ? value as number : undefined

  return {
    ...(typeof part.command === 'string' ? { command: part.command } : {}),
    stdoutLines,
    stderrLines,
    ...(lateChunks.length > 0 ? { lateChunks } : { lateChunks }),
    ...(toInt(part.exitCode) !== undefined ? { exitCode: toInt(part.exitCode) } : {}),
    ...(typeof part.terminatedBy === 'string' ? { terminatedBy: part.terminatedBy } : {}),
    ...(typeof part.status === 'string' ? { status: part.status } : {}),
    ...(toInt(part.durationMs) !== undefined ? { durationMs: toInt(part.durationMs) } : {}),
    ...(part.truncation !== undefined ? { truncation: part.truncation } : {}),
  }
}
