interface ModelChangeOptions {
  source: string
  nextModel: string
  previousModel?: string
  writeModel: (model?: string) => void
  invokeSet: (source: string, model: string) => Promise<unknown>
}

export async function applySessionModelChange({
  source,
  nextModel,
  previousModel,
  writeModel,
  invokeSet,
}: ModelChangeOptions): Promise<void> {
  writeModel(nextModel)
  try {
    await invokeSet(source, nextModel)
  } catch (error) {
    writeModel(previousModel)
    throw error
  }
}
