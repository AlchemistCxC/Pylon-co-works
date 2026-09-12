import type { Session } from '../../identityStore.ts'
import type { NewSessionPayload, SessionClient } from '../../infrastructure/acp/sessionClient.ts'
import { runSessionPreflight } from '../../plugins/core/sessionCreation/sessionPreflight.ts'

type SessionRequestOptions = Pick<NewSessionPayload, 'persona' | 'model' | 'reasoningLevel' | 'mode' | 'workspaceId'>

/** Shared remote creation step. Callers retain rollback, cancellation and commit
 * ownership. Resolve options after preflight so recovery can read the live model
 * while new-session entry points retain their captured profile. */
export async function requestNewSession(
  session: Session,
  client: Pick<SessionClient, 'newSession'>,
  options: () => SessionRequestOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  const preflight = await runSessionPreflight(session, signal)
  return client.newSession({
    agentId: session.agentId,
    profileId: session.profileId,
    source: session.source,
    cwd: session.workdir || undefined,
    workspaceId: session.workspaceId,
    ...options(),
    ...(preflight.mcpServers.length > 0 ? { mcpServers: preflight.mcpServers } : {}),
  })
}
