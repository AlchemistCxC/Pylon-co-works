import { useWorkspaceStore } from '../../workspaceStore'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { toAgentContextKey } from '../../agentContext'
import { resolveBindingState, refineBindingGeneration, type BindingState } from './bindingState'

/**
 * OWNER-03 hook：激活 Agent Sheet 的 Binding 状态派生（§5.9 冷启动路径的声明式消费）。
 *
 * 从 stores 收集（active sheet / sessions / activeAgent / owner agentStatus），
 * 交给纯 resolver。selector 只返回 store 内稳定引用（#185 约束：不返回新对象字面量）。
 *
 * OWNER-04：在 resolver 结果上再套一层 generation 精化——binding_ready 只代表
 * "Agent 当前 connected"，若 binding 建立时的 generation 已不同于当前 agentStatus
 * generation（Agent 重连/替换），旧 binding 必须 Invalidated（binding_stale）。
 */
export function useBindingState(sessionId: string | null): BindingState {
  const activeSheet = useWorkspaceStore(s => {
    const id = s.workspaceSheets.activeSheetId
    return id ? s.workspaceSheets.sheets.find(sheet => sheet.id === id) ?? null : null
  })
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const sessions = useIdentityStore(s => s.sessions)
  const ownerId = activeSheet?.kind === 'agent' ? activeSheet.agentId : undefined
  const ownerStatus = useRuntimeStore(s => (ownerId ? s.agentStatuses[ownerId] : undefined))
  // OWNER-04：binding 建立时的 generation 快照（按 agentId+source 隔离；无激活会话时无 key）
  const activeSession = sessionId ? sessions.find(item => item.id === sessionId) ?? null : null
  const bindingKey = activeSession
    ? toAgentContextKey({ agentId: activeSession.agentId, source: activeSession.source })
    : undefined
  const establishedGeneration = useRuntimeStore(s => (bindingKey ? s.bindingGenerations[bindingKey] : undefined))
  const binding = resolveBindingState({ activeSheet, activeSessionId: sessionId, sessions, activeAgent, ownerStatus })
  return refineBindingGeneration(binding, {
    establishedGeneration,
    currentGeneration: ownerStatus?.generation,
  })
}
