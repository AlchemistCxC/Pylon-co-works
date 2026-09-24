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
    await invokeSet(source, nextMode)
  } catch (error) {
    writeMode(resolvePreviousSessionMode(previousMode))
    throw error
  }
}
