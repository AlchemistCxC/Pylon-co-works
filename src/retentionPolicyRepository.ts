/**
 * retentionPolicyRepository — 保留策略存储适配层（ISSUE-13 W3，T13-3）。
 *
 * 移除 Tauri 模式 localStorage-only 真值：Tauri 模式读写走后端 typed IPC
 * （retention_policy_get/set，权威源 = MsgRepo retention_policy 表，含 version +
 * revision）；browser 模式（无后端）保持 localStorage 既有路径。
 *
 * - 损坏回退 permanent 时返回 warning，不静默覆盖（D-15：后端 payload 解析失败/
 *   越档 → 临时回退永久保存 + corruptWarning 提示，不把回退值写回后端）；
 * - 写路径带 expectedRevision（乐观并发，旧写不覆盖新写）——conflict 由调用方
 *   按 code "retention_revision_conflict" 分支（重读 + 提示）。
 */

import { IS_TAURI } from './infrastructure/tauri/env'
import { invoke } from '@tauri-apps/api/core'
import {
  DEFAULT_RETENTION_POLICY,
  RETENTION_STORAGE_KEY,
  isRetentionPolicyValid,
  readRetentionPolicy,
  writeRetentionPolicy,
  type RetentionPolicy,
  type StorageLike,
} from './components/settings/historyRetentionPolicy'

/** 后端 retention_policy 行（MsgRepo RetentionPolicyRow 的 camelCase wire 形状）。 */
export interface BackendRetentionPolicyRow {
  version: number
  revision: number
  payload: string
}

export type RetentionPolicySource = 'backend' | 'local'

export interface RetentionPolicySnapshot {
  policy: RetentionPolicy
  /** 后端 revision（乐观并发基准）；browser 模式无 revision → null */
  revision: number | null
  source: RetentionPolicySource
  /** 后端 payload 损坏回退 permanent 的警告（D-15：不静默覆盖）；null = 无 */
  corruptWarning: string | null
}

export class RetentionPolicyLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetentionPolicyLoadError'
  }
}

export function retentionErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code)
  }
  return undefined
}

/** Tauri invoke 拒绝值为 { code, message } 对象（非 Error）——提取 message 供展示（CR-001）。 */
export function retentionErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/** 读取策略快照：Tauri → 后端权威；browser → localStorage。后端不可用抛 LoadError。 */
export async function loadRetentionPolicy(storage: StorageLike): Promise<RetentionPolicySnapshot> {
  if (!IS_TAURI) {
    return { policy: readRetentionPolicy(storage), revision: null, source: 'local', corruptWarning: null }
  }
  let row: BackendRetentionPolicyRow | null
  try {
    row = await invoke<BackendRetentionPolicyRow | null>('retention_policy_get')
  } catch (error) {
    throw new RetentionPolicyLoadError(`读取保留策略失败：${retentionErrorMessage(error)}`)
  }
  if (row == null) {
    // 后端无策略行 → D-15 默认永久保存（不落库，等用户显式保存）
    return { policy: DEFAULT_RETENTION_POLICY, revision: null, source: 'backend', corruptWarning: null }
  }
  try {
    const parsed = JSON.parse(row.payload) as Partial<RetentionPolicy>
    const policy: RetentionPolicy = { mode: parsed.mode, days: parsed.days, count: parsed.count } as RetentionPolicy
    if (!isRetentionPolicyValid(policy)) {
      return {
        policy: DEFAULT_RETENTION_POLICY,
        revision: row.revision,
        source: 'backend',
        corruptWarning: '后端存储的保留策略不可用，已临时回退永久保存（未覆盖原值）',
      }
    }
    return { policy, revision: row.revision, source: 'backend', corruptWarning: null }
  } catch {
    return {
      policy: DEFAULT_RETENTION_POLICY,
      revision: row.revision,
      source: 'backend',
      corruptWarning: '后端存储的保留策略损坏，已临时回退永久保存（未覆盖原值）',
    }
  }
}

