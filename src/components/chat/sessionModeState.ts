interface ModeChangeOptions {
  source: string
  nextMode: string
  previousMode?: string
  writeMode: (mode: string) => void
  invokeSet: (source: string, mode: string) => Promise<unknown>
}

const MODE_VALUES = ['default', 'accept_edit', 'auto', 'bypass'] as const
const FALLBACK_MODE = 'default' as const

type SessionMode = typeof MODE_VALUES[number]

export function normalizeSessionMode(mode: string): SessionMode | null {
  const normalized = mode === 'edit' ? 'accept_edit' : mode
  return (MODE_VALUES as readonly string[]).includes(normalized)
    ? normalized as SessionMode
    : null
}

export function resolvePreviousSessionMode(previousMode?: string): SessionMode {
  return normalizeSessionMode(previousMode || '') || FALLBACK_MODE
}

export function nextSessionMode(currentMode: string): SessionMode {
  const normalized = normalizeSessionMode(currentMode) || FALLBACK_MODE
  const index = MODE_VALUES.indexOf(normalized)
  return MODE_VALUES[(index + 1) % MODE_VALUES.length]
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
