/**
 * inputPredictionSettingsRepository — 输入预测设置持久化适配层（#448 PR2）。
 *
 * #321 决议（收敛到后端权威）实施，形状照 retentionPolicyRepository：Tauri 模式
 * 读写走 user_data typed IPC（key `input-prediction`，权威源 = SQLite）；browser
 * 模式保持 localStorage 既有路径（永续保留）。
 *
 * - 一次性迁移：后端无值 → 读旧 localStorage key（含明文 apiKey，加密存储另议）
 *   → normalize → 写穿后端 → **删旧 key**；写穿失败保留旧 key（下次启动幂等重试）。
 * - 同步消费面（InputBar ghost/调度）经域内缓存（inputPredictionSettingsCache）：
 *   本模块负责 hydrate 缓存与保存写穿，不做订阅广播——消费点的重算时机与
 *   「每帧直读」时代一致（依赖变化触发重算时读到最新缓存）。
 * - 保存是低频用户操作（设置面板唯一写者），盲写 latest-wins（expectedRevision
 *   = null）；失败可见上报（reportRuntimeError），缓存仍更新（内存态先行，
 *   与 identity 写穿失败的下一次全量重发自愈同语义——面板每次保存都整份重发）。
 * - 所有路径吞错不抛：hydrate 挂在 bootstrap 的 hydrateDomains 内，失败不得把
 *   启动打成 degraded（等价旧行为：localStorage 读不到 → 默认值）。
 */
import { IS_TAURI } from '../tauri/env'
import { wireErrorParts } from '../tauri/errorPayload'
import { tauriInvokeTransport } from '../acp/tauriTransport.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'
import { updateCachedInputPredictionSettings } from '../../domains/inputPrediction/inputPredictionSettingsCache.ts'
import {
  DEFAULT_INPUT_PREDICTION_SETTINGS,
  INPUT_PREDICTION_SETTINGS_KEY,
  loadInputPredictionSettings,
  normalizeInputPredictionSettings,
  saveInputPredictionSettings,
  type InputPredictionSettings,
} from '../../domains/inputPrediction/inputPredictionSettings.ts'

/** 后端 user_data key（UserDataKey::InputPrediction 的 wire 拼写）。 */
const BACKEND_KEY = 'input-prediction'

/** 后端 envelope 版本（validate_input_prediction 只接受 1）。 */
const ENVELOPE_VERSION = 1

/** user_data_load 的 wire 形状（后端 UserDataEnvelope camelCase）。 */
interface UserDataEnvelopeWire {
  version: number
  revision: number
  payload: Record<string, unknown>
}

const PERSISTENCE_ERROR_KEY = 'app:input-prediction-persistence'

function reportPersistenceError(action: string, error: unknown): void {
  reportRuntimeError(action, error, undefined, {
    key: PERSISTENCE_ERROR_KEY,
    scope: { kind: 'app', id: 'input-prediction' },
    source: 'prediction.persistence',
  })
}

function asSettings(payload: Record<string, unknown>): InputPredictionSettings {
  return normalizeInputPredictionSettings(payload)
}

function invokeUserDataLoad(): Promise<UserDataEnvelopeWire | null> {
  // #317 收口的共享 transport（非 direct invoke，不新增白名单豁免）
  return tauriInvokeTransport('user_data_load', { key: BACKEND_KEY }) as Promise<UserDataEnvelopeWire | null>
}

async function invokeUserDataSave(settings: InputPredictionSettings): Promise<void> {
  await tauriInvokeTransport('user_data_save', {
    key: BACKEND_KEY,
    payload: { version: ENVELOPE_VERSION, ...settings },
    expectedRevision: null,
  })
}

/**
 * 启动 hydrate（挂 App.tsx hydrateDomains，Tauri-only）：
 * - 后端有值 → normalize 入缓存；
 * - 后端无值 → 旧 localStorage key 一次性迁移（写穿 + 删旧；失败保留旧 key 幂等重试）；
 * - 后端不可用/损坏 → localStorage 值兜底入缓存（等价旧行为）+ 可见上报。
 * 任意失败不抛（不阻断启动）。
 */
export async function hydrateInputPredictionSettingsFromBackend(): Promise<void> {
  if (!IS_TAURI) return
  try {
    const envelope = await invokeUserDataLoad()
    if (envelope && envelope.payload && typeof envelope.payload === 'object') {
      updateCachedInputPredictionSettings(asSettings(envelope.payload))
      return
    }
    await migrateLegacyLocalStorage()
  } catch (error) {
    updateCachedInputPredictionSettings(loadInputPredictionSettings())
    const parts = wireErrorParts(error)
    reportPersistenceError('恢复输入预测设置', parts.message.length > 0 ? new Error(parts.message) : error)
  }
}

/** 旧 localStorage key → 后端一次性搬家（仅当旧 key 在场；照 retention 迁移的幂等语义）。 */
async function migrateLegacyLocalStorage(): Promise<void> {
  let raw: string | null
  try { raw = globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY) } catch { raw = null }
  if (raw == null) {
    // 全新安装：后端与本地都无值 → 默认值入缓存（后续保存直写后端）
    updateCachedInputPredictionSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS })
    return
  }
  let settings: InputPredictionSettings
  try { settings = normalizeInputPredictionSettings(JSON.parse(raw)) } catch {
    // 旧值损坏：视同无值，不迁移垃圾（默认值兜底），旧 key 原样保留供人工排查
    updateCachedInputPredictionSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS })
    return
  }
  updateCachedInputPredictionSettings(settings)
  try {
    await invokeUserDataSave(settings)
    try { globalThis.localStorage.removeItem(INPUT_PREDICTION_SETTINGS_KEY) } catch { /* 删旧失败无害：下次 hydrate 仍走迁移分支并幂等覆盖 */ }
  } catch (error) {
    // 写穿失败：缓存已入（先显示），旧 key 保留（下次启动重试迁移）
    const parts = wireErrorParts(error)
    reportPersistenceError('迁移输入预测设置到后端', parts.message.length > 0 ? new Error(parts.message) : error)
  }
}

/**
 * 保存（设置面板唯一写者）：缓存立即更新（同步消费面下帧可见）+ Tauri 写穿后端 /
 * browser 写 localStorage。后端写穿失败可见上报，不回滚内存（下次保存整份重发自愈）。
 */
export function persistInputPredictionSettings(settings: InputPredictionSettings): void {
  const normalized = normalizeInputPredictionSettings(settings)
  updateCachedInputPredictionSettings(normalized)
  if (!IS_TAURI) {
    saveInputPredictionSettings(normalized)
    return
  }
  void invokeUserDataSave(normalized).catch(error => {
    const parts = wireErrorParts(error)
    reportPersistenceError('保存输入预测设置', parts.message.length > 0 ? new Error(parts.message) : error)
  })
}
