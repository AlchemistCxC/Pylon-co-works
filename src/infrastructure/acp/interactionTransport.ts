import type {
  InteractionResponseAnswer,
  InteractionResponseIdentity,
  InteractionResponseTransport,
} from '../../domains/agent/agentContracts.ts'

export interface InteractionTransportDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

export type { InteractionResponseAnswer, InteractionResponseIdentity }

/** identity 完整校验：缺任一必填字段禁止提交（防把未知请求误当可提交事务）。 */
function requireIdentity(identity: InteractionResponseIdentity): InteractionResponseIdentity {
  if (
    !identity.provider
    || !identity.agentId
    || !identity.requestId
    || !identity.sessionId
    || identity.clientGeneration === null
  ) {
    throw new Error('Interaction identity 不完整，禁止提交')
  }
  return identity
}

/**
 * 统一 interaction response transport（P1-5，R2-WI04 收敛）：
 * 唯一构造 `respond_interaction` payload 的实现——PermissionController 与未来
 * InteractionCard 都经它应答，不直接知道 provider-specific RPC。
 */
export function createInteractionResponseTransport(deps: InteractionTransportDeps): InteractionResponseTransport {
  return {
    async respond(request, answer): Promise<void> {
      const identity = requireIdentity(request.identity)
      await deps.invoke('respond_interaction', {
        identity,
        kind: request.kind,
        answer,
      })
    },
  }
}
