import { invoke } from '@tauri-apps/api/core'
import { useIdentityStore } from '../../identityStore.ts'
import { useRuntimeStore } from '../../runtimeStore.ts'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore.ts'
import type { SessionCreateInput } from '../../domains/workbench/workbenchCommandFacade.ts'
import { createSessionClient } from '../../infrastructure/acp/sessionClient.ts'
import { sessionResponseObject } from '../../infrastructure/acp/chatContracts.ts'
import { applySessionStateResponse } from '../../domains/sessionState/sessionStateSync.ts'
import { collectProfilePersona } from '../../plugins/core/sessionCreation/builtinSessionCreation.ts'
import { runSessionPreflight } from '../../plugins/core/sessionCreation/sessionPreflight.ts'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'
import { reportRuntimeError } from '../../runtimeError.ts'

export interface AgentWorkbenchSessionCreationContext {
  readonly agentId: string
  readonly workspaceMode: 'work' | 'chat'
}

/** Host-owned creation transaction used by the Solid workbench. */
export async function createAgentWorkbenchSession(
  request: SessionCreateInput | undefined,
  context: AgentWorkbenchSessionCreationContext,
): Promise<{ sessionId: string }> {
  const title = request?.title?.trim() || `session-${Date.now().toString(36)}`
  const workspace = request?.workspaceId
    ? useWorkspaceEntityStore.getState().workspaces.find(item => item.id === request.workspaceId)
    : undefined
  if (context.workspaceMode === 'work' && !workspace) throw new Error('请先选择工作区')

  const creating = await getHookRuntime().invoke('session.creating', {
    agentId: context.agentId,
    title,
    ...(workspace ? { workspaceId: workspace.id, cwd: workspace.rootPath, skills: workspace.skills, mcpServerIds: workspace.mcpServerIds, hookPluginIds: workspace.hookPluginIds } : {}),
  }, workspace?.hookPluginIds)
  if (creating.action === 'cancel') throw new Error(creating.reason || 'Session 创建已被插件拦截')
  const effective = creating.event as { agentId?: unknown; title?: unknown; workspaceSkills?: unknown; workspaceMcpServerIds?: unknown; workspaceHookPluginIds?: unknown; skills?: unknown; mcpServerIds?: unknown; hookPluginIds?: unknown }
  const effectiveAgentId = typeof effective.agentId === 'string' ? effective.agentId.trim() : ''
  const effectiveTitle = typeof effective.title === 'string' ? effective.title.trim() : ''
  if (!effectiveAgentId || !effectiveTitle) throw new Error('Session hook 返回的 agentId / title 无效')

  const identity = useIdentityStore.getState()
  const sessionId = identity.addSession(effectiveTitle, effectiveAgentId, workspace ? {
    workdir: workspace.rootPath,
    workspaceId: workspace.id,
    skills: [...workspace.skills],
    hooks: [...workspace.hookPluginIds],
    mcpServerIds: [...workspace.mcpServerIds],
    hookPluginIds: [...workspace.hookPluginIds],
  } : undefined)
  if (!sessionId) throw new Error('Session 创建被本地持久化状态拒绝')
  const session = useIdentityStore.getState().sessions.find(item => item.id === sessionId)
  if (!session) throw new Error(`Session 本地创建失败：${sessionId}`)

  try {
    const profile = useIdentityStore.getState().profiles.find(item => item.id === session.profileId)
    const preflight = await runSessionPreflight(session)
    const response = await createSessionClient({
      invoke: (command, args) => invoke(command, args as Record<string, unknown> | undefined),
    }).newSession({
      agentId: session.agentId,
      profileId: session.profileId,
      source: session.source,
      persona: collectProfilePersona(session.creationSnapshot) || profile?.persona,
      cwd: session.workdir || undefined,
      workspaceId: session.workspaceId,
      model: request?.model || profile?.model,
      ...(request?.reasoningLevel ? { reasoningLevel: request.reasoningLevel } : {}),
      ...(request?.mode ? { mode: request.mode } : {}),
      ...(preflight.mcpServers.length > 0 ? { mcpServers: preflight.mcpServers } : {}),
    })
    const normalized = sessionResponseObject(response)
    const remoteId = normalized.sessionId ?? normalized.periId
    if (remoteId) useIdentityStore.getState().setSessionPeriId(session.id, remoteId)
    const owner = { agentId: session.agentId, source: session.source }
    applySessionStateResponse(owner, normalized)
    useRuntimeStore.getState().setBindingGeneration(
      owner,
      useRuntimeStore.getState().agentStatuses[session.agentId]?.generation,
    )
    return { sessionId: session.id }
  } catch (error) {
    useIdentityStore.getState().removeSession(session.id)
    throw error
  }
}

/** Roll back a remotely-created session when its atomic first prompt fails. */
export async function discardAgentWorkbenchSession(sessionId: string): Promise<void> {
  const session = useIdentityStore.getState().sessions.find(item => item.id === sessionId)
  if (!session) return
  try {
    await createSessionClient({
      invoke: (command, args) => invoke(command, args as Record<string, unknown> | undefined),
    }).closeSession({ agentId: session.agentId, source: session.source })
  } catch (error) {
    reportRuntimeError('回滚空态新会话', error)
  } finally {
    useIdentityStore.getState().removeSession(session.id)
  }
}
