import type { WorkspaceSession } from '../session/workspaceSession.ts'

/** Stable FileSheet identity. It never depends on the currently active Agent/runtime. */
export interface WorkspaceTarget {
  sessionId: string
  agentId: string
  source: string
  workspaceId?: string
  legacyWorkdir?: string
}

export type WorkspaceTargetWire = WorkspaceTarget

export function workspaceTargetFromSession(session: WorkspaceSession | undefined): WorkspaceTarget | null {
  if (!session?.id || !session.agentId || !session.source) return null
  return {
    sessionId: session.id,
    agentId: session.agentId,
    source: session.source,
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(!session.workspaceId && session.workdir ? { legacyWorkdir: session.workdir } : {}),
  }
}

export function workspaceTargetKey(target: WorkspaceTarget | null): string | null {
  return target ? `${target.sessionId}\u0000${target.agentId}\u0000${target.source}\u0000${target.workspaceId ?? ''}\u0000${target.legacyWorkdir ?? ''}` : null
}
