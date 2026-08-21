import type { ActivityResolution, InteractionKind } from '../activity/activity.ts'
import type { InteractionEventEnvelope, InteractionRequest } from '../activity/interaction.ts'
import type { ToolAction, ToolKind } from '../tool/toolPresentation.ts'

/** 新 Agent 的稳定标识；不能把具体 Agent 名称硬编码进核心 union。 */
export type AgentProviderId = string
export type AgentInstanceId = string

export interface AgentToolDefinition {
  name: string
  kind: ToolKind
  action: ToolAction
  aliases?: string[]
  capabilities?: readonly string[]
}

export interface AgentProtocolCapabilities {
  sessionUpdates: boolean
  interactionEvents: boolean
  permissionRequests: boolean
  replay: boolean
  responseMethods: string[]
}

export interface AgentDescriptor {
  provider: AgentProviderId
  displayName: string
  protocol: 'acp' | 'custom'
  capabilities: AgentProtocolCapabilities
  tools: readonly AgentToolDefinition[]
  interactionKinds: readonly InteractionKind[]
}

/** 配置实例与协议 provider 分离；同 provider 可绑定多个 agentId。 */
export interface AgentInstanceDescriptor {
  agentId: AgentInstanceId
  provider: AgentProviderId
  displayName: string
  descriptor: AgentDescriptor | null
  state: 'ready' | 'degraded'
  issue?: 'provider-unregistered' | 'invalid-instance'
}

export interface AgentResolutionContext {
  provider?: AgentProviderId
  descriptor?: AgentDescriptor
}

export type ActivityResolver = (input: {
  name?: string
  eventType?: string
  payload?: unknown
}) => ActivityResolution | null

export interface InteractionAdapterContract {
  id: string
  provider: AgentProviderId
  canHandle(input: { envelope?: InteractionEventEnvelope; eventType?: string; name?: string; payload?: unknown }): boolean
  normalize(input: { envelope?: InteractionEventEnvelope; eventType?: string; name?: string; payload?: unknown }): InteractionRequest | null
  responseMethodFor(kind: InteractionKind): string | null
}

/** 后端 `respond_interaction` 的 identity 契约（wire camelCase，字段必填）。 */
export interface InteractionResponseIdentity {
  provider: string
  agentId: string
  requestId: string
  sessionId: string
  toolCallId?: string
  clientGeneration: number
}

/** interaction 应答（approval 用 optionId；clarify/ask-user 未来用 text/values）。 */
export interface InteractionResponseAnswer {
  optionId?: string
  values?: Record<string, string | string[]>
  text?: string
}

/** 统一 interaction response transport 契约：单一 `respond_interaction` payload 构造点。 */
export interface InteractionResponseTransport {
  respond(
    request: { identity: InteractionResponseIdentity; kind: string },
    answer: InteractionResponseAnswer,
  ): Promise<void>
}
