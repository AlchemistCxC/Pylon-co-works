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
  reasoningLevel?: string
  /** Initial ACP session mode, applied before first prompt. */
  mode?: string
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

/** 冷挂载 turn 状态（后端 `TurnLedger` 最近一条会话快照）。 */
export interface ColdMountTurnState {
  readonly phase?: string
  readonly terminal?: { readonly cause?: string; readonly detail?: string }
  readonly key?: {
    readonly localSessionId?: string
    readonly remoteSessionId?: string
    readonly generation?: number
    readonly turnId?: number
  }
}

/**
 * #99 冷挂载 turn 快照——`load_persisted_session` 随权威恢复一并返回，前端不再
 * 依赖一次性的 Tauri event。字段形状由后端契约测试
 * `cold_mount_turn_snapshot_exposes_settled_turn_and_cursor` 钉定（#110 F4：
 * 本归一化器原先未透传该字段，冷挂载链路拿不到 turn 事实）。
 */
export interface ColdMountTurnSnapshot {
  readonly source?: string
  readonly periId?: string
  readonly generation?: number
  /** 会话无已知 turn 时为 `null`（后端不伪造空快照）。 */
  readonly turn?: ColdMountTurnState | null
  /**
   * #217/ADR-0017：内核在途回合标记——「本进程已派发 prompt、尚未收到终态」的
   * 一等事实。缺省 = 内核未表态（旧内核/无标记宿主，前端回退 clock 权威）。
   */
  readonly turnInFlight?: boolean
  /** #217 诊断读数：标记为真而账本已无在途 turn（标记滞留）。 */
  readonly turnInFlightAnomaly?: boolean
  /** 入站 ingress 序列 cursor（lastIngressSeq/spill/drop/overloaded）。 */
  readonly sequence?: Readonly<Record<string, unknown>>
  readonly replayLoading?: boolean
  readonly lastError?: string | null
}

