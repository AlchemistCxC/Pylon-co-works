/**
 * approvalMode — 全局审批模式纯域（P0-04）。
 *
 * ModeWidget 明确改为 approval mode widget：循环值限定 bypass/auto/edit/default，
 * invoke set_approval_mode（契约 §2.3，无 source 参数——全局）。运行时值存
 * runtimeStore，最近一次成功设置同时写入本地持久化边界；失败回滚显示值。session mode（plan/code）由
 * slash command/sessionMode 链消费 set_mode，本域不混用。
 */

export const APPROVAL_MODE_VALUES = ['bypass', 'auto', 'edit', 'default'] as const
export type ApprovalMode = (typeof APPROVAL_MODE_VALUES)[number]

const FALLBACK_APPROVAL_MODE: ApprovalMode = 'default'

/** 跨应用重启保留全局审批模式；仅保存枚举值，不保存任何会话/凭据。 */
export const APPROVAL_MODE_STORAGE_KEY = 'pylon-approval-mode'

type ApprovalModeStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): ApprovalModeStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
}

export function readPersistedApprovalMode(storage: ApprovalModeStorage = defaultStorage()!): ApprovalMode | null {
  if (!storage) return null
  try {
    const value = storage.getItem(APPROVAL_MODE_STORAGE_KEY)
    return value ? normalizeApprovalMode(value) : null
  } catch {
    return null
  }
}

export function persistApprovalMode(mode: ApprovalMode, storage: ApprovalModeStorage = defaultStorage()!): void {
  if (!storage) return
  try { storage.setItem(APPROVAL_MODE_STORAGE_KEY, mode) } catch { /* private/quota-restricted storage */ }
}

export function normalizeApprovalMode(mode: string): ApprovalMode | null {
  return (APPROVAL_MODE_VALUES as readonly string[]).includes(mode) ? mode as ApprovalMode : null
}

export function nextApprovalMode(current: string): ApprovalMode {
  const normalized = normalizeApprovalMode(current) || FALLBACK_APPROVAL_MODE
  const index = APPROVAL_MODE_VALUES.indexOf(normalized)
  return APPROVAL_MODE_VALUES[(index + 1) % APPROVAL_MODE_VALUES.length]
}

export interface ApprovalModeChangeOptions {
  nextMode: ApprovalMode
  previousMode: ApprovalMode
  writeMode: (mode: ApprovalMode) => void
  invokeSet: (mode: ApprovalMode) => Promise<unknown>
}

/** 先写显示值再 invoke；失败回滚显示值并抛出（错误中心由调用方处理） */
export async function applyApprovalModeChange({
  nextMode,
  previousMode,
  writeMode,
  invokeSet,
}: ApprovalModeChangeOptions): Promise<void> {
  writeMode(nextMode)
  try {
    await invokeSet(nextMode)
  } catch (error) {
    writeMode(previousMode)
    throw error
  }
}
