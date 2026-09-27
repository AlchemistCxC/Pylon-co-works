import type {
  InteractionResponseAnswer,
  InteractionResponseIdentity,
  InteractionResponseTransport,
} from '../../domains/agent/agentContracts.ts'

export interface InteractionTransportDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

export type { InteractionResponseAnswer, InteractionResponseIdentity }

/** identity 完整校验：缺任一必填字段禁止提交（防把未知请求误当可提交事务）。
 * #356：sessionId 显式空串（request-scoped elicitation）是合法身份——会话外
 * 请求以 requestId+agentId 收口；字段缺失（undefined/null）仍拒绝。
 * 纵深依赖（审查 P2）：空串放行是全 kind 的——elicitation 应答在 transport 层
 * kind 同样是 'approval'，无法在此按 kind 收窄；「permission + 空 sessionId 仍拒」
 * 由上游 normalizePermissionRequest 把守，未来新增 transport 消费入口必须
 * 施加同等门禁，不得直传未归一化的 request。 */
function requireIdentity(identity: InteractionResponseIdentity): InteractionResponseIdentity {
  if (
    !identity.provider
    || !identity.agentId
    || !identity.requestId
    || identity.sessionId == null
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