export interface PersistedSessionLoadResult {
  response: unknown
  replay: unknown[]
  replayMetadata: ReplayMetadata
  canonicalRevision: number
  replayJournalStatus: 'imported' | 'reconciled' | 'already-present' | 'already-imported' | 'local-authoritative' | 'incomplete-not-imported' | 'metadata-unavailable'
  authority: 'local-journal' | 'recovery-import' | 'empty'
  journalCoverage: 'local-observed' | 'unverified-import' | 'empty' | 'corrupt'
  collection: { complete: boolean; truncated: boolean; droppedCount: number }
  import?: { importId: string; status: 'imported' | 'already-imported'; trust: 'unverified' }
  diagnostics: readonly unknown[]
  /** #110 F4：冷挂载 turn 快照（畸形/缺失 → undefined，绝不抛）。 */
  turn?: ColdMountTurnSnapshot
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function finitePositiveInteger(value: unknown): number | null {
  const parsed = finiteNonNegativeInteger(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 字符串字段：非空字符串才接受（空串与其它类型一律丢弃，不伪造值）。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * #110 F4：冷挂载 turn 快照归一化——只透传已知字段，且每个字段都过类型守卫；
 * 非对象/null 返回 undefined（缺失不伪造）。未知扩展字段不进入返回值
 * （该快照是权威事实投影，不是 raw 回放通道）。
 */
export function normalizeColdMountTurnSnapshot(raw: unknown): ColdMountTurnSnapshot | undefined {
  if (!isRecord(raw)) return undefined
  const turnCandidate = raw.turn
  let turn: ColdMountTurnState | null | undefined
  if (turnCandidate === null) {
    turn = null
  } else if (isRecord(turnCandidate)) {
    const terminal = isRecord(turnCandidate.terminal)
      ? {
          ...(nonEmptyString(turnCandidate.terminal.cause) !== undefined ? { cause: nonEmptyString(turnCandidate.terminal.cause)! } : {}),
          ...(nonEmptyString(turnCandidate.terminal.detail) !== undefined ? { detail: nonEmptyString(turnCandidate.terminal.detail)! } : {}),
        }
      : undefined
    const key = isRecord(turnCandidate.key)
      ? {
          ...(nonEmptyString(turnCandidate.key.localSessionId) !== undefined ? { localSessionId: nonEmptyString(turnCandidate.key.localSessionId)! } : {}),
          ...(nonEmptyString(turnCandidate.key.remoteSessionId) !== undefined ? { remoteSessionId: nonEmptyString(turnCandidate.key.remoteSessionId)! } : {}),
          ...(finiteNonNegativeInteger(turnCandidate.key.generation) !== null ? { generation: finiteNonNegativeInteger(turnCandidate.key.generation)! } : {}),
          ...(finiteNonNegativeInteger(turnCandidate.key.turnId) !== null ? { turnId: finiteNonNegativeInteger(turnCandidate.key.turnId)! } : {}),
        }
      : undefined
    turn = {
      ...(nonEmptyString(turnCandidate.phase) !== undefined ? { phase: nonEmptyString(turnCandidate.phase)! } : {}),
      ...(terminal !== undefined ? { terminal } : {}),
      ...(key !== undefined ? { key } : {}),
    }
  }
  const generation = finiteNonNegativeInteger(raw.generation)
  return {
    ...(nonEmptyString(raw.source) !== undefined ? { source: nonEmptyString(raw.source)! } : {}),
    ...(nonEmptyString(raw.periId) !== undefined ? { periId: nonEmptyString(raw.periId)! } : {}),
    ...(generation !== null ? { generation } : {}),
    ...(turn !== undefined ? { turn } : {}),
    ...(typeof raw.turnInFlight === 'boolean' ? { turnInFlight: raw.turnInFlight } : {}),
    ...(typeof raw.turnInFlightAnomaly === 'boolean' ? { turnInFlightAnomaly: raw.turnInFlightAnomaly } : {}),
    ...(isRecord(raw.sequence) ? { sequence: Object.freeze({ ...raw.sequence }) } : {}),
    ...(typeof raw.replayLoading === 'boolean' ? { replayLoading: raw.replayLoading } : {}),
    // 后端 `AgentRuntimeState::last_error: Option<String>`。
    ...(typeof raw.lastError === 'string' || raw.lastError === null ? { lastError: raw.lastError } : {}),
  }
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
  const replayJournalStatus: PersistedSessionLoadResult['replayJournalStatus'] = record.replayJournalStatus === 'imported'    || record.replayJournalStatus === 'reconciled'
    || record.replayJournalStatus === 'already-present'
    || record.replayJournalStatus === 'already-imported'
    || record.replayJournalStatus === 'local-authoritative'
    || record.replayJournalStatus === 'incomplete-not-imported'
    ? record.replayJournalStatus
    : 'metadata-unavailable'
  const turn = normalizeColdMountTurnSnapshot(record.turn)

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
    replayJournalStatus,
    authority: record.authority === 'local-journal'
      || record.authority === 'recovery-import'
      ? record.authority
      : replayJournalStatus === 'local-authoritative'
        ? 'local-journal'
        : replayJournalStatus === 'imported'
          || replayJournalStatus === 'already-imported'
          || replayJournalStatus === 'already-present'
          || replayJournalStatus === 'reconciled'
          || (replayJournalStatus === 'incomplete-not-imported'
            && (finiteNonNegativeInteger(record.canonicalRevision) ?? 0) > 0)
          ? 'recovery-import'
          : 'empty',
    journalCoverage: record.journalCoverage === 'local-observed'
      || record.journalCoverage === 'unverified-import'
      || record.journalCoverage === 'corrupt'
      ? record.journalCoverage
      : replayJournalStatus === 'local-authoritative'
        ? 'local-observed'
        : replayJournalStatus === 'imported'
          || replayJournalStatus === 'already-imported'
          || replayJournalStatus === 'already-present'
          || replayJournalStatus === 'reconciled'
          || (replayJournalStatus === 'incomplete-not-imported'
            && (finiteNonNegativeInteger(record.canonicalRevision) ?? 0) > 0)
          ? 'unverified-import'
          : 'empty',
    collection: {
      complete: typeof (record.collection as Record<string, unknown> | undefined)?.complete === 'boolean'
        ? (record.collection as Record<string, unknown>).complete as boolean
        : valid ? complete! : false,
      truncated: typeof (record.collection as Record<string, unknown> | undefined)?.truncated === 'boolean'
        ? (record.collection as Record<string, unknown>).truncated as boolean
        : valid ? truncated! : false,
      droppedCount: finiteNonNegativeInteger((record.collection as Record<string, unknown> | undefined)?.droppedCount)
        ?? (valid ? droppedCount! : 0),
    },
    import: (() => {
      const candidate = record.import && typeof record.import === 'object'
        ? record.import as Record<string, unknown>
        : undefined
      if (typeof candidate?.importId !== 'string' || candidate.importId.length === 0) return undefined
      if (candidate.trust !== 'unverified') return undefined
      if (candidate.status !== 'imported' && candidate.status !== 'already-imported') return undefined
      return {
        importId: candidate.importId,
        status: candidate.status,
        trust: 'unverified' as const,
      }
    })(),
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics : [],
    // #110 F4：冷挂载 turn 快照级联透传（此前被归一化器丢弃，冷挂载链路拿不到
    // turn 事实，状态条只能退回不完整的本地推断）。缺失时不留空键。
    ...(turn !== undefined ? { turn } : {}),
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

/** #98：session/fork 请求载荷——childSource 命名权在本地身份层，由调用方提供。 */
export interface ForkSessionPayload {
  source: string
  childSource: string
}

/** #53：空态选择器探测载荷——agent 维度，与具体会话无关。 */
export interface ProbeAgentSelectorsPayload {
  agentId: string
  cwd?: string
  workspaceId?: string
}

/** 探测结果：configOptions 原始 envelope + 后端解析好的模型面摘要。空 configOptions 合法。 */
export interface AgentSelectorsSnapshot {
  configOptions?: readonly unknown[]
  modes?: unknown
  modelSurface?: { kind: 'config_option' | 'models_state' | 'none'; configId?: string }
  modelChoices?: readonly string[]
  currentModel?: string | null
}

export function createSessionClient(transport: ClientTransport) {
  return {
    newSession: (payload: NewSessionPayload): Promise<unknown> => transport.invoke('new_session', payload),
    closeSession: (payload: CloseSessionPayload): Promise<unknown> => transport.invoke('close_session', payload),
    // #53：起一次性会话读 Agent 广告的选择器面后即弃；空 configOptions 合法。
    probeAgentSelectors: (payload: ProbeAgentSelectorsPayload): Promise<AgentSelectorsSnapshot> =>
      transport.invoke('probe_agent_selectors', payload) as Promise<AgentSelectorsSnapshot>,
    // #98：fork 消费者——后端仅在协商快照判定 usable 时发送 session/fork raw
    // RPC；不可用时稳定报 session_fork_unavailable，不伪造 child identity。
    forkSession: (payload: ForkSessionPayload): Promise<unknown> =>
      transport.invoke('session_fork', payload),
    loadPersistedSession: (payload: LoadPersistedSessionPayload): Promise<PersistedSessionLoadResult> =>
      transport.invoke('load_persisted_session', payload).then(normalizePersistedSessionLoadResult),
    listPersistedSessions: (): Promise<PersistedSessionSummary[]> =>
      transport.invoke('list_persisted_sessions').then(raw => normalizePersistedSessions(raw)),
    exportSession: (payload: ExportSessionPayload): Promise<unknown> => transport.invoke('export_session', payload),
    cancelPrompt: (payload: CancelPromptPayload): Promise<unknown> => transport.invoke('cancel_prompt', payload),
  }
}

export type SessionClient = ReturnType<typeof createSessionClient>
