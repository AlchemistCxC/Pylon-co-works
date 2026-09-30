/**
 * approvalModeRestore — 启动恢复事务（#448 PR4，#321 决议「收敛到后端权威」）。
 *
 * 顺序反转（对照旧语义「本地有值即推送」）：
 * 1. 读后端持久层（user_data approval-mode 行；启动时 lib.rs 阶段 10b 已把该值
 *    回填后端内存态）→ 在场 → 应用为 UI 权威值；
 * 2. 后端从未存过（null）→ 本地 localStorage **首次种子**：应用本地值并写穿后端
 *    （set_approval_mode 自带落盘）。种子只发生一次——成功后下次启动走 1；
 * 3. 后端不可用 → 降级显示本地最近值（不推送——推送同样不可达），可见上报。
 *
 * 旧「推送」分支移除后，CLI 桥等不经 webview 的 set 不再被前端旧值在重启后
 * 静默覆盖（#321 确认的漂移路径）。本地 key 降级为缓存：只在 2 中读、在 apply
 * 中镜像维护，不再参与决策。IO 全注入（App.tsx 只接线），可脱离组件做确定性行为测试。
 */
import { normalizeApprovalMode, type ApprovalMode } from './approvalMode.ts'

export interface ApprovalModeRestoreDeps {
  /** 读后端持久层行（user_data_load approval-mode）；resolve null = 从未存过。 */
  loadPersisted: () => Promise<unknown>
  /** 首次种子：写后端（set_approval_mode，后端自写穿 user_data）。 */
  seedToBackend: (mode: ApprovalMode) => Promise<unknown>
  /** 读本地 localStorage 缓存值（降级数据源）。 */
  readLocal: () => ApprovalMode | null
  /** 应用后端权威/种子值到 UI（含本地镜像维护）。 */
  apply: (mode: ApprovalMode) => void
  /** 降级分支应用本地值（仅 UI 显示，不提示恢复成功）。 */
  applyLocalFallback: (mode: ApprovalMode) => void
  /** 失败可见上报（ErrorCenter 聚合）。 */
  reportError: (action: string, error: unknown) => void
}

/** user_data_load 行的窄化形状（payload.mode 为持久化的权威值）。 */
function persistedModeOf(row: unknown): ApprovalMode | null {
  if (!row || typeof row !== 'object') return null
  const payload = (row as { payload?: { mode?: unknown } }).payload
  if (!payload || typeof payload !== 'object') return null
  return normalizeApprovalMode(String(payload.mode ?? ''))
}

export async function restoreApprovalModeFromBackendAuthority(deps: ApprovalModeRestoreDeps): Promise<void> {
  try {
    const persisted = persistedModeOf(await deps.loadPersisted())
    if (persisted) {
      deps.apply(persisted)
      return
    }
    const local = deps.readLocal()
    if (!local) return
    deps.apply(local)
    await deps.seedToBackend(local)
  } catch (error) {
    deps.reportError('恢复权限模式', error)
    const local = deps.readLocal()
    if (local) deps.applyLocalFallback(local)
  }
}
