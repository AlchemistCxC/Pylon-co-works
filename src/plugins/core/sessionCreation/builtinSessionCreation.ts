import type { PluginSessionCreationApi } from '../../../plugin-runtime/session-creation/pluginSessionCreationApi.ts'
import type { SessionCreationSnapshot } from '../../../plugin-runtime/session-creation/sessionCreationTypes.ts'

export const PROFILE_PERSONA_CONTRIBUTION_KIND = 'builtin.pylon/profile-persona'
export const FIRST_MESSAGE_PHASE = 'pylon/session-first-message'
export const PROMPT_PRELUDE_ARTIFACT_KIND = 'pylon/prompt-prelude'
export const WORKSPACE_CAPABILITIES_CONTRIBUTION_KIND = 'builtin.pylon/workspace-capabilities'

export function registerBuiltinSessionCreationContributions(api: PluginSessionCreationApi): void {
  api.registerCompiler({
    id: 'builtin.pylon/profile-persona-compiler',
    kind: PROFILE_PERSONA_CONTRIBUTION_KIND,
    order: 100,
    compile: contribution => {
      const payload = contribution.payload as { profileId?: unknown, text?: unknown }
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!text) return []
      return [{
        phase: FIRST_MESSAGE_PHASE,
        kind: PROMPT_PRELUDE_ARTIFACT_KIND,
        order: 100,
        payload: { source: 'profile', profileId: String(payload.profileId ?? ''), text },
      }]
    },
  })
  api.registerCompiler({
    id: 'builtin.pylon/workspace-capabilities-compiler',
    kind: WORKSPACE_CAPABILITIES_CONTRIBUTION_KIND,
    order: 110,
    compile: contribution => {
      const payload = contribution.payload as { skills?: unknown; mcpServerIds?: unknown; hookPluginIds?: unknown }
      const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : []
      const skills = list(payload.skills), mcps = list(payload.mcpServerIds), hooks = list(payload.hookPluginIds)
      if (skills.length === 0 && mcps.length === 0 && hooks.length === 0) return []
      const lines = ['工作区能力（仅对本次新建会话生效；已有会话保持不变）：']
      if (skills.length) lines.push('Skills: ' + skills.join(', '))
      if (mcps.length) lines.push('MCP: ' + mcps.join(', '))
      if (hooks.length) lines.push('Hooks: ' + hooks.join(', '))
      return [{ phase: FIRST_MESSAGE_PHASE, kind: PROMPT_PRELUDE_ARTIFACT_KIND, order: 110, payload: { source: 'workspace', text: lines.join('\\n') } }]
    },
  })
  api.registerContribution({
    id: 'builtin.pylon/workspace-capabilities',
    kind: WORKSPACE_CAPABILITIES_CONTRIBUTION_KIND,
    order: 110,
    failurePolicy: 'optional',
    payload: context => ({ skills: context.workspaceSkills ?? [], mcpServerIds: context.workspaceMcpServerIds ?? [], hookPluginIds: context.workspaceHookPluginIds ?? [] }),
  })

  api.registerContribution({
    id: 'builtin.pylon/profile-persona',
    kind: PROFILE_PERSONA_CONTRIBUTION_KIND,
    order: 100,
    failurePolicy: 'required',
    payload: context => ({ profileId: context.profile.id, text: context.profile.persona }),
  })
}

export function collectFirstMessagePromptPrelude(snapshot: SessionCreationSnapshot | undefined): string {
  if (!snapshot) return ''
  return snapshot.artifacts
    .filter(artifact => artifact.phase === FIRST_MESSAGE_PHASE && artifact.kind === PROMPT_PRELUDE_ARTIFACT_KIND)
    .map(artifact => {
      const payload = artifact.payload
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
      const record = payload as { readonly [key: string]: unknown }
      return typeof record.text === 'string' ? record.text.trim() : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

export function collectProfilePersona(snapshot: SessionCreationSnapshot | undefined): string {
  const artifact = snapshot?.artifacts.find(item => (
    item.kind === PROMPT_PRELUDE_ARTIFACT_KIND
    && item.sourceContributionId === 'builtin.pylon/profile-persona'
  ))
  if (!artifact?.payload || typeof artifact.payload !== 'object' || Array.isArray(artifact.payload)) return ''
  const record = artifact.payload as { readonly [key: string]: unknown }
  return typeof record.text === 'string' ? record.text.trim() : ''
}
