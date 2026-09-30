/**
 * inputPredictionSettingsRepository — 输入预测设置持久化适配层（#448 PR2）。
 *
 * #321 决议（收敛到后端权威）实施，形状照 retentionPolicyRepository：Tauri 模式
 * 读写走 user_data typed IPC（key `input-prediction`，权威源 = SQLite）；browser
 * 模式保持 localStorage 既有路径（永续保留）。
 *
 * - 一次性迁移：后端无值 → 读旧 localStorage key（含明文 apiKey，加密存储另议）
 *   → normalize → 写穿后端；成功后旧 key **保留转影子日志**（#463，不再删除——
 *   见下）；写穿失败保留旧 key（下次启动幂等重试）。
 * - #463 前端 C-1（影子日志 + 未同步标志）：权威仍是后端，但 Tauri 模式每次保存
 *   先写影子（同一 legacy key，纯日志不作读源权威）；后端写穿失败置未同步标志。
 *   下次启动对账：标志在场且影子异于后端 → 影子较新（写穿失败不回滚本地）→
 *   影子赢入缓存并整份重发后端（跨会话自愈）；影子缺席/一致 → 清标志后端赢。
 *   没有影子时写穿失败的最新值会随进程死亡丢失（保存时有可见上报），影子让它
 *   可恢复。
 * - 同步消费面（InputBar ghost/调度）经域内缓存（inputPredictionSettingsCache）：
 *   本模块负责 hydrate 缓存与保存写穿，不做订阅广播——消费点的重算时机与
 *   「每帧直读」时代一致（依赖变化触发重算时读到最新缓存）。
 * - 保存是低频用户操作（设置面板唯一写者），链式串行盲写（expectedRevision
 *   = null，#463 起经 saveChain 按调用序落库）；失败可见上报（reportRuntimeError）
 *   并置未同步标志，缓存仍更新（内存态先行，与 identity 写穿失败的下一次全量
 *   重发自愈同语义——面板每次保存都整份重发）。
 * - 所有路径吞错不抛：hydrate 挂在 bootstrap 的 hydrateDomains 内，失败不得把
 *   启动打成 degraded（等价旧行为：localStorage 读不到 → 默认值）。
 */
import { IS_TAURI } from '../tauri/env'
import { wireErrorParts } from '../tauri/errorPayload'
import { tauriInvokeTransport } from '../acp/tauriTransport.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'
import { updateCachedInputPredictionSettings, cachedInputPredictionSettings } from '../../domains/inputPrediction/inputPredictionSettingsCache.ts'
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

/**
 * #463 前端 C-1：未同步标志。语义＝「影子（legacy key）里存在尚未成功写入后端的
 * 较新值」——后端 save 成功清除、失败置位。审查轮修正：失败一律置位（影子写
 * 失败的保存也不例外）；若彼时影子恰与后端一致，属 no-op 失败多置，下次 hydrate
 * 等值检查会自愈清除——宁可多置待自愈，不可主动清除仍有效的恢复源。
 */
const UNSYNCED_FLAG_KEY = 'pylon-input-prediction-unsynced'

function readUnsyncedFlag(): boolean {
  try { return globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY) === '1' } catch { return false }
}

function writeUnsyncedFlag(unsynced: boolean): void {
  try {
    if (unsynced) globalThis.localStorage.setItem(UNSYNCED_FLAG_KEY, '1')
    else globalThis.localStorage.removeItem(UNSYNCED_FLAG_KEY)
  } catch { /* quota：最坏退化回后端赢，等价修复前行为 */ }
}

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

/** #463：后端 save 带标志跟踪——成功清标志、失败置标志后原样上抛（上报归调用方）。 */
async function invokeUserDataSave(settings: InputPredictionSettings): Promise<void> {
  try {
    await tauriInvokeTransport('user_data_save', {
      key: BACKEND_KEY,
      payload: { version: ENVELOPE_VERSION, ...settings },
      expectedRevision: null,
    })
    writeUnsyncedFlag(false)
  } catch (error) {
    writeUnsyncedFlag(true)
    throw error
  }
}

/**
 * 启动 hydrate（挂 App.tsx hydrateDomains，Tauri-only）：
 * - 后端有值 → normalize 入缓存；
 * - 后端无值 → 旧 localStorage key 一次性迁移写穿（成功后保留转影子；失败保留
 *   旧 key 幂等重试）；
 * - 后端不可用/损坏 → localStorage 值兜底入缓存（等价旧行为）+ 可见上报。
 * 任意失败不抛（不阻断启动）。
 */
