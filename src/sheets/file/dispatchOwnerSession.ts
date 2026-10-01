import type { Session } from '../../domains/identity/identityStore'

/**
 * resolveDispatchOwnerSession — 发令目标会话归属解析（原 DispatchBar.tsx 内纯函数）。
 *
 * #515 迁移期 DispatchBar 存在 React 桥与 Solid 实体两个编译面，纯函数下沉到独立
 * 模块单源共享（owner agentId 解析语义见 OWNER-02，§5.8）：优先取 context（sheet 绑定
 * Agent）；context 缺失时回退 Session owner（identityStore 中 source 唯一命中）；仍无法
 * 确定则返回 undefined（调用方拒绝发送，不串线）。
 */
export function resolveDispatchOwnerSession(
  sessions: readonly Session[],
  targetSource: string | null,
  context?: { agentId: string; source: string } | null,
  targetSessionId?: string | null,
): Session | undefined {
  if (!targetSource) return undefined
  const candidates = sessions.filter(session =>
    session.source === targetSource && (!context?.agentId || session.agentId === context.agentId))
  if (targetSessionId) return candidates.find(session => session.id === targetSessionId)
  return candidates.length === 1 ? candidates[0] : undefined
}
