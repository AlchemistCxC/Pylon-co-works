import { extractModelConfig, sessionResponseObject, type ModelChoice } from '../../infrastructure/acp/chatContracts.ts'

interface ModelChangeOptions {
  source: string
  nextModel: string
  previousModel?: string
  writeModel: (model: string) => void
  /** P56/D3：权威回声覆盖写入口（响应可提取出新 model/choices 时调用）。 */
  applyResponseConfig?: (config: { model?: string; modelChoices?: ModelChoice[] }) => void
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
  applyResponseConfig,
  invokeSet,
}: ModelChangeOptions): Promise<void> {
  writeModel(nextModel)
  try {
    const response = await invokeSet(source, nextModel)
    // P56/D3：凡切换响应给出权威状态（可提取出新 model 或宣告 choices）即覆盖乐观
    // 值；hermes 空回声场景（set_model 空响应 / set_config_option 恒空 configOptions）
    // 无可提取 → 乐观值保留（评估 §8.5：乐观值 + 下次 new/load 对齐）。
    if (applyResponseConfig) {
      const normalized = sessionResponseObject(response)
      const cfg = extractModelConfig(normalized.configOptions, normalized)
      if (cfg.model || cfg.modelChoices) {
        applyResponseConfig({
          ...(cfg.model ? { model: cfg.model } : {}),
          ...(cfg.modelChoices ? { modelChoices: cfg.modelChoices } : {}),
        })
      }
    }
  } catch (error) {
    writeModel(normalizeRollbackModel(previousModel))
    throw error
  }
}
