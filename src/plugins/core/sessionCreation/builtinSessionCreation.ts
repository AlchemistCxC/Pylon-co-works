import type { PluginSessionCreationApi } from '../../../plugin-runtime/session-creation/pluginSessionCreationApi.ts'
import type { SessionCreationSnapshot } from '../../../plugin-runtime/session-creation/sessionCreationTypes.ts'

export const PROFILE_PERSONA_CONTRIBUTION_KIND = 'builtin.pylon/profile-persona'
export const FIRST_MESSAGE_PHASE = 'pylon/session-first-message'
export const PROMPT_PRELUDE_ARTIFACT_KIND = 'pylon/prompt-prelude'

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
