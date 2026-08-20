/**
 * importConfigurationTransaction — 配置导入事务（报告阶段 3.6 / 1B.7-1B.8）。
 *
 * 预检（全量 parse + 白名单，不写盘）→ 备份现有白名单 key → 一次性写入 →
 * 统一 rehydrate（profiles/sessions/workspace，不允许多组件各自 reload）→
 * 失败回滚恢复旧值。返回导入成功的 key 列表。
 */
import { CONFIG_STORAGE_KEYS, type ImportPreflight } from '../../configExportImport'
import type { TransactionResult } from './transactionResult'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ImportConfigurationDeps {
  storage: StorageLike
  preflight: (json: string) => ImportPreflight
  rehydrate: () => void
  reportError: (action: string, error: unknown) => void
}

export async function importConfigurationTransaction(
  json: string,
  deps: ImportConfigurationDeps,
): Promise<TransactionResult<string[]>> {
  const preflight = deps.preflight(json)
  if (!preflight.ok) return { ok: false, kind: 'validation', message: preflight.error }

  // 备份现有白名单 key
  const backup: Record<string, string> = {}
  for (const key of CONFIG_STORAGE_KEYS) {
    const raw = deps.storage.getItem(key)
    if (raw !== null) backup[key] = raw
  }

  // 一次性写入（预检已全量通过）
  let writeError: unknown = null
  for (const [key, value] of Object.entries(preflight.data)) {
    try {
      deps.storage.setItem(key, value)
    } catch (error) {
      writeError = error
      break
    }
  }
  if (writeError !== null) {
    rollback(deps.storage, preflight.data, backup)
    deps.reportError('导入配置', writeError)
    return { ok: false, kind: 'transport', message: '配置写入失败，已回滚', cause: writeError }
  }

  // 统一 rehydrate（不允许多个组件各自 reload）
  try {
    deps.rehydrate()
  } catch (error) {
    deps.reportError('导入配置', error)
    return { ok: false, kind: 'mismatch', message: '配置已写入但刷新状态失败', cause: error }
  }
  return { ok: true, value: preflight.keys }
}

function rollback(storage: StorageLike, attempted: Record<string, string>, backup: Record<string, string>): void {
  for (const [key, value] of Object.entries(backup)) {
    try {
      storage.setItem(key, value)
    } catch {
      // 回滚尽力而为
    }
  }
  for (const key of Object.keys(attempted)) {
    if (!(key in backup)) {
      try {
        storage.removeItem(key)
      } catch {
        // 回滚尽力而为
      }
    }
  }
}
