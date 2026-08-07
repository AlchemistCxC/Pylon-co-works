/**
 * 配置导出/导入：把应用配置整体备份为 JSON，可在本机迁移或分享。
 *
 * 覆盖的持久化 key：主题（pylon-theme）、工作区 sheets（pylon-workspace-sheets）、
 * 窗口尺寸（pylon-window-size）、会话（pylon-sessions）、Profile（pylon-profiles，
 * FE-AUD-002）。
 * 其他 key（pylon-pet-v3、pylon-msgs-* 等运行态）不导出。
 */

export const CONFIG_ENVELOPE_APP = 'pylon'
export const CONFIG_ENVELOPE_VERSION = 1

export const CONFIG_STORAGE_KEYS = [
  'pylon-theme',
  'pylon-workspace-sheets',
  'pylon-window-size',
  'pylon-sessions',
  'pylon-profiles',
] as const

export interface ConfigEnvelope {
  app: typeof CONFIG_ENVELOPE_APP
  version: number
  exportedAt: string
  data: Record<string, string>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function buildExportPayload(storage: StorageLike): string {
  const data: Record<string, string> = {}
  for (const key of CONFIG_STORAGE_KEYS) {
    const raw = storage.getItem(key)
    if (raw !== null) data[key] = raw
  }
  const envelope: ConfigEnvelope = {
    app: CONFIG_ENVELOPE_APP,
    version: CONFIG_ENVELOPE_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }
  return JSON.stringify(envelope, null, 2)
}

export type ImportResult = { ok: true; keys: string[] } | { ok: false; error: string }

/** 全量预检（报告 1B.7）：parse envelope + key 白名单 + 值校验，收集 data 但不写盘 */
export type ImportPreflight = { ok: true; data: Record<string, string>; keys: string[] } | { ok: false; error: string }

export function preflightImportPayload(json: string): ImportPreflight {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: '不是有效的 JSON' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: '配置格式无效' }
  const envelope = parsed as Partial<ConfigEnvelope>
  if (envelope.app !== CONFIG_ENVELOPE_APP || envelope.version !== CONFIG_ENVELOPE_VERSION) {
    return { ok: false, error: '不是 Pylon 配置文件，或版本不受支持' }
  }
  const data = envelope.data
  if (!data || typeof data !== 'object') return { ok: false, error: '配置内容缺失' }
  // key 白名单：只接受 CONFIG_STORAGE_KEYS（导出对等集合），
  // 防恶意/损坏文件注入任意 localStorage key（如 pylon-msgs-* 运行态）
  const allowed = new Set<string>(CONFIG_STORAGE_KEYS)
  const collected: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    if (allowed.has(key) && typeof value === 'string') collected[key] = value
  }
  const keys = Object.keys(collected)
  if (keys.length === 0) return { ok: false, error: '没有可导入的配置项' }
  return { ok: true, data: collected, keys }
}

/** 旧语义入口（保留兼容）：逐 key 写，单个失败跳过——F17 事务用 preflight + 全量写 + 回滚 */
export function applyImportPayload(storage: StorageLike, json: string): ImportResult {
  const preflight = preflightImportPayload(json)
  if (!preflight.ok) return { ok: false, error: preflight.error }
  for (const [key, value] of Object.entries(preflight.data)) {
    try {
      storage.setItem(key, value)
    } catch {
      // 单个 key 写入失败不阻断其余
    }
  }
  return { ok: true, keys: preflight.keys }
}

export function configFileName(): string {
  const today = new Date().toISOString().slice(0, 10)
  return `pylon-config-${today}.json`
}