/**
 * 保存策略：Tauri → retention_policy_set（expectedRevision 乐观并发）；browser →
 * localStorage。返回新 revision（backend）/ null（local）。conflict 等错误向上抛
 * （调用方按 retentionErrorCode 分支）。
 */
export async function saveRetentionPolicy(
  storage: StorageLike,
  policy: RetentionPolicy,
  expectedRevision: number | null,
): Promise<number | null> {
  if (!IS_TAURI) {
    writeRetentionPolicy(storage, policy)
    return null
  }
  // CR-002：无行首写（revision=null）以 expected 0 落库——若并发已写入则冲突重读，
  // 不盲写覆盖
  return invoke<number>('retention_policy_set', {
    json: JSON.stringify(policy),
    expectedRevision: expectedRevision ?? 0,
  })
}

/** I13-W4：清理 preview/prune 结果（RetentionPreview camelCase wire 形状）。 */
export interface RetentionPreview {
  totalCandidates: number
  affectedSessions: number
  /** by_time：最早将被删除的 cutoff（毫秒）；by_count/permanent：null */
  oldestDeletedAt: number | null
  perSession: { sessionId: string; count: number }[]
}

/**
 * I13-W6：导出用——读取后端保留策略原始 payload（Tauri）；browser 返回 null。
 * 与 loadRetentionPolicy 不同：返回原始串（导出忠实保留存储值，不回退/不解析）。
 */
export async function loadRetentionPolicyPayload(): Promise<string | null> {
  if (!IS_TAURI) return null
  const row = await invoke<BackendRetentionPolicyRow | null>('retention_policy_get')
  return row?.payload ?? null
}

/**
 * I13-W6：导入用盲写——无条件覆盖后端策略（expectedRevision=null，不校验当前 revision）。
 * 配置导入语义为「覆盖」，与常规保存的乐观并发（expected 校验）区分。
 */
export async function overwriteRetentionPolicy(policy: RetentionPolicy): Promise<number> {
  if (!IS_TAURI) throw new Error('写后端保留策略需要 Tauri 后端')
  return invoke<number>('retention_policy_set', { json: JSON.stringify(policy), expectedRevision: null })
}

/**
 * I13-W6 CR-001：导入后写穿后端权威——仅当导入 payload **确含**保留策略 key 时执行
 * （按事务返回的 importedKeys 门控）。防止 localStorage 残留旧值在「导入不含策略 key 的
 * 配置」时盲写覆盖用户在后端已修改的策略。
 */
export async function syncImportedRetentionPolicy(
  storage: StorageLike,
  importedKeys: readonly string[],
): Promise<void> {
  if (!IS_TAURI) return
  if (!importedKeys.includes(RETENTION_STORAGE_KEY)) return
  const raw = storage.getItem(RETENTION_STORAGE_KEY)
  if (raw == null) return
  await overwriteRetentionPolicy(readRetentionPolicy(storage))
}

/** I13-W4：preview 统计将删除的候选（不执行删除）。仅 Tauri 后端支持。 */
export async function previewRetentionPolicy(policy: RetentionPolicy): Promise<RetentionPreview> {
  if (!IS_TAURI) throw new Error('清理预览需要 Tauri 后端')
  return invoke<RetentionPreview>('retention_preview', { policy })
}

/**
 * I13-W4：prune 事务内执行清理（与 preview 同一筛选），返回实际删除结果。
 * expectedPolicyRevision 与策略行当前 revision 不匹配 → retention_stale_preview
 * （预览后策略被改，拒绝按旧统计执行清理）。
 */
export async function pruneRetentionPolicy(
  policy: RetentionPolicy,
  expectedPolicyRevision: number | null,
): Promise<RetentionPreview> {
  if (!IS_TAURI) throw new Error('立即清理需要 Tauri 后端')
  return invoke<RetentionPreview>('retention_prune', { policy, expectedPolicyRevision })
}
