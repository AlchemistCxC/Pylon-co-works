import { invoke } from '@tauri-apps/api/core'
import type { SendMessagePayload } from '../../infrastructure/acp/chatClient.ts'
import { createChatClient } from '../../infrastructure/acp/chatClient.ts'
import { useIdentityStore, type Session } from '../../identityStore.ts'
import { getChatController } from '../../components/chat/chatEventController.ts'
import { buildSendMessagePayload } from '../../components/chat/sessionRuntime.ts'
import { collectProfilePersona } from '../../plugins/core/sessionCreation/builtinSessionCreation.ts'
import type { WorkbenchCommandFacade } from '../../domains/workbench/workbenchCommandFacade.ts'
import { setSessionModel } from '../../components/chat/sessionModel.ts'
import { setSessionMode } from '../../components/chat/sessionMode.ts'
import { createInteractionResponseTransport } from '../../infrastructure/acp/interactionTransport.ts'
import type { InteractionResponseAnswer, InteractionResponseIdentity } from '../../domains/agent/agentContracts.ts'
import type { AgentContext } from '../../agentContext.ts'

export interface ResolvedWorkbenchInteraction {
  readonly identity: InteractionResponseIdentity
  readonly kind: string
  readonly revision?: number
}

export interface AgentWorkbenchCommandDependencies {
  resolveSession(sessionId: string): Session | undefined
  resolvePersona(session: Session): string
  sendMessage(payload: SendMessagePayload): Promise<unknown>
  optimisticUser(source: string, content: string, clientMessageId: string): void
  nextClientMessageId(source: string): string
  setModel(context: AgentContext, modelId: string): Promise<void>
  setMode(context: AgentContext, modeId: string): Promise<void>
  setConfigOption(context: AgentContext, key: string, value: unknown): Promise<void>
  resolveConfigOption(sessionId: string, key: string): { readonly value?: unknown; readonly version?: number } | undefined
  resolveInteraction(sessionId: string, interactionId: string): ResolvedWorkbenchInteraction | undefined
  respondInteraction(request: ResolvedWorkbenchInteraction, answer: InteractionResponseAnswer): Promise<void>
}

