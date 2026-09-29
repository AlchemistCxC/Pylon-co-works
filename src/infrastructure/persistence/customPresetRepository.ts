/**
 * customPresetRepository — 用户自建预设的 Tauri 后端权威接线（#448 PR5，
 * #321 决议「收敛到后端权威」）。
 *
 * customPresets/zonePresetEntries 此前是 zustand persist 直连 localStorage 的
 * 「唯一无任何保障的用户资产」（无 CAS 无备份，WebView 存储被清即全丢）。现在
 * `custom-presets` user_data key 为权威：
 * - hydrate 对账（启动挂 App.tsx hydrateDomains）：后端有值且异于本地 → 以后端
 *   为准 setState（同步 guard 防回环写）；后端无值且本地非空（含刚从旧 pylon-theme
 *   搬家的数据）→ 写穿后端（一次性持久化迁移）；
 * - 写穿桥（hydrate 完成后安装）：subscribe 本地变更 → 盲写 user_data_save
 *   （latest-wins——预设变更是低频用户操作，设置面即唯一写者）；失败可见上报，
 *   本地值不回滚（下一次任意预设变更整份重发自愈）。
 * - browser 预览模式：localStorage 即权威（永续保留），本模块 no-op。
 */
import { IS_TAURI } from '../tauri/env'
import { wireErrorParts } from '../tauri/errorPayload'
import { tauriInvokeTransport } from '../acp/tauriTransport.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'
import { useCustomPresetStore } from '../../domains/theme/customPresetStore.ts'
import type { CustomPreset } from '../../domains/theme/customPresets.ts'
import type { ZonePresetEntry } from '../../domains/theme/zones/index.ts'

const BACKEND_KEY = 'custom-presets'
const ENVELOPE_VERSION = 1

interface UserDataEnvelopeWire {
  version: number
  revision: number
  payload: Record<string, unknown>
}

interface PresetSlice {
  customPresets: CustomPreset[]
  zonePresetEntries: ZonePresetEntry[]
}

const PERSISTENCE_ERROR_KEY = 'app:custom-preset-persistence'

function reportPersistenceError(action: string, error: unknown): void {
  const parts = wireErrorParts(error)
  reportRuntimeError(action, parts.message.length > 0 ? new Error(parts.message) : error, undefined, {
    key: PERSISTENCE_ERROR_KEY,
    scope: { kind: 'app', id: 'custom-presets' },
    source: 'customPreset.persistence',
  })
}

function sliceOf(state: { customPresets: CustomPreset[]; zonePresetEntries: ZonePresetEntry[] }): PresetSlice {
  return { customPresets: state.customPresets, zonePresetEntries: state.zonePresetEntries }
}

function loadFromBackend(): Promise<UserDataEnvelopeWire | null> {
  // #317 收口的共享 transport（非 direct invoke，不新增白名单豁免）
  return tauriInvokeTransport('user_data_load', { key: BACKEND_KEY }) as Promise<UserDataEnvelopeWire | null>
}

async function saveToBackend(slice: PresetSlice): Promise<void> {
  await tauriInvokeTransport('user_data_save', {
    key: BACKEND_KEY,
    payload: {
      version: ENVELOPE_VERSION,
      customPresets: slice.customPresets,
      zonePresetEntries: slice.zonePresetEntries,
    },
    expectedRevision: null,
  })
}

/** 后端 → 本地：payload 窄化（校验器已保证结构，字段级归一在 store merge/读取方）。 */
function sliceFromPayload(payload: Record<string, unknown>): PresetSlice | null {
  const presets = payload.customPresets
  const zones = payload.zonePresetEntries
  if (!Array.isArray(presets) && !Array.isArray(zones)) return null
  return {
    customPresets: Array.isArray(presets) ? presets as CustomPreset[] : [],
    zonePresetEntries: Array.isArray(zones) ? zones as ZonePresetEntry[] : [],
  }
}

/** hydrate 期间后端值落本地不触发写穿（回环防护）。 */
let syncingFromBackend = false

/** 写穿桥是否已安装（幂等）。 */
let bridgeInstalled = false

/**
 * 启动对账 + 安装写穿桥（挂 App.tsx hydrateDomains，Tauri-only）。内部吞错不抛
 * （不阻断启动，等价旧行为：localStorage 值继续可用，后端留待下次对账）。
 */
export async function hydrateCustomPresetsFromBackend(): Promise<void> {
  if (!IS_TAURI) return
  try {
    const envelope = await loadFromBackend()
    const backend = envelope && envelope.payload ? sliceFromPayload(envelope.payload) : null
    if (backend) {
      const local = sliceOf(useCustomPresetStore.getState())
      if (sameSlice(backend, local)) {
        installWriteThroughBridge()
        return
      }
      syncingFromBackend = true
      try {
        useCustomPresetStore.setState(backend)
      } finally {
        syncingFromBackend = false
      }
      installWriteThroughBridge()
      return
    }
    // 后端无值：本地非空（含旧 pylon-theme 搬家产物）→ 一次性持久化迁移写穿
    const local = sliceOf(useCustomPresetStore.getState())
    if (local.customPresets.length > 0 || local.zonePresetEntries.length > 0) {
      await saveToBackend(local)
    }
  } catch (error) {
    reportPersistenceError('恢复自定义预设', error)
  }
  installWriteThroughBridge()
}

/** 本地变更写穿桥（hydrate 完成后安装；对账落地不回写）。 */
function installWriteThroughBridge(): void {
  if (bridgeInstalled) return
  bridgeInstalled = true
  useCustomPresetStore.subscribe(state => {
    if (syncingFromBackend) return
    void saveToBackend(sliceOf(state)).catch(error => reportPersistenceError('保存自定义预设', error))
  })
}

function sameSlice(a: PresetSlice, b: PresetSlice): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
