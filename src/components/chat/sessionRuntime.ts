import type { Session, SessionConfig } from '../../store'
import type { AvailableCommand } from '../../infrastructure/acp/chatContracts'
import type { AgentContext, AgentContextKey } from '../../agentContext.ts'
import { toAgentContextKey } from '../../agentContext.ts'
import { injectAgentCommandPrompt } from '../../host/commandSetResolver.ts'
import { collectFirstMessagePromptPrelude } from '../../plugins/core/sessionCreation/builtinSessionCreation.ts'

export interface SessionLiveStats {
  tokensUsed: number
  tokensMax: number
  cacheReadTokens: number
  commands: AvailableCommand[]
}

export function emptySessionLiveStats(): SessionLiveStats {
  return {
    tokensUsed: 0,
    tokensMax: 131072,
    cacheReadTokens: 0,
    commands: [],
  }
}

export function updateSessionLiveStats(
  state: Record<AgentContextKey, SessionLiveStats>,
  context: AgentContext,
  partial: Partial<SessionLiveStats>,
): Record<AgentContextKey, SessionLiveStats> {
  const key = toAgentContextKey(context)
  return {
    ...state,
    [key]: {
      ...emptySessionLiveStats(),
      ...state[key],
      ...partial,
    },
  }
}

interface ClearSessionSourceStateOptions {
  context: AgentContext
  sessionLiveStats: Record<AgentContextKey, SessionLiveStats>
  sessionModes: Record<AgentContextKey, string>
  sessionConfig: Record<AgentContextKey, SessionConfig>
  generatingSources: string[]
}

function omitKey<T>(state: Record<AgentContextKey, T>, key: AgentContextKey): Record<AgentContextKey, T> {
  const next = { ...state }
  delete next[key]
  return next
}

export function clearSessionSourceState({
  context,
  sessionLiveStats,
  sessionModes,
  sessionConfig,
  generatingSources,
}: ClearSessionSourceStateOptions) {
  const key = toAgentContextKey(context)
  return {
    sessionLiveStats: omitKey(sessionLiveStats, key),
    sessionModes: omitKey(sessionModes, key),
    sessionConfig: omitKey(sessionConfig, key),
    generatingSources: generatingSources.filter(item => item !== context.source),
  }
}

interface BuildSendMessagePayloadOptions {
  session: Session
  content: string
  persona: string
  attachments: string[]
}

export function buildSendMessagePayload({ session, content, persona, attachments }: BuildSendMessagePayloadOptions) {
  const snapshotPrelude = collectFirstMessagePromptPrelude(session.creationSnapshot)
  const commandPrelude = injectAgentCommandPrompt({ ...session, sessionPrompt: '' })
  const sessionPrompt = [snapshotPrelude || persona.trim(), session.sessionPrompt.trim(), commandPrelude]
    .filter(Boolean)
    .join('\n\n')
  return {
    // OWNER-02：Session owner 显式 agentId（从 Session 读取，绝不取 activeAgent）。
    agentId: session.agentId,
    profileId: session.profileId,
    source: session.source,
    content,
    persona,
    // Profile、用户 Session Prompt 与旧 commandSet 统一叠加；Rust 首轮门禁仍负责
    // 非命令隐藏投递、成功后消费与失败重试。
    sessionPrompt,
    attachments,
  }
}
