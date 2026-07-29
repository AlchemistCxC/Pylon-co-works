interface ModelChangeOptions {
  source: string
  nextModel: string
  previousModel?: string
  writeModel: (model: string) => void
  invokeSet: (source: string, model: string) => Promise<unknown>
}

const DEFAULT_MODEL = 'default'

function normalizeRollbackModel(previousModel?: string): string {
  return typeof previousModel === 'string' && previousModel.trim() ? previousModel : DEFAULT_MODEL
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
    writeModel(normalizeRollbackModel(previousModel))
    throw error
  }
}
