/**
 * 消息历史保留策略设置契约（I13-A-FE-02）。
 *
 * 契约来源：ISSUE-13 D-03（工作区/数据管理设置页提供永久/按时间/按每 Session
 * 数量保留）、ISSUE-06 D-15（默认永久保存，字段缺失/解析失败回退永久保存，
 * 用户选择非永久策略必须显示预计影响，保存策略不等于立即清理）。
 *
 * 档位/默认值**单源在 Rust**（src-tauri/pylon-session/src/retention.rs），
 * 由 `scripts/generate-retention-policy.mjs` 生成到
 * `historyRetentionPolicy.contract.ts`，本文件只引入再导出并承担读取/校验/
 * 影响提示逻辑（#331/U3 裁决；`check:retention-policy` 门禁守同步）。
 * - 默认模式：permanent；任何非法输入一律回退 permanent，禁止因默认值变化
 *   自动删除历史（D-15）。
 *
 * 本模块只负责策略的读取/校验/影响提示，**不包含任何删除路径**；实际删除由
 * Rust 消息仓库在事务边界安全调度（D-11/D-15）。
 */

import {
  DEFAULT_COUNT_LIMIT,
  DEFAULT_TIME_DAYS,
  RETENTION_COUNT_LIMITS,
  RETENTION_TIME_DAYS,
} from './historyRetentionPolicy.contract'

export {
  DEFAULT_COUNT_LIMIT,
  DEFAULT_TIME_DAYS,
  RETENTION_COUNT_LIMITS,
  RETENTION_TIME_DAYS,
}

export type RetentionMode = 'permanent' | 'by_time' | 'by_count'

export interface RetentionPolicy {
  mode: RetentionMode
  /** by_time 档位（天），仅在 mode === 'by_time' 时有效 */
  days?: number
  /** by_count 档位（每 Session 保留的 canonical 事件条数），仅在 mode === 'by_count' 时有效 */
  count?: number
}

/** D-15 默认：永久保存（不执行自动清理）。 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { mode: 'permanent' }

/** 独立 localStorage key（非主题 envelope，与 showPet 持久化模式一致）。 */
export const RETENTION_STORAGE_KEY = 'pylon-history-retention'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface RetentionImpact {
  kind: 'warn'
  text: string
}

export const RETENTION_MODE_OPTIONS: { value: RetentionMode; label: string }[] = [
  { value: 'permanent', label: '永久保存' },
  { value: 'by_time', label: '按时间保留' },
  { value: 'by_count', label: '按每个 Session 事件数量保留' },
]

/** 校验策略是否满足实施契约（与 Rust 侧 is_valid 同语义）。 */
export function isRetentionPolicyValid(policy: RetentionPolicy): boolean {
  switch (policy.mode) {
    case 'permanent':
      return true
    case 'by_time':
      return RETENTION_TIME_DAYS.includes(policy.days as (typeof RETENTION_TIME_DAYS)[number])
    case 'by_count':
      return RETENTION_COUNT_LIMITS.includes(policy.count as (typeof RETENTION_COUNT_LIMITS)[number])
    default:
      return false
  }
}

/** 从存储读取策略；任何非法输入一律回退永久保存（D-15）。 */
export function readRetentionPolicy(storage: StorageLike): RetentionPolicy {
  try {
    const raw = storage.getItem(RETENTION_STORAGE_KEY)
    if (raw == null) return DEFAULT_RETENTION_POLICY
    const parsed = JSON.parse(raw) as Partial<RetentionPolicy>
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_RETENTION_POLICY
    const policy = { mode: parsed.mode, days: parsed.days, count: parsed.count } as RetentionPolicy
    return isRetentionPolicyValid(policy) ? policy : DEFAULT_RETENTION_POLICY
  } catch {
    return DEFAULT_RETENTION_POLICY
  }
}

/** 只写策略（设置页唯一写入入口；不触发任何删除）。 */
export function writeRetentionPolicy(storage: StorageLike, policy: RetentionPolicy): void {
  try {
    storage.setItem(RETENTION_STORAGE_KEY, JSON.stringify(policy))
  } catch {
    // 存储不可用：静默（本次修改仅在内存态生效，下次启动回退默认）
  }
}

/** 非永久策略必须显示的影响提示（D-15）；permanent 返回 null（无影响）。 */
export function retentionPolicyImpact(policy: RetentionPolicy): RetentionImpact | null {
  if (policy.mode === 'by_time') {
    const days = policy.days ?? DEFAULT_TIME_DAYS
    return {
      kind: 'warn',
      text: `预计影响：启用后将自动清理超过 ${days} 天的历史事件。保存策略不会立即删除任何事件，自动清理由后端在事务边界安全执行。`,
    }
  }
  if (policy.mode === 'by_count') {
    const count = policy.count ?? DEFAULT_COUNT_LIMIT
    return {
      kind: 'warn',
      text: `预计影响：启用后每个会话仅保留最近 ${count} 条 canonical 事件，更早事件将被自动清理。保存策略不会立即删除任何事件，自动清理由后端在事务边界安全执行。`,
    }
  }
  return null
}
