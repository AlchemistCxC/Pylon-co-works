/**
 * sessionClient — 会话域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * new_session / close_session / load_persisted_session / list_persisted_sessions /
 * export_session / cancel_prompt 的 command/payload 收口；normalize 后出边界。
 */
import { ClientTransport } from './agentClient'
import { normalizePersistedSessions, type PersistedSessionSummary } from '../../domains/overview/persistedSessions'

export interface NewSessionPayload {
  source: string
  persona?: string
  cwd?: string
}

export interface LoadPersistedSessionPayload {
  source: string
  periId?: string
  cwd?: string
}

export interface ExportSessionPayload {
  periId: string
  format: string
  outputPath: string
}

export function createSessionClient(transport: ClientTransport) {
  return {
    newSession: (payload: NewSessionPayload): Promise<unknown> => transport.invoke('new_session', payload),
    closeSession: (source: string): Promise<unknown> => transport.invoke('close_session', { source }),
    loadPersistedSession: (payload: LoadPersistedSessionPayload): Promise<unknown> => transport.invoke('load_persisted_session', payload),
    listPersistedSessions: (): Promise<PersistedSessionSummary[]> =>
      transport.invoke('list_persisted_sessions').then(raw => normalizePersistedSessions(raw)),
    exportSession: (payload: ExportSessionPayload): Promise<unknown> => transport.invoke('export_session', payload),
    cancelPrompt: (source: string): Promise<unknown> => transport.invoke('cancel_prompt', { source }),
  }
}

export type SessionClient = ReturnType<typeof createSessionClient>
