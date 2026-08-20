import { invoke } from '@tauri-apps/api/core'
import { useIdentityStore, type Session } from '../identityStore.ts'
import {
  createAgentClient,
  type AgentCreateConfig,
  type AgentsConfigDocument,
} from '../infrastructure/acp/agentClient.ts'
import { createChatClient } from '../infrastructure/acp/chatClient.ts'
import { createSessionClient } from '../infrastructure/acp/sessionClient.ts'
import { builtinAgentCatalog } from '../domains/agent/agentCatalog.ts'
import {
  selectAcpRuntimeDetectorIds,
  type AgentRuntimeCandidate,
  type AgentRuntimeDetectorMetadata,
} from '../domains/agent/agentDetector.ts'
import { getHookRuntime, getPluginServiceRegistry } from '../plugin-runtime/runtimeServices.ts'
import { runUserMessageBeforeHook, runSessionBoundaryHook } from '../application/transactions/sessionHookTransactions.ts'
import { buildSendMessagePayload } from '../components/chat/sessionRuntime.ts'
import { stripHiddenUnicode } from '../utils/unicodeSanitizer.ts'
import type { AgentControlPort, SessionControlPort } from './pylonCliService.ts'
import { runSessionPreflight } from '../plugins/core/sessionCreation/sessionPreflight.ts'
import { collectProfilePersona } from '../plugins/core/sessionCreation/builtinSessionCreation.ts'

const transport = { invoke: (command: string, args?: unknown) => invoke(command, args as Record<string, unknown> | undefined) }
const agentClient = createAgentClient(transport)
const chatClient = createChatClient(transport)
const sessionClient = createSessionClient(transport)

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function wireErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function candidateConfig(candidate: AgentRuntimeCandidate, makeDefault: boolean): AgentCreateConfig {
  return {
    name: candidate.name,
    provider: candidate.provider,
    transport: 'subprocess',
    exe: candidate.executable,
    args: [...candidate.args],
    default: makeDefault,
  }
}

function agentsDocument(agentId: string, config: AgentCreateConfig): AgentsConfigDocument {
  return { agents: { [agentId]: config } }
}

function uniqueAgentId(base: string, existing: readonly { id: string }[]): string {
  let id = base
  let suffix = 2
  while (existing.some(agent => agent.id === id)) id = `${base}-${suffix++}`
  return id
}

async function detectedCandidates(): Promise<AgentRuntimeCandidate[]> {
  const registered = getPluginServiceRegistry().list<AgentRuntimeDetectorMetadata>('agent-detector')
  const detectors = registered.length > 0 ? registered : builtinAgentCatalog.detectors()
  return agentClient.detectAgentRuntimes(selectAcpRuntimeDetectorIds(detectors)).then(report => report.candidates)
}

function resolveSession(sessionId: string): Session | undefined {
  return useIdentityStore.getState().sessions.find(session => session.id === sessionId || session.source === sessionId)
}

function responseSessionId(response: unknown): string | undefined {
  if (typeof response === 'string' && response.trim()) return response
  if (!response || typeof response !== 'object') return undefined
  const value = response as { sessionId?: unknown, periId?: unknown }
  if (typeof value.sessionId === 'string' && value.sessionId.trim()) return value.sessionId
  return typeof value.periId === 'string' && value.periId.trim() ? value.periId : undefined
}

export function createCliAgentControlPort(): AgentControlPort {
  return {
    async list() {
      const [agents, candidates] = await Promise.all([agentClient.listAgents(), detectedCandidates()])
      useIdentityStore.getState().setAgents(agents)
      return { agents, candidates, catalog: builtinAgentCatalog.descriptors() }
    },
    async import(input, { signal }) {
      throwIfAborted(signal)
      const [agents, candidates] = await Promise.all([agentClient.listAgents(), detectedCandidates()])
      throwIfAborted(signal)
      const matches = candidates.filter(candidate => (
        candidate.candidateId === input.candidateId || candidate.suggestedAgentId === input.candidateId
      ))
      if (matches.length === 0) throw new Error(`未找到 Agent 探测候选：${input.candidateId}`)
      if (matches.length > 1) throw new Error(`Agent 候选不唯一，请使用 candidateId：${matches.map(value => value.candidateId).join(', ')}`)
      const candidate = matches[0]
      const requestedId = input.agentId?.trim()
      const agentId = requestedId || uniqueAgentId(candidate.suggestedAgentId, agents)
      if (!/^[A-Za-z0-9._-]+$/.test(agentId)) throw new Error(`Agent id 仅允许字母、数字、点、下划线和连字符：${agentId}`)
      if (agents.some(agent => agent.id === agentId)) throw new Error(`Agent id 已存在：${agentId}`)
      const validation = await agentClient.testAgentCandidate(agentId, {
        name: candidate.name,
        provider: candidate.provider,
        transport: 'subprocess',
        exe: candidate.executable,
        args: candidate.args,
      })
      if (!validation.ok) throw new Error(validation.error?.message || `Agent 候选验证失败：${candidate.candidateId}`)
      throwIfAborted(signal)
      const config = candidateConfig(candidate, agents.length === 0)
      try {
        await agentClient.createAgent(agentId, config)
      } catch (error) {
        if (wireErrorCode(error) !== 'config_read_only') throw error
        await agentClient.initializeAgentsConfig(agentId, agentsDocument(agentId, config))
      }
      throwIfAborted(signal)
      const refreshed = await agentClient.listAgents()
      useIdentityStore.getState().setAgents(refreshed)
      return { agentId, candidateId: candidate.candidateId, validation }
    },
    async setDefault(agentId, { signal }) {
      throwIfAborted(signal)
      try {
        await agentClient.updateAgentFieldPatch(agentId, { default: true })
      } catch (error) {
        if (wireErrorCode(error) !== 'config_read_only') throw error
        await agentClient.initializeAgentFieldPatch(agentId, { default: true })
      }
      throwIfAborted(signal)
      const agents = await agentClient.listAgents()
      useIdentityStore.getState().setAgents(agents)
      return { agentId, default: true }
    },
  }
}

