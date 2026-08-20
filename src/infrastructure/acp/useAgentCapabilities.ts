import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { resolveCapabilitySnapshot, type AgentCapabilitySnapshot } from './agentContracts'

/**
 * useAgentCapabilities — 能力快照读取 hook（F4-D）。
 *
 * 只读 runtimeStore 对应 agent 的 status（窄 selector，避免整个 agentStatuses 心跳
 * 都重渲染消费方）；缺省读 activeAgent。不持久化、不进 workspaceStore——快照是实时
 * 运行时状态，重连后 handshake 重新拿到。
 */
export function useAgentCapabilities(agentId?: string): AgentCapabilitySnapshot {
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const targetId = agentId ?? activeAgent
  const status = useRuntimeStore(s => (targetId ? s.agentStatuses[targetId] : undefined))
  return resolveCapabilitySnapshot(status)
}
