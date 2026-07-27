interface ModeChangeOptions {
  source: string
  nextMode: string
  previousMode?: string
  writeMode: (mode?: string) => void
  invokeSet: (source: string, mode: string) => Promise<unknown>
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
