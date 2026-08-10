/**
 * 消息历史保留策略设置契约（I13-A-FE-02）。
 *
 * 契约来源：ISSUE-13 D-03（工作区/数据管理设置页提供永久/按时间/按每 Session
 * 数量保留）、ISSUE-06 D-15（默认永久保存，字段缺失/解析失败回退永久保存，
 * 用户选择非永久策略必须显示预计影响，保存策略不等于立即清理）。
 *
 * 与后端实施契约（src-tauri/src/session/retention.rs）保持档位/默认值一致：
 * - by_time 档位（天）：[7, 30, 90, 180, 365]，默认 30
 * - by_count 档位（条）：[100, 500, 1000, 5000, 10000]，默认 1000
 * - 默认模式：permanent；任何非法输入一律回退 permanent，禁止因默认值变化
 *   自动删除历史（D-15）。
 *
 * 本模块只负责策略的读取/校验/影响提示，**不包含任何删除路径**；实际删除由
 * Rust 消息仓库在事务边界安全调度（D-11/D-15）。
 */

export type RetentionMode = 'permanent' | 'by_time' | 'by_count'

export interface RetentionPolicy {
  mode: RetentionMode
  /** by_time 档位（天），仅在 mode === 'by_time' 时有效 */
  days?: number
  /** by_count 档位（每 Session 消息条数），仅在 mode === 'by_count' 时有效 */
  count?: number
}

/** 按时间保留的档位（天）。档位即契约：越档值视为非法 → 回退永久保存。 */
export const RETENTION_TIME_DAYS = [7, 30, 90, 180, 365] as const
/** 按数量保留的档位（每 Session 消息条数）。 */
export const RETENTION_COUNT_LIMITS = [100, 500, 1000, 5000, 10000] as const
/** 选择按时间保留时的默认档位（天）。 */
export const DEFAULT_TIME_DAYS = 30
/** 选择按数量保留时的默认档位（条）。 */
export const DEFAULT_COUNT_LIMIT = 1000

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
  { value: 'by_count', label: '按每个 Session 消息数量保留' },
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
      text: `预计影响：启用后将自动清理超过 ${days} 天的历史消息。保存策略不会立即删除任何消息，自动清理由后端在事务边界安全执行。`,
    }
  }
  if (policy.mode === 'by_count') {
    const count = policy.count ?? DEFAULT_COUNT_LIMIT
    return {
      kind: 'warn',
      text: `预计影响：启用后每个会话仅保留最近 ${count} 条消息，更早消息将被自动清理。保存策略不会立即删除任何消息，自动清理由后端在事务边界安全执行。`,
    }
  }
  return null
}
