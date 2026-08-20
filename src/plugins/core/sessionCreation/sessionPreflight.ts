import type { Session } from '../../../identityStore.ts'
import { getSessionCreationRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { runSessionCreationPhase } from '../../../plugin-runtime/session-creation/runSessionCreationPhase.ts'
import type { SessionCreationJson, SessionCreationPhaseResult } from '../../../plugin-runtime/session-creation/sessionCreationTypes.ts'

export const SESSION_PREFLIGHT_PHASE = 'pylon/session-preflight'
export const ACP_NEW_SESSION_OPTIONS_EFFECT_KIND = 'pylon/acp-new-session-options'

export interface SessionPreflightResult extends SessionCreationPhaseResult {
  readonly mcpServers: readonly unknown[]
}

function record(value: SessionCreationJson): { readonly [key: string]: SessionCreationJson } | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as { readonly [key: string]: SessionCreationJson }
    : null
}

export async function runSessionPreflight(
  session: Session,
  signal: AbortSignal = new AbortController().signal,
): Promise<SessionPreflightResult> {
  const result = await runSessionCreationPhase(
    getSessionCreationRegistry().getSnapshot(),
    session.creationSnapshot,
    SESSION_PREFLIGHT_PHASE,
    { session, signal },
  )
  const mcpServers = result.effects.flatMap(effect => {
    if (effect.kind !== ACP_NEW_SESSION_OPTIONS_EFFECT_KIND) return []
    const payload = record(effect.payload)
    return Array.isArray(payload?.mcpServers) ? [...payload.mcpServers] : []
  })
  return Object.freeze({ ...result, mcpServers: Object.freeze(mcpServers) })
}

