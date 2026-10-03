import { extractMode, sessionResponseObject } from '../../infrastructure/acp/chatContracts.ts'

interface ModeChangeOptions {
  source: string
  nextMode: string
  previousMode?: string
  writeMode: (mode: string) => void
  invokeSet: (source: string, mode: string) => Promise<unknown>
}

const FALLBACK_MODE = 'default' as const

type SessionMode = string

export function normalizeSessionMode(mode: string): SessionMode | null {
  // ACP mode IDs are opaque, advertised by the agent; never translate them.
  return typeof mode === 'string' && mode.trim() ? mode : null
}

export function resolvePreviousSessionMode(previousMode?: string): SessionMode {
  return normalizeSessionMode(previousMode || '') || FALLBACK_MODE
}

export async function applySessionModeChange({
  source,
  nextMode,
  previousMode,
  writeMode,
  invokeSet,
}: ModeChangeOptions): Promise<void> {
  writeMode(nextMode)
  try {
    const response = await invokeSet(source, nextMode)
    // #531：回包给出权威 currentModeId 即**以回包为准**（覆盖乐观值）——与
    // `sessionModelState` 的 P56/D3 同口径；空回声（提取不到）保留乐观值。
    // 「等待 Agent 确认」这类提示在本入口没有展示面，边界记在 issue #531。
    const authoritative = extractMode(sessionResponseObject(response))
    if (authoritative && authoritative !== nextMode) writeMode(authoritative)
  } catch (error) {
    writeMode(resolvePreviousSessionMode(previousMode))
    throw error
  }
}
