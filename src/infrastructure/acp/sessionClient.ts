/**
 * sessionClient — 会话域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * new_session / close_session / load_persisted_session / list_persisted_sessions /
 * export_session / cancel_prompt 的 command/payload 收口；normalize 后出边界。
 */
import { ClientTransport } from './agentClient'
import { normalizePersistedSessions, type PersistedSessionSummary } from '../../domains/overview/persistedSessions'
import type { CancelPromptPayload } from './chatClient'
import type { DurableSessionOwner } from '../../domains/session/owner.ts'

export interface NewSessionPayload {
  /** OWNER-02：目标 owner agentId（new_session 在指定 agent 的 runtime 建会话） */
  agentId: string
  /** D3：Kernel durable owner 的 profile 维。 */
  profileId: string
  source: string
  persona?: string
  /** legacy cwd（CWD-03：绑定 Workspace 时由后端 root_path 覆盖） */
  cwd?: string
  /** CWD-03：Workspace 实体绑定（方案 C）；提供时后端以 workspace.root_path 为 root 单一来源 */
  workspaceId?: string
  /** FE-AUD-018：Profile 默认模型（仅新会话默认，不覆盖已存在会话） */
  model?: string
  /** 插件会话 preflight 解析出的 ACP MCP servers；必须在 session/new 前完成。 */
  mcpServers?: readonly unknown[]
}

export interface LoadPersistedSessionPayload {
  /** Durable owner 同时用于 runtime 路由和本地 state 恢复。 */
  owner: DurableSessionOwner
  periId?: string
  /** legacy cwd（CWD-03：绑定 Workspace 时由后端 root_path 覆盖） */
  cwd?: string
  /** CWD-03：Workspace 实体绑定（方案 C） */
  workspaceId?: string
}

export interface ReplayBoundary {
  kind: 'session-load-response' | 'metadata-unavailable'
  observedCount: number
  retainedStartOrdinal: number | null
  retainedEndOrdinal: number | null
}

export interface ReplayMetadata {
  complete: boolean
  truncated: boolean
  droppedCount: number
  boundary: ReplayBoundary
}

export interface PersistedSessionLoadResult {
  response: unknown
  replay: unknown[]
  replayMetadata: ReplayMetadata
  canonicalRevision: number
  replayJournalStatus: 'imported' | 'reconciled' | 'already-present' | 'incomplete-not-imported' | 'metadata-unavailable'
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function finitePositiveInteger(value: unknown): number | null {
  const parsed = finiteNonNegativeInteger(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

/** D6：旧/畸形 backend 响应不得被误标成 complete。 */
export function normalizePersistedSessionLoadResult(raw: unknown): PersistedSessionLoadResult {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const replay = Array.isArray(record.replay) ? record.replay : []
  const candidate = record.replayMetadata && typeof record.replayMetadata === 'object'
    ? record.replayMetadata as Record<string, unknown>
    : null
  const boundaryCandidate = candidate?.boundary && typeof candidate.boundary === 'object'
    ? candidate.boundary as Record<string, unknown>
    : null
  const observedCount = finiteNonNegativeInteger(boundaryCandidate?.observedCount)
  const droppedCount = finiteNonNegativeInteger(candidate?.droppedCount)
  const retainedStart = boundaryCandidate?.retainedStartOrdinal === null
    ? null
    : finitePositiveInteger(boundaryCandidate?.retainedStartOrdinal)
  const retainedEnd = boundaryCandidate?.retainedEndOrdinal === null
    ? null
    : finitePositiveInteger(boundaryCandidate?.retainedEndOrdinal)
  const truncated = candidate?.truncated
  const complete = candidate?.complete
  const validRange = replay.length === 0
    ? retainedStart === null && retainedEnd === null
    : retainedStart === (droppedCount ?? -1) + 1 && retainedEnd === observedCount
  const valid = candidate !== null
    && typeof truncated === 'boolean'
    && typeof complete === 'boolean'
    && complete === !truncated
    && droppedCount !== null
    && truncated === (droppedCount > 0)
    && observedCount !== null
    && observedCount === replay.length + droppedCount
    && boundaryCandidate?.kind === 'session-load-response'
    && validRange

  return {
    response: 'response' in record ? record.response : raw,
    replay,
    replayMetadata: valid ? {
      complete: complete!,
      truncated: truncated!,
      droppedCount: droppedCount!,
      boundary: {
        kind: 'session-load-response',
        observedCount: observedCount!,
        retainedStartOrdinal: retainedStart,
        retainedEndOrdinal: retainedEnd,
      },
    } : {
      complete: false,
      truncated: false,
      droppedCount: 0,
      boundary: {
        kind: 'metadata-unavailable',
        observedCount: replay.length,
        retainedStartOrdinal: replay.length > 0 ? 1 : null,
        retainedEndOrdinal: replay.length > 0 ? replay.length : null,
      },
    },
    canonicalRevision: finiteNonNegativeInteger(record.canonicalRevision) ?? 0,
    replayJournalStatus: record.replayJournalStatus === 'imported'
      || record.replayJournalStatus === 'reconciled'
      || record.replayJournalStatus === 'already-present'
      || record.replayJournalStatus === 'incomplete-not-imported'
      ? record.replayJournalStatus
      : 'metadata-unavailable',
  }
}

export interface ExportSessionPayload {
  /** OWNER-02：Session owner 显式 agentId（export 以 periId 寻会话，归属由 agentId 确定） */
  agentId: string
  periId: string
  format: string
  outputPath: string
}

export interface CloseSessionPayload {
  agentId: string
  source: string
}

export function createSessionClient(transport: ClientTransport) {
  return {
    newSession: (payload: NewSessionPayload): Promise<unknown> => transport.invoke('new_session', payload),
    closeSession: (payload: CloseSessionPayload): Promise<unknown> => transport.invoke('close_session', payload),
    loadPersistedSession: (payload: LoadPersistedSessionPayload): Promise<PersistedSessionLoadResult> =>
      transport.invoke('load_persisted_session', payload).then(normalizePersistedSessionLoadResult),
    listPersistedSessions: (): Promise<PersistedSessionSummary[]> =>
      transport.invoke('list_persisted_sessions').then(raw => normalizePersistedSessions(raw)),
    exportSession: (payload: ExportSessionPayload): Promise<unknown> => transport.invoke('export_session', payload),
    cancelPrompt: (payload: CancelPromptPayload): Promise<unknown> => transport.invoke('cancel_prompt', payload),
  }
}

export type SessionClient = ReturnType<typeof createSessionClient>