export function createCliSessionControlPort(): SessionControlPort {
  return {
    list: () => useIdentityStore.getState().sessions,
    async create(input, { signal }) {
      throwIfAborted(signal)
      const state = useIdentityStore.getState()
      const agentId = input.agentId?.trim() || state.activeAgent
      if (!agentId) throw new Error('agentId 必须是非空字符串')
      const title = input.title?.trim() || `session-${Date.now().toString(36)}`
      const creating = await getHookRuntime().invoke('session.creating', { ...input, agentId, title })
      if (creating.action === 'cancel') throw new Error(creating.reason || 'Session 创建已被插件拦截')
      const effective = creating.event as typeof input & { agentId: string, title: string }
      const effectiveAgentId = typeof effective.agentId === 'string' ? effective.agentId.trim() : ''
      const effectiveTitle = typeof effective.title === 'string' ? effective.title.trim() : ''
      if (!effectiveAgentId || !effectiveTitle) throw new Error('Session hook 返回的 agentId / title 无效')
      throwIfAborted(signal)
      const sessionId = state.addSession(effectiveTitle, effectiveAgentId, {
        ...(effective.cwd ? { workdir: effective.cwd } : {}),
        ...(effective.workspaceId ? { workspaceId: effective.workspaceId } : {}),
      })
      if (!sessionId) throw new Error('Session 创建被本地持久化状态拒绝')
      const session = resolveSession(sessionId)
      if (!session) throw new Error(`Session 本地创建失败：${sessionId}`)
      try {
        throwIfAborted(signal)
        const current = useIdentityStore.getState()
        const profile = current.profiles.find(value => value.id === session.profileId)
        const preflight = await runSessionPreflight(session, signal)
        const response = await sessionClient.newSession({
          agentId: session.agentId,
          profileId: session.profileId,
          source: session.source,
          persona: collectProfilePersona(session.creationSnapshot) || profile?.persona,
          cwd: session.workdir || undefined,
          workspaceId: session.workspaceId,
          model: profile?.model,
          ...(preflight.mcpServers.length > 0 ? { mcpServers: preflight.mcpServers } : {}),
        })
        throwIfAborted(signal)
        const remoteId = responseSessionId(response)
        if (remoteId) useIdentityStore.getState().setSessionPeriId(session.id, remoteId)
        await runSessionBoundaryHook('session.start', session)
        return { sessionId: session.id, source: session.source, remoteId: remoteId ?? null }
      } catch (error) {
        useIdentityStore.getState().removeSession(session.id)
        throw error
      }
    },
    async send(sessionId, rawContent, { signal }) {
      const session = resolveSession(sessionId)
      if (!session) throw new Error(`Session 不存在：${sessionId}`)
      throwIfAborted(signal)
      const before = await runUserMessageBeforeHook(session, stripHiddenUnicode(rawContent))
      if (before.blocked) throw new Error(before.reason || '消息已被会话钩子拦截')
      throwIfAborted(signal)
      const state = useIdentityStore.getState()
      const profile = state.profiles.find(value => value.id === session.profileId)
      const cancel = () => { void chatClient.cancelPrompt({ agentId: session.agentId, source: session.source }) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const result = await chatClient.sendMessage(buildSendMessagePayload({
          session,
          content: before.content,
          persona: profile?.persona || '',
          attachments: [],
        }))
        throwIfAborted(signal)
        void getHookRuntime().invoke('message.user.sent', { session, content: before.content })
        return result
      } catch (error) {
        void getHookRuntime().invoke('message.user.sendFailed', { session, content: before.content, error: String(error) })
        throw error
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    async close(sessionId, { signal }) {
      const session = resolveSession(sessionId)
      if (!session) return false
      throwIfAborted(signal)
      await getHookRuntime().invoke('session.closing', { session })
      await sessionClient.closeSession({ agentId: session.agentId, source: session.source })
      throwIfAborted(signal)
      await runSessionBoundaryHook('session.end', session)
      return true
    },
    async cancel(sessionId) {
      const session = resolveSession(sessionId)
      if (!session) return false
      await chatClient.cancelPrompt({ agentId: session.agentId, source: session.source })
      return true
    },
  }
}