function productionDependencies(): AgentWorkbenchCommandDependencies {
  return {
    resolveSession: sessionId => useIdentityStore.getState().sessions.find(item => item.id === sessionId),
    resolvePersona: session => {
      const profile = useIdentityStore.getState().profiles.find(item => item.id === session.profileId)
      return collectProfilePersona(session.creationSnapshot) || profile?.persona || ''
    },
    sendMessage: payload => createChatClient({ invoke: (command, args) => invoke(command, args as Record<string, unknown> | undefined) }).sendMessage(payload),
    optimisticUser: (source, content, clientMessageId) => getChatController()?.sendOptimisticUser(source, content, clientMessageId),
    nextClientMessageId: source => `${source}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    setModel: (context, modelId) => setSessionModel(context, modelId),
    setMode: (context, modeId) => setSessionMode(context, modeId),
    setConfigOption: async (context, key, value) => {
      await createChatClient({ invoke: (command, args) => invoke(command, args as Record<string, unknown> | undefined) })
        .setConfigOption({ agentId: context.agentId, source: context.source, key, value })
    },
    resolveConfigOption: () => undefined,
    resolveInteraction: () => undefined,
    respondInteraction: (request, answer) => createInteractionResponseTransport({
      invoke: (command, args) => invoke(command, args),
    }).respond(request, answer),
  }
}

const rejected = (error: string) => ({ ok: false, error })

function interactionAnswer(value: unknown): InteractionResponseAnswer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const answer: InteractionResponseAnswer = {}
  if (typeof input.optionId === 'string' && input.optionId.trim()) answer.optionId = input.optionId
  if (typeof input.text === 'string') answer.text = input.text
  if (input.values && typeof input.values === 'object' && !Array.isArray(input.values)) {
    const values = Object.fromEntries(Object.entries(input.values as Record<string, unknown>).filter((entry): entry is [string, string | string[]] =>
      typeof entry[1] === 'string' || (Array.isArray(entry[1]) && entry[1].every(item => typeof item === 'string')),
    ))
    if (Object.keys(values).length > 0) answer.values = values
  }
  return answer.optionId !== undefined || answer.text !== undefined || answer.values !== undefined ? answer : undefined
}

export function createAgentWorkbenchCommandFacade(
  overrides: Partial<AgentWorkbenchCommandDependencies> = {},
): WorkbenchCommandFacade {
  const dependencies: AgentWorkbenchCommandDependencies = { ...productionDependencies(), ...overrides }
  const send: WorkbenchCommandFacade['send'] = async (sessionId, command) => {
    const session = dependencies.resolveSession(sessionId)
    const content = command.text.trim()
    if (!session) return { status: 'rejected', error: 'session_not_found' }
    if (!content) return { status: 'rejected', error: 'message_empty' }
    const clientMessageId = dependencies.nextClientMessageId(session.source)
    dependencies.optimisticUser(session.source, content, clientMessageId)
    try {
      await dependencies.sendMessage(buildSendMessagePayload({
        session, content, persona: dependencies.resolvePersona(session),
        attachments: command.attachments?.map(item => item.path) ?? [],
      }))
      return { status: 'sent', messageId: clientMessageId }
    } catch (error) {
      return { status: 'rejected', messageId: clientMessageId, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    prompt: send, send,
    async cancel(sessionId) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return { status: 'rejected', error: 'session_not_found' }
      getChatController()?.requestCancel(session.source)
      return { status: 'cancelled' }
    },
    async attach() { return [] },
    async setModel(sessionId, modelId) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return rejected('session_not_found')
      if (!modelId.trim()) return rejected('model_empty')
      try { await dependencies.setModel({ agentId: session.agentId, source: session.source }, modelId); return { ok: true } }
      catch (error) { return rejected(error instanceof Error ? error.message : String(error)) }
    },
    async setMode(sessionId, modeId) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return rejected('session_not_found')
      if (!modeId.trim()) return rejected('mode_empty')
      try { await dependencies.setMode({ agentId: session.agentId, source: session.source }, modeId); return { ok: true } }
      catch (error) { return rejected(error instanceof Error ? error.message : String(error)) }
    },
    async setConfigOption(sessionId, key, value, options) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return rejected('session_not_found')
      if (!key.trim()) return rejected('config_key_empty')
      if (typeof value !== 'string' && typeof value !== 'boolean') return rejected('config_value_unsupported')
      const current = dependencies.resolveConfigOption(sessionId, key)
      if (options && !current) return rejected('config_option_not_found')
      if (options && 'expectedValue' in options && !sameConfigValue(options.expectedValue, current?.value)) return rejected('config_value_stale')
      if (options?.expectedVersion !== undefined && options.expectedVersion !== current?.version) return rejected('config_version_stale')
      try {
        await dependencies.setConfigOption({ agentId: session.agentId, source: session.source }, key, value)
        return { ok: true }
      } catch (error) { return rejected(error instanceof Error ? error.message : String(error)) }
    },
    async createSession() { return { sessionId: '' } },
    async compact() { return rejected('production_command_not_connected') },
    async exportSession() { return rejected('production_command_not_connected') },
    async clearSession() { return rejected('production_command_not_connected') },
    async toolAction() { return rejected('production_command_not_connected') },
    async respondInteraction(sessionId, interactionId, response, options) {
      if (!dependencies.resolveSession(sessionId)) return rejected('session_not_found')
      const request = dependencies.resolveInteraction(sessionId, interactionId)
      if (!request) return rejected('interaction_not_found')
      if (options?.expectedRevision !== undefined && request.revision !== undefined
        && options.expectedRevision !== request.revision) return rejected('interaction_revision_stale')
      const answer = interactionAnswer(response)
      if (!answer) return rejected('interaction_response_invalid')
      try { await dependencies.respondInteraction(request, answer); return { ok: true } }
      catch (error) { return rejected(error instanceof Error ? error.message : String(error)) }
    },
    async openResource() { return rejected('production_command_not_connected') },
    async revealResource() { return rejected('production_command_not_connected') },
    async copy(_sessionId, text) {
      try { await navigator.clipboard.writeText(text); return { ok: true } }
      catch (error) { return rejected(error instanceof Error ? error.message : String(error)) }
    },
    async retry() { return rejected('production_command_not_connected') },
    async recover() { return rejected('production_command_not_connected') },
  }
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}
