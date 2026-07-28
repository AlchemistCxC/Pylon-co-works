interface ModeChangeOptions {
  source: string
  nextMode: string
  previousMode?: string
  writeMode: (mode?: string) => void
  invokeSet: (source: string, mode: string) => Promise<unknown>
}

const SESSION_MODES = ['default', 'accept_edit', 'auto', 'bypass'] as const

export function nextSessionMode(currentMode: string): typeof SESSION_MODES[number] {
  const normalized = currentMode === 'edit' ? 'accept_edit' : currentMode
  const index = SESSION_MODES.indexOf(normalized as typeof SESSION_MODES[number])
  return SESSION_MODES[(index + 1) % SESSION_MODES.length]
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
    writeMode(previousMode)
    throw error
  }
}