export async function hydrateInputPredictionSettingsFromBackend(): Promise<void> {
  if (!IS_TAURI) return
  try {
    const envelope = await invokeUserDataLoad()
    if (envelope && envelope.payload && typeof envelope.payload === 'object') {
      const backendSettings = asSettings(envelope.payload)
      // #463 前端 C-1：标志在场 → 影子里可能有后端没收到的较新值。影子异于后端
      // → 影子赢入缓存并整份重发后端（成功清标志自愈；失败走可见上报，标志保留）。
      if (readUnsyncedFlag()) {
        const shadow = readShadowSettings()
        if (shadow && JSON.stringify(shadow) !== JSON.stringify(backendSettings)) {
          updateCachedInputPredictionSettings(shadow)
          // 审查轮收口：重发入 saveChain 与用户保存串行；链接执行时取缓存最新值
          //（persist 同步更新缓存），启动窗口内的用户保存不会被影子旧值后到覆盖。
          saveChain = saveChain.then(
            () => invokeUserDataSave(cachedInputPredictionSettings() ?? shadow),
            () => invokeUserDataSave(cachedInputPredictionSettings() ?? shadow),
          ).catch(error => {
            const parts = wireErrorParts(error)
            reportPersistenceError('恢复输入预测设置', parts.message.length > 0 ? new Error(parts.message) : error)
          })
          await saveChain
          return
        }
        writeUnsyncedFlag(false) // 影子缺席或与后端一致：无未同步数据，后端赢
      }
      updateCachedInputPredictionSettings(backendSettings)
      writeShadowSettings(backendSettings) // 影子对齐权威（纯日志，失败无害）
      return
    }
    await migrateLegacyLocalStorage()
  } catch (error) {
    updateCachedInputPredictionSettings(loadInputPredictionSettings())
    const parts = wireErrorParts(error)
    reportPersistenceError('恢复输入预测设置', parts.message.length > 0 ? new Error(parts.message) : error)
  }
}

/** 读影子（legacy key）：缺失/损坏返回 null（损坏同迁移分支口径——不恢复垃圾）。 */
function readShadowSettings(): InputPredictionSettings | null {
  let raw: string | null
  try { raw = globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY) } catch { raw = null }
  if (raw == null) return null
  try { return normalizeInputPredictionSettings(JSON.parse(raw)) } catch { return null }
}

/** 写影子（纯日志）：quota 失败吞掉——影子缺席时对账自动退回后端赢。 */
function writeShadowSettings(settings: InputPredictionSettings): void {
  try { saveInputPredictionSettings(settings) } catch { /* 影子缺席可接受 */ }
}

/** 旧 localStorage key → 后端一次性搬家（仅当旧 key 在场；照 retention 迁移的幂等语义）。 */
async function migrateLegacyLocalStorage(): Promise<void> {
  const settings = readShadowSettings()
  if (settings == null) {
    // 全新安装 / 旧值损坏（视同无值，不迁移垃圾，原 key 保留）：默认值入缓存
    //（后续保存直写后端）
    updateCachedInputPredictionSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS })
    return
  }
  updateCachedInputPredictionSettings(settings)
  // 审查轮收口：迁移写穿入 saveChain 与用户保存串行（窗口期用户写不会被迁移值
  // 后到覆盖）；成功清标志、失败置标志均在 invokeUserDataSave 内，上报在链尾。
  // #463：迁移后旧 key 保留转影子日志（不再删除）——后端权威下次 hydrate 照常
  // 接管，影子只作写穿失败时的恢复源。
  saveChain = saveChain.then(
    () => invokeUserDataSave(settings),
    () => invokeUserDataSave(settings),
  ).catch(error => {
    // 写穿失败：缓存已入（先显示），旧 key 保留（下次启动重试迁移）
    const parts = wireErrorParts(error)
    reportPersistenceError('迁移输入预测设置到后端', parts.message.length > 0 ? new Error(parts.message) : error)
  })
  await saveChain
}

/**
 * 保存（设置面板唯一写者）：缓存立即更新（同步消费面下帧可见）+ Tauri 写穿后端 /
 * browser 写 localStorage。Tauri 模式先写影子（#463 恢复源），后端写穿经 latest-wins
 * 链式串行（#463——后端 async 命令完成序无保证，盲发并发会让旧值后到覆盖新值；
 * 链化后按调用序落库），失败可见上报并置未同步标志（影子可证较新，下次启动对账
 * 恢复重发），不回滚内存（下次保存整份重发自愈）。
 */
let saveChain: Promise<void> = Promise.resolve()

export function persistInputPredictionSettings(settings: InputPredictionSettings): void {
  const normalized = normalizeInputPredictionSettings(settings)
  updateCachedInputPredictionSettings(normalized)
  if (!IS_TAURI) {
    saveInputPredictionSettings(normalized)
    return
  }
  // 影子先行（quota 下写不进则影子保持旧值）；后端 save 的标志跟踪在
  // invokeUserDataSave 内。
  try {
    saveInputPredictionSettings(normalized)
  } catch { /* 影子缺席可接受 */ }
  saveChain = saveChain.then(
    () => invokeUserDataSave(normalized),
    () => invokeUserDataSave(normalized),
  ).catch(error => {
    // 审查轮修正：失败路径不主动清标志——invokeUserDataSave 已置位。影子写失败
    //（quota）时本次虽拿不出可证的较新值，但先前合法置位的标志（其影子仍较新）
    // 不得清除；「影子==后端的 no-op 失败」多置一次无害（hydrate 等值检查自愈清除）。
    const parts = wireErrorParts(error)
    reportPersistenceError('保存输入预测设置', parts.message.length > 0 ? new Error(parts.message) : error)
  })
}
