/**
 * Workbench session host: binding, canonical replay/live reconciliation and
 * generation ownership. Stateless response/snapshot adapters live alongside
 * this module; they cannot mutate lifecycle state or access persistence.
 */
import { createSessionResponseEnvelope, sessionResponseProjectionKey } from './sessionResponseProjection.ts'
import { messageSnapshotToWorkbenchEnvelopes } from './messageSnapshotProjection.ts'
import type { Session } from '../../identityStore.ts'
import { toCanonicalOwnerKey, validateCanonicalEvent, type CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { parseTurnUnitPayload } from '../../domains/events/canonicalUnit.ts'
import { resolveGenerationLedgerTerminalReason, type GenerationLedgerTerminalReason } from '../../domains/workbench/generationLedgerSummary.ts'
import {
  canonicalBatchChunksOf,
  canonicalBatchSpanOf,
  isCanonicalBatchDeltaType,
} from '../../infrastructure/events/canonicalEventBatch.ts'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal, type CanonicalTurnBoundaryEvent } from '../../domains/events/canonicalTurnDuration.ts'
import { createWorkbenchEnvelope, migrateWorkbenchEnvelope, type JsonValue, type SessionEvent, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import { normalizeAgentEvent } from '../../domains/workbench/normalizers/agentEventNormalizer.ts'
import { createWorkbenchDocument, projectWorkbench, reduceWorkbenchEvent, type WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'
import { reduceGenerationActivity } from '../../domains/activity/generationStateMachine.ts'
import { createSessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import { createZustandWorkbenchAppearanceStore } from '../../domains/workbench/zustandWorkbenchAppearanceStore.ts'
import { IS_TAURI, isBrowserMockRuntime } from '../../infrastructure/tauri/env.ts'
import { tauriCanonicalEventRepository } from '../../infrastructure/events/canonicalEventRepository.ts'
import { subscribePluginEvents } from '../../infrastructure/events/pluginEventBus.ts'
import { messageStorageKey, parseMessageSnapshot } from '../../components/chat/messagePersistence.ts'
import type { Message } from '../../components/chat/messageTypes.ts'
import { resolveRuntimeErrors } from '../../runtimeError.ts'
import { createAgentWorkbenchCommandFacade, type ResolvedWorkbenchInteraction } from './agentWorkbenchCommands.ts'
import {
  findConfigOption,
  sessionResponseObject,
  type PromptFailureMetadata,
  type SessionResponseObject,
} from '../../infrastructure/acp/chatContracts.ts'
import type { SessionConfigOption } from '../../domains/workbench/session/sessionSurface.ts'
import { getCanonicalEventFeed, subscribeWindowTerminalFrames, type CanonicalTerminalSignal } from '../../infrastructure/events/canonicalEventFeed.ts'

export interface AgentWorkbenchSessionRuntimeDependencies {
  loadAll(ownerKey: string): Promise<readonly unknown[]>
  subscribe(listener: (event: unknown) => void): () => void
  /**
   * 终帧 window 广播兜底订阅。主轨是 per-source IPC Channel（`send_message_streaming`
   * 注册、终帧 take 注销），而 `pylon:done`/`pylon:error` 的 window 广播**没有任何
   * 其他消费者**——Channel 一旦丢失（注册被清、或前端 `activeStreams` 条目被移除）
   * 终帧就没有第二次投递。这里订阅同一条广播，让终帧至少有一条不依赖 Channel 注册
   * 的路。返回退订函数。
   */
  listenTerminalFallback(listener: (signal: CanonicalTerminalSignal) => void): () => void
  commands?: Partial<import('./agentWorkbenchCommands.ts').AgentWorkbenchCommandDependencies>
}

/**
 * Fields that define the Workbench binding. Presentation-only Session metadata
 * (name, lastReplyAt, autoName, etc.) must not rebuild the live document.
 * Workspace and remote binding metadata are updated through their own reload
 * seams; they are not document identity and must not reset an active stream.
 */
export function workbenchSessionBindingKey(session: Session | undefined): string {
  if (!session) return 'unbound'
  return [
    session.id,
    session.source,
    session.agentId,
    session.profileId,
  ].join('\u0000')
}

function normalizeCanonicalRowToEnvelopes(
  event: CanonicalConversationEvent,
  raw: unknown,
  sequence: number,
  eventId: string,
  coverage?: readonly [number, number],
): readonly WorkbenchEventEnvelope[] {
  const provider = event.provenance?.provider ?? event.owner.agentId
  const optimistic = isOptimisticUserEvent(raw)
  const normalized = normalizeAgentEvent(raw, {
    provider,
    sessionId: event.owner.localSessionId,
    sourceId: eventId,
    sequence,
    recordedAt: event.receivedAt,
    occurredAt: event.occurredAt,
    agentId: event.owner.agentId,
    provenance: optimistic
      ? { origin: 'optimistic-local', trust: 'unverified', provider }
      : event.provenance ?? { origin: 'migration', trust: 'unverified', provider },
  })
  return normalized.events.map((envelope, index) => Object.freeze({
    ...envelope,
    eventId: normalized.events.length === 1 ? eventId : envelope.eventId,
    identity: Object.freeze({ ...event.identity, ...envelope.identity }),
    // coverage 是**行级**幂等键（投影器按"跨度是否已覆盖"整条丢弃），所以一行只能盖一条：
    // 一个 config 包会产出多条语义事件（options + 当前 mode/model），若全都盖 [seq,seq]，
    // 投影器会把同行的其余事件当成重复丢掉 —— 重放后就只剩一条，中控与配置面板各说各话。
    // 其余事件按 eventId 幂等（同一次重放不会重复入账）。
    ...(coverage && index === 0 ? { coverage: Object.freeze([coverage[0], coverage[1]]) as readonly [number, number] } : {}),
  }))
}

/**
 * #81 L1：sink 的 batch 行（typedPayload.seqSpan + rawPayload = 原始 chunk 数组）
 * 按跨度逐 chunk 展开重建：sub-envelope 的 sequence = seqSpan[0]+i、eventId =
 * owner#(seqSpan[0]+i)，coverage = [sequence, sequence]（journal 权威）。
 * 形状损坏的 batch 行退回单行归一（产出 event.unknown，raw 不丢）。
 */
function expandCanonicalBatchRow(event: CanonicalConversationEvent): readonly WorkbenchEventEnvelope[] {
  const ownerKey = toCanonicalOwnerKey(event.owner)
  const chunks = canonicalBatchChunksOf(event)
  if (!chunks) {
    return normalizeCanonicalRowToEnvelopes(event, event.rawPayload, event.sequence, event.eventId, [event.sequence, event.sequence])
  }
  const first = canonicalBatchSpanOf(event)![0]
  return chunks.flatMap((raw, index) => {
    const sequence = first + index
    const eventId = `${ownerKey}#${sequence}`
    return normalizeCanonicalRowToEnvelopes(event, raw, sequence, eventId, [sequence, sequence])
  })
}

/**
 * #81 L2：turn.unit 单元行按 segments 展开为 segment 级信封——delta-run 段重建为
 * message/reasoning delta 信封（coverage = [seqStart, seqEnd]，journal 权威跨度，
 * appliedRanges 覆盖判断据此与逐 chunk 行互斥）；整行 segment 递归走既有单行路径。
 * 形状损坏的单元行退回单行归一（产出 event.unknown，不丢证据）。
 *
 * **段级隔离**：单个整行 segment 不可读（形状损坏/校验失败）时，只把**该段**退化为
 * `event.unknown`（raw 保留、coverage 取该段自身跨度），其余段照常展开——一个坏段
 * 不得吞掉整轮的正文内容（#81 回归的放大源：形状不匹配曾使整轮塌成一条 unknown）。
 */
function expandCanonicalUnitRow(event: CanonicalConversationEvent, ownerKey: string): readonly WorkbenchEventEnvelope[] {
  const payload = parseTurnUnitPayload(event)
  if (!payload) {
    return normalizeCanonicalRowToEnvelopes(event, event.rawPayload, event.sequence, event.eventId, [event.sequence, event.sequence])
  }
  const provider = event.provenance?.provider ?? event.owner.agentId
  const provenance = event.provenance ?? { origin: 'migration' as const, trust: 'unverified' as const, provider }
  return payload.segments.flatMap((segment, index) => {
    if (segment.kind === 'event') {
      const inner = canonicalRowToWorkbench(segment.event)
      if (inner !== undefined && inner.length > 0) return inner
      // 段级隔离：该段退化为单行归一。eventId 缺失时用 `<unit>#segment-<i>` 保唯一，
      // 否则两条坏段会共用同一 id 而被 appliedEventIds 去重吃掉一条。
      const innerEventId = segment.event.eventId
      return normalizeCanonicalRowToEnvelopes(
        segment.event,
        segment.event.rawPayload,
        segment.event.sequence,
        typeof innerEventId === 'string' && innerEventId.length > 0 ? innerEventId : `${event.eventId}#segment-${index}`,
        [segment.event.sequence, segment.event.sequence],
      )
    }
    const seqEnd = segment.seqEnd
    const part: { kind: 'text' | 'markdown'; text: string } = { kind: segment.markdown ? 'markdown' : 'text', text: segment.text }
    return [Object.freeze(createWorkbenchEnvelope({
      sessionId: event.owner.localSessionId,
      sequence: seqEnd,
      recordedAt: segment.occurredAt,
      occurredAt: segment.occurredAt,
      source: { provider, sourceId: `${ownerKey}#${seqEnd}` },
      identity: segment.identity ?? {},
      provenance,
      coverage: [segment.seqStart, segment.seqEnd],
      event: segment.eventType === 'assistant.text.delta'
        ? { type: 'message.delta', role: 'assistant', parts: [part] }
        : { type: 'reasoning.delta', parts: [part] },
    }))]
  })
}

function canonicalRowToWorkbench(row: unknown): readonly WorkbenchEventEnvelope[] | undefined {
  if (!row || typeof row !== 'object' || !('owner' in row) || !('rawPayload' in row) || !('eventType' in row)) return undefined
  if (validateCanonicalEvent(row).length > 0) return []
  const event = row as CanonicalConversationEvent
  if (event.eventType === 'turn.unit') return expandCanonicalUnitRow(event, toCanonicalOwnerKey(event.owner))
  if (isCanonicalBatchDeltaType(event.eventType)) return expandCanonicalBatchRow(event)
  return normalizeCanonicalRowToEnvelopes(event, event.rawPayload, event.sequence, event.eventId, [event.sequence, event.sequence])
}

function isOptimisticUserEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const envelope = raw as Record<string, unknown>
  const params = envelope.params && typeof envelope.params === 'object' ? envelope.params as Record<string, unknown> : undefined
  const updateValue = envelope.update ?? params?.update
  if (!updateValue || typeof updateValue !== 'object') return false
  const update = updateValue as Record<string, unknown>
  const meta = update._meta && typeof update._meta === 'object' ? update._meta as Record<string, unknown> : undefined
  return update.sessionUpdate === 'user_message_chunk' && meta?.pylonOptimisticUser === true
}

function toWorkbenchEnvelopes(value: unknown): readonly WorkbenchEventEnvelope[] {
  const canonical = canonicalRowToWorkbench(value)
  if (canonical !== undefined) return canonical
  const migrated = migrateWorkbenchEnvelope(value)
  return migrated.ok ? [migrated.value] : []
}

function canonicalBoundaryRows(rows: readonly unknown[]): CanonicalTurnBoundaryEvent[] {
  return rows.filter((row): row is CanonicalTurnBoundaryEvent => (
    isRecord(row)
    && typeof row.sequence === 'number'
    && typeof row.eventType === 'string'
  ))
}

function canonicalDurationFromRows(rows: readonly unknown[]) {
  return deriveCanonicalTurnDuration(canonicalBoundaryRows(rows))
}

function canonicalHasTerminalFromRows(rows: readonly unknown[]): boolean {
  return hasCanonicalTurnTerminal(canonicalBoundaryRows(rows))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withJournalDiagnostic(document: WorkbenchDocument, count: number): WorkbenchDocument {
  const message = `canonical journal 有 ${count} 条事件无法迁移`
  return {
    ...document,
    diagnostics: [
      ...document.diagnostics.filter(item => item.code !== 'canonical.journal.malformed'),
      {
        code: 'canonical.journal.malformed', message, level: 'error',
        eventId: `canonical-load:${document.sessionId}`, sequence: document.revision,
        data: { malformedCount: count },
      },
    ],
  }
}

/**
 * 终帧 window 广播兜底：订阅 `pylon:done`/`pylon:error` 的窗口事件。后端
 * `finalize_response`/`publish_prompt_failure` 两条收尾路径都无条件走
 * `emit_event_all` 广播，所以这条路与 Channel 是否存在无关。
 */
function defaultTerminalFallbackListener(listener: (signal: CanonicalTerminalSignal) => void): () => void {
  return subscribeWindowTerminalFrames(listener)
}

function defaultDependencies(): AgentWorkbenchSessionRuntimeDependencies {
  return {
    loadAll: ownerKey => {
      // #81 L2：投影读走 compact（单元 + 未覆盖行）；被覆盖行不再传输/解析。
      if (IS_TAURI && !isBrowserMockRuntime()) return tauriCanonicalEventRepository().loadAllPreferUnits(ownerKey)
      // Browser snapshots are keyed by local Session.id, not the JSON owner key.
      // bind() adds that compatibility source once it has the concrete Session.
      return Promise.resolve([])
    },
    subscribe: listener => subscribePluginEvents(listener),
    listenTerminalFallback: defaultTerminalFallbackListener,
  }
}

/** A write Pylon performed itself and the provider confirmed. */
export type LocalSessionFact =
  | { readonly kind: 'model'; readonly model: string }
  | { readonly kind: 'mode'; readonly mode: string }
  | { readonly kind: 'option'; readonly id: string; readonly value: string | boolean }

/** SessionConfigOption is JSON by construction; its readonly index signature is just
 * what stops TS from unifying it with JsonValue on its own. */
function withOptionValue(
  options: readonly SessionConfigOption[],
  index: number,
  value: string | boolean,
): readonly JsonValue[] {
  return options.map((option, at) => (at === index ? { ...option, value } : option)) as unknown as readonly JsonValue[]
}

/** The option a semantic resolves to (shared ACP classifier), carrying a new value. */
function withSemanticValue(
  options: readonly SessionConfigOption[],
  semantic: 'model' | 'mode',
  value: string,
): readonly JsonValue[] | undefined {
  const index = options.findIndex(option => findConfigOption([option], semantic) !== undefined)
  return index < 0 ? undefined : withOptionValue(options, index, value)
}

function localSessionFactEvent(fact: LocalSessionFact, document: WorkbenchDocument): SessionEvent | undefined {
  const options = document.session.options
  // The control center reads `session.mode` / `session.model` while the config panel
  // reads the option's `value`, and nothing synchronises the two fields — so a local
  // write has to fill both, or the two surfaces disagree (after a reload only the
  // provider's advertisement survives and the control center falls back).
  if (fact.kind === 'model') {
    const merged = withSemanticValue(options, 'model', fact.model)
    return { type: 'session.model-updated', model: fact.model, ...(merged ? { options: merged } : {}) }
  }
  if (fact.kind === 'mode') {
    const merged = withSemanticValue(options, 'mode', fact.mode)
    return { type: 'session.mode-updated', mode: fact.mode, ...(merged ? { options: merged } : {}) }
  }
  // `session.config-updated` replaces the whole option list, so a single-option
  // write carries the merged list — the other options are not ours to drop.
  const index = options.findIndex(option => option.id === fact.id)
  if (index < 0) return undefined
  return { type: 'session.config-updated', options: withOptionValue(options, index, fact.value) }
}

export function createAgentWorkbenchSessionRuntime(dependencies: Partial<AgentWorkbenchSessionRuntimeDependencies> = {}) {
  const defaults = defaultDependencies()
  const loadAll = dependencies.loadAll ?? defaults.loadAll
  const subscribe = dependencies.subscribe ?? defaults.subscribe
  const listenTerminalFallback = dependencies.listenTerminalFallback ?? defaults.listenTerminalFallback
  const runtime = createWorkbenchRuntime({
    sessionId: null, status: 'idle', messages: [],
    generating: false, generationStart: 0, tokenCount: 0, summary: null, tasks: [],
    availableModels: [], activeModel: '', availableModes: [], activeMode: '', canAttach: false,
    promptImage: false, error: null, document: createWorkbenchDocument(''),
  })
  const appearance = createZustandWorkbenchAppearanceStore()
  const sessionUi = createSessionUiStore()
  let boundSessionId: string | undefined
  let boundProvider = 'acp'
  let boundSessionBindingKey: string | undefined
  const commands = createAgentWorkbenchCommandFacade({
    ...dependencies.commands,
    // P52 D4：controller React 状态面死亡——乐观 echo 撤销只剩 document 侧投影。
    optimisticDocument: projectOptimisticUser,
    rejectOptimisticDocument: rejectOptimisticUser,
    resolveConfigOption(sessionId, key) {
      if (boundSessionId !== sessionId) return undefined
      const option = runtime.getSnapshot().document?.session.options.find(item => item.id === key)
      return option ? { value: option.value, version: option.version } : undefined
    },
    resolveInteraction(sessionId, interactionId): ResolvedWorkbenchInteraction | undefined {
      const snapshot = runtime.getSnapshot()
      if (boundSessionId !== sessionId) return undefined
      const interaction = snapshot.document?.interactions.find(item => item.id === interactionId && item.status === 'requested')
      const request = interaction?.request
      if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined
      const candidate = request as { kind?: unknown; identity?: Record<string, unknown> }
      const identity = candidate.identity
      if (!identity || typeof candidate.kind !== 'string') return undefined
      if (typeof identity.provider !== 'string' || typeof identity.agentId !== 'string'
        || typeof identity.requestId !== 'string' || typeof identity.sessionId !== 'string'
        || typeof identity.clientGeneration !== 'number') return undefined
      return {
        kind: candidate.kind,
        revision: interaction.sequence,
        identity: {
          provider: identity.provider,
          agentId: identity.agentId,
          requestId: identity.requestId,
          sessionId: identity.sessionId,
          ...(typeof identity.toolCallId === 'string' ? { toolCallId: identity.toolCallId } : {}),
          clientGeneration: identity.clientGeneration,
        },
      }
    },
  })
  let ownerKey: string | undefined
  let source: string | undefined
  let generation = 0
  let turnEpoch = 0
  let loading = false
  let buffered: WorkbenchEventEnvelope[] = []
  let malformedCount = 0
  let destroyed = false
  // A canonical replay can finish after this runtime's initial bind. Keep a
  // separate, coalesced refresh seam so the same binding key does not make a
  // later durable tool terminal event invisible (bind itself is intentionally
  // idempotent for ordinary Session metadata updates).
  let refreshInFlight: Promise<void> | null = null
  // Every canonical read gets a monotonically increasing token. A bind read
  // that started before a refresh (or before a new bind) must not publish its
  // older snapshot after the newer read has won the race.
  let canonicalReadEpoch = 0
  /** Responses from the atomic empty-state create transaction can arrive
   * before React has rebound the Workbench to the newly-added local Session.
   * Keep them keyed by local Session.id until that bind completes. */
  const pendingSessionResponses = new Map<string, SessionResponseObject[]>()
  const appliedSessionResponseKeys = new Map<string, Set<string>>()
  const transientSequenceBySource = new Map<string, number>()
  const pendingOptimisticBySource = new Map<string, Array<{
    clientMessageId: string
    content: string
    priorCanonicalMatches: number
    envelope: WorkbenchEventEnvelope
  }>>()

  /** 空态创建路径（会话已 select、尚未 bind）在发送入口只启动了回合时钟、没有文档投影：
   *  source → 该 source 上"仅时钟起点"的 clientMessageId。发送被拒时据此精确撤销，
   *  不误伤同 source 上由外部客户端 echo 启动的回合（issue #68 配套）。 */
  const clockOnlyStarts = new Map<string, string>()

  const updateRuntimeState = (patch: Parameters<typeof runtime.update>[0]) => {
    const current = runtime.getSnapshot()
    if (!current.document) {
      runtime.update(patch)
      return
    }
    const { document: _ignoredDocument, ...generationPatch } = patch
    runtime.applyDocument(current.document, {
      ownerKey,
      generation,
      preserveGeneration: false,
      generationPatch,
    })
  }

  // P52 D3 TurnClock —— 生成时钟唯一主人（source 隔离，事件驱动）。
  // 回合起点 = 发送入口（乐观投影）；终态 = feed 终帧（done/error/cancelled）
  // 或 canonical 终态证据（bind/refresh 时 journal 已终态）；拒绝发送 = 回滚。
  // bind 换源不销毁旧 source 的时钟（切回可恢复指示器，等价原 controller 的
  // source-scoped runtime）；终态幂等：首个终态 wins（K03），后续只忽略。
  // lastTokenAt 由每条该 source 的 canonical envelope 刷新（touch）——projector
  // 的 append-delta 不更新 message.time，文档派生的 lastTokenAt 会停滞。
  interface TurnClockEntry {
    generationStart: number
    lastTokenAt: number
    terminal: boolean
  }
  const turnClocks = new Map<string, TurnClockEntry>()
  /**
   * 最近一次 canonical 重载读到的 #99 账本终态，按 source 隔离。
   *
   * 单独存而不是只用作 refresh 的入参：`refresh` 对同 source 会去重（`refreshInFlight`），
   * 一次早于终态收敛发起的重载可能与携带账本的那次同窗，入参会被去重丢掉。按 source
   * 保留最近观测到的终态即可让在途的那次重载用上它。
   *
   * **新回合起点必须清空**（见 `turnClockStart`）：否则上一回合的终态会被当成本回合的
   * 证据，把在途的新回合判成已收敛。
   */
  const ledgerTerminalBySource = new Map<string, GenerationLedgerTerminalReason>()

  const turnClockStart = (targetSource: string, at: number): void => {
    turnClocks.set(targetSource, { generationStart: at, lastTokenAt: at, terminal: false })
    ledgerTerminalBySource.delete(targetSource)
  }

  /** 每条 live envelope 刷新活性；返回 undefined = 无活动回合（不写 patch）。 */
  const turnClockTouch = (targetSource: string, at: number): number | undefined => {
    const entry = turnClocks.get(targetSource)
    if (!entry || entry.terminal) return undefined
    entry.lastTokenAt = Math.max(entry.lastTokenAt, at)
    return entry.lastTokenAt
  }

  /** 终帧到达：写 live 终态摘要（elapsed = 终点 - 本进程观察到的起点）。 */
  const turnClockTerminal = (targetSource: string, reason: 'done' | 'cancelled' | 'error', at: number, failure?: PromptFailureMetadata): void => {
    const entry = turnClocks.get(targetSource)
    if (!entry || entry.terminal) return
    entry.terminal = true
    // 回合已有终态："仅时钟起点"的记账已完成使命。
    clockOnlyStarts.delete(targetSource)
    if (source !== targetSource) return
    updateRuntimeState({
      summary: {
        elapsedMs: Math.max(0, at - entry.generationStart),
        tokenCount: runtime.getSnapshot().tokenCount,
        completedFrame: '',
        reason,
        ...(failure ? { failure } : {}),
        durationSource: 'live-monotonic',
        durationAvailable: true,
      },
    })
  }

  /** 发送被拒绝：活动回合回滚（后续帧不得复活指示器）。 */
  const turnClockRollback = (targetSource: string): void => {
    const entry = turnClocks.get(targetSource)
    if (!entry || entry.terminal) return
    turnClocks.delete(targetSource)
  }

  /** bind/refresh 发现 journal 已终态：封存时钟但不写摘要——展示由 displayOnly
   * 恢复路径承担（elapsed 用 canonical 时长，不含离开会话的挂钟时间）。 */
  const settleTurnClockFromDocument = (targetSource: string, hasTerminal: boolean): void => {
    if (!hasTerminal) return
    const entry = turnClocks.get(targetSource)
    if (!entry || entry.terminal) return
    entry.terminal = true
  }

  /** bind/refresh 后把活动时钟写回快照（覆盖投影间隙的 Date.now() 回退）。 */
  const reconcileTurnClock = (targetSource: string): void => {
    const entry = turnClocks.get(targetSource)
    if (!entry || entry.terminal) return
    updateRuntimeState({
      generating: true,
      generationStart: entry.generationStart,
      lastTokenAt: entry.lastTokenAt,
      summary: null,
    })
  }

  function projectOptimisticUser(targetSource: string, content: string, clientMessageId: string): void {
    if (destroyed) return
    // P52 D3：回合起点属于**发送入口**，不属于 bind。空态创建路径
    // （ControlCenter.createEmptySession → selectSession → send 同一 tick）下会话已被
    // 选中但 bind 尚未完成；若在这里因"未绑定"早退，终帧到达时 turnClocks 没有该 source
    // 的条目，turnClockTerminal 会直接 return ⇒ 终态摘要永不发布（issue #68）。
    // 故时钟先无条件建立/覆盖；文档投影与快照 patch 仍严格限于已绑定的本 source。
    const now = Date.now()
    turnClockStart(targetSource, now)
    if (targetSource !== source || !boundSessionId) {
      // 仅时钟起点：文档投影要等 bind 之后由 canonical echo 承担。
      clockOnlyStarts.set(targetSource, clientMessageId)
      return
    }
    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(targetSource)
    const existing = pendingOptimisticBySource.get(targetSource) ?? []
    if (existing.some(item => item.clientMessageId === clientMessageId)) return
    const envelope = createWorkbenchEnvelope({
      eventId: `optimistic:${targetSource}:${clientMessageId}`,
      sessionId: targetSource,
      sequence: current.revision + existing.length + 1,
      recordedAt: new Date(now).toISOString(),
      source: { provider: 'local-user', sourceId: clientMessageId },
      identity: { interactionId: clientMessageId },
      provenance: { origin: 'optimistic-local', trust: 'unverified' },
      event: { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: content }] },
    })
    existing.push({
      clientMessageId,
      content,
      priorCanonicalMatches: current.messages.filter(message => message.role === 'user'
        && message.content === content && message.optimistic !== true).length
        + existing.filter(item => item.content === content).length,
      envelope,
    })
    pendingOptimisticBySource.set(targetSource, existing)
    turnEpoch += 1
    runtime.applyDocument(reduceWorkbenchEvent(current, envelope), { ownerKey, generation, turnEpoch, terminalFence: null, preserveGeneration: true })
    updateRuntimeState({
      generating: true,
      generationStart: now,
      lastTokenAt: now,
      generationPhase: { kind: 'thinking' },
      generationActivity: reduceGenerationActivity(undefined, { type: 'start', at: now }),
      summary: null,
    })
  }

  function rejectOptimisticUser(targetSource: string, clientMessageId: string): void {
    const pending = pendingOptimisticBySource.get(targetSource) ?? []
    const rejected = pending.find(item => item.clientMessageId === clientMessageId)
    if (!rejected) {
      // 空态路径（尚未 bind）没有文档投影可撤：projectOptimisticUser 只记了"仅时钟起点"。
      // 拒绝时同样必须撤销时钟，否则 bind 后的 reconcileTurnClock 会把从未发出的回合
      // 复活成常驻 spinner（issue #68 配套）。
      if (clockOnlyStarts.get(targetSource) === clientMessageId) {
        clockOnlyStarts.delete(targetSource)
        turnClockRollback(targetSource)
      }
      return
    }
    const remaining = pending.filter(item => item !== rejected)
    if (remaining.length > 0) pendingOptimisticBySource.set(targetSource, remaining)
    else pendingOptimisticBySource.delete(targetSource)
    if (source !== targetSource) return
    const current = runtime.getSnapshot().document
    if (!current) return
    const document = {
      ...current,
      appliedEventIds: current.appliedEventIds.filter(id => id !== rejected.envelope.eventId),
      timeline: current.timeline.filter(entry => entry.eventId !== rejected.envelope.eventId),
      messages: current.messages.filter(message => !(message.optimistic
        && message.identity.interactionId === clientMessageId)),
    }
    runtime.replaceDocument(document, { ownerKey, generation, sessionId: boundSessionId ?? null })
    // P52 D3：发送被拒 = 回合回滚；若无其它在途乐观回合，时钟一并撤销，
    // 后续迟到帧不得经 updateRuntimeState 复活指示器（原 controller 侧由
    // reject-optimistic-user reducer 承担）。
    if (remaining.length === 0) turnClockRollback(targetSource)
    const existingActivity = runtime.getSnapshot().generationActivity
    updateRuntimeState({
      generating: remaining.length > 0 || document.messages.some(message => message.running),
      generationPhase: remaining.length > 0 ? { kind: 'thinking' } : undefined,
      generationActivity: remaining.length > 0
        ? existingActivity ?? reduceGenerationActivity(undefined, { type: 'start', at: Date.now() })
        : undefined,
    })
  }

  const withPendingOptimistic = (targetSource: string, base: WorkbenchDocument): WorkbenchDocument => {
    const pending = pendingOptimisticBySource.get(targetSource) ?? []
    if (pending.length === 0) return base
    let document = base
    const remaining = [] as typeof pending
    for (const item of pending) {
      const canonicalMatches = document.messages.filter(message => message.role === 'user'
        && message.content === item.content && message.optimistic !== true).length
      if (canonicalMatches > item.priorCanonicalMatches) continue
      const next = reduceWorkbenchEvent(document, item.envelope)
      if (next.messages.some(message => message.optimistic
        && message.identity.interactionId === item.clientMessageId)) remaining.push(item)
      document = next
    }
    if (remaining.length > 0) pendingOptimisticBySource.set(targetSource, remaining)
    else pendingOptimisticBySource.delete(targetSource)
    return document
  }

  const enqueueSessionResponse = (response: SessionResponseObject, targetSessionId: string): void => {
    if (destroyed || !boundSessionId || !source || targetSessionId !== boundSessionId) return
    const key = sessionResponseProjectionKey(response)
    const applied = appliedSessionResponseKeys.get(targetSessionId) ?? new Set<string>()
    if (applied.has(key)) return
    applied.add(key)
    appliedSessionResponseKeys.set(targetSessionId, applied)

    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(source)
    const bufferedMax = buffered.reduce((max, item) => Math.max(max, item.sequence), 0)
    const previousTransient = transientSequenceBySource.get(source) ?? 0
    const sequence = Math.max(current.revision, bufferedMax, previousTransient) + 1
    transientSequenceBySource.set(source, sequence)
    const envelope = createSessionResponseEnvelope(source, boundProvider, response, sequence)
    if (loading) {
      buffered.push(envelope)
      return
    }
    runtime.applyDocument(reduceWorkbenchEvent(current, envelope), { ownerKey, generation, preserveGeneration: true })
  }

  const applySessionResponse = (response: unknown, targetSessionId?: string): void => {
    if (destroyed) return
    const normalized = sessionResponseObject(response)
    const target = targetSessionId?.trim() || boundSessionId
    if (!target) return
    if (boundSessionId && (target === boundSessionId || target === source)) {
      enqueueSessionResponse(normalized, boundSessionId)
      return
    }
    const pending = pendingSessionResponses.get(target) ?? []
    pending.push(normalized)
    pendingSessionResponses.set(target, pending)
  }

  /**
   * Project a locally-confirmed write into the document as a canonical fact.
   *
   * Two different reasons make this necessary, and both follow from the same
   * rule — the document is the single source of truth the selectors read:
   *  - a provider may accept a write without announcing it (Hermes never emits
   *    `current_mode_update`), so nothing else would publish the new value;
   *  - replaying a synthetic session response instead is not an option: its
   *    option list is response-shaped, and the projector replaces the whole
   *    `session.options` surface with it. Doing that for a model switch silently
   *    dropped the mode and reasoning catalogues, so the control center fell back
   *    to its local tables (and the reasoning write was rejected for good).
   * A fact states only the value that changed, so the rest of the surface stays.
   */
  const applyLocalSessionFact = (fact: LocalSessionFact, targetSessionId?: string): void => {
    if (destroyed || !boundSessionId || !source) return
    const target = targetSessionId?.trim()
    if (target && target !== boundSessionId && target !== source) return
    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(source)
    const event = localSessionFactEvent(fact, current)
    if (!event) return
    const bufferedMax = buffered.reduce((max, item) => Math.max(max, item.sequence), 0)
    const previousTransient = transientSequenceBySource.get(source) ?? 0
    const sequence = Math.max(current.revision, bufferedMax, previousTransient) + 1
    transientSequenceBySource.set(source, sequence)
    const envelope = createWorkbenchEnvelope({
      eventId: `local-fact:${source}:${sequence}`,
      sessionId: source,
      sequence,
      recordedAt: new Date().toISOString(),
      source: { provider: 'local-write', sourceId: `local-fact:${sequence}` },
      provenance: {
        origin: 'local-observed',
        trust: 'authoritative',
        provider: boundProvider,
        orderConfidence: 'observed',
        synthetic: { reason: 'local-write-confirmed' },
      },
      event,
    })
    if (loading) {
      buffered.push(envelope)
      return
    }
    runtime.applyDocument(reduceWorkbenchEvent(current, envelope), { ownerKey, generation, preserveGeneration: true })
  }

  const confirmPendingFromEnvelope = (envelope: WorkbenchEventEnvelope): WorkbenchEventEnvelope => {
    if (envelope.provenance.origin === 'optimistic-local') return envelope
    if ((envelope.event.type !== 'message.delta' && envelope.event.type !== 'message.completed')
      || envelope.event.role !== 'user') return envelope
    const content = (envelope.event.parts ?? []).map(part => 'text' in part ? part.text : '').join('')
    const targetSource = envelope.sessionId
    const pending = pendingOptimisticBySource.get(targetSource) ?? []
    const requestId = envelope.identity.interactionId
    const matched = (requestId ? pending.find(item => item.clientMessageId === requestId) : undefined)
      ?? pending.find(item => item.content === content)
    if (!matched) return envelope
    const remaining = pending.filter(item => item !== matched)
    if (remaining.length > 0) pendingOptimisticBySource.set(targetSource, remaining)
    else pendingOptimisticBySource.delete(targetSource)
    if (requestId === matched.clientMessageId) return envelope
    return Object.freeze({
      ...envelope,
      identity: Object.freeze({ ...envelope.identity, interactionId: matched.clientMessageId }),
    })
  }

  const applyLive = (incoming: WorkbenchEventEnvelope) => {
    const currentBefore = runtime.getSnapshot().document
    const priorUser = [...(currentBefore?.messages ?? [])].reverse().find(message => message.role === 'user')
    const isUserStart = incoming.event.type === 'message.delta' && incoming.event.role === 'user'
      && !(priorUser?.running === true)
    const content = isUserStart ? (incoming.event.parts ?? []).map(part => 'text' in part ? part.text : '').join('') : ''
    const pending = pendingOptimisticBySource.get(incoming.sessionId) ?? []
    const echoesOptimistic = pending.some(item => item.clientMessageId === incoming.identity.interactionId || item.content === content)
    if (isUserStart && !echoesOptimistic) turnEpoch += 1
    const envelope = confirmPendingFromEnvelope(incoming)
    const envelopeTime = envelope.occurredAt ? Date.parse(envelope.occurredAt) || Date.now() : Date.now()
    // P52 D3：非乐观 user echo 是真实回合起点（发送方可能是同账号其它客户端）；
    // 覆盖 TurnClock，与 applyDocument 的 terminalFence:null 清除通道对齐。
    if (isUserStart && !echoesOptimistic) {
      // 空态路径的回合起点已在发送入口建立：live echo 不得把它推迟到 echo 时刻
      // （elapsed 从用户发出算起，与已绑定路径一致）。
      if (!clockOnlyStarts.has(envelope.sessionId)) turnClockStart(envelope.sessionId, envelopeTime)
      clockOnlyStarts.delete(envelope.sessionId)
    }
    // 每条 live envelope 刷新时钟活性（append-delta 不更新 message.time）。
    turnClockTouch(envelope.sessionId, envelopeTime)
    if (loading) { buffered.push(envelope); return }
    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(envelope.sessionId)
    runtime.applyDocument(reduceWorkbenchEvent(current, envelope), { ownerKey, generation, turnEpoch, terminalFence: isUserStart ? null : undefined, preserveGeneration: true })
  }
  // P52 D3：feed 终帧信号 → TurnClock 终态（done/error；cancelled 映射 cancelled）。
  // 时钟幂等：首个终态 wins；不在当前 source 的终帧只封存该 source 的时钟。
  // 终态收敛的唯一入口：TurnClock 幂等（首个终态 wins），故 Channel 主轨与 window
  // 广播兜底轨重复投递同一终帧是安全的——两条路都到就只是个 no-op。
  const handleTerminalSignal = (signal: CanonicalTerminalSignal): void => {
    if (!signal.source) return
    const payload = signal.payload as { cancelled?: unknown; failure?: unknown } | null
    const reason: 'done' | 'cancelled' | 'error' = signal.kind === 'error'
      ? (payload?.cancelled === true ? 'cancelled' : 'error')
      : 'done'
    const failure = signal.kind === 'error' && payload && typeof payload === 'object' && typeof payload.failure === 'object'
      ? payload.failure as PromptFailureMetadata
      : undefined
    turnClockTerminal(signal.source, reason, Date.now(), failure)
  }
  const unsubscribeTurnClockTerminal = getCanonicalEventFeed().onTerminal(handleTerminalSignal)
  const unsubscribeTerminalFallback = listenTerminalFallback(handleTerminalSignal)
  const unsubscribeEvents = subscribe(event => {
    if (destroyed || !ownerKey || !source || !event || typeof event !== 'object') return
    const candidate = event as { owner?: Parameters<typeof toCanonicalOwnerKey>[0]; sessionId?: unknown }
    const matchesOwner = candidate.owner ? toCanonicalOwnerKey(candidate.owner) === ownerKey : candidate.sessionId === source
    if (!matchesOwner) return
    const envelopes = toWorkbenchEnvelopes(event)
    if (envelopes.length > 0) envelopes.forEach(applyLive)
    else {
      malformedCount += 1
      if (!loading) {
        const snapshot = runtime.getSnapshot()
        if (snapshot.document) runtime.replaceDocument(withJournalDiagnostic(snapshot.document, malformedCount), {
          ownerKey, generation, sessionId: snapshot.sessionId,
        })
        updateRuntimeState({ status: 'degraded', error: `canonical journal 有 ${malformedCount} 条事件无法迁移` })
      }
    }
  })

  /**
   * Canonical 重载：把 journal 读回来的投影折回文档，并据此收敛时钟。
   *
   * `ledgerTurn` = 后端 #99 turn 账本随 `load_persisted_session` 回来的快照
   * （`ColdMountTurnSnapshot.turn`）。它是**终帧之外唯一的终态证据**：终帧只经
   * per-source IPC Channel 一条路交付，丢了就没有第二次；而账本由后端权威状态
   * 合成、不依赖一次性 event。因此「本回合是否已收敛」= journal 读到终态行
   * **或** 账本说已收敛——只认前者会让一次早于终态行落盘的读把摘要判成不存在。
   */
  const refresh = async (session: Session | undefined, ledgerTurn?: unknown): Promise<void> => {
    if (destroyed || !session || !ownerKey || !boundSessionId || !source) return
    const bindingKey = workbenchSessionBindingKey(session)
    const refreshOwnerKey = ownerKey
    const refreshSource = source
    const refreshSessionId = boundSessionId
    const refreshGeneration = generation
    if (bindingKey !== boundSessionBindingKey || session.id !== refreshSessionId || session.source !== refreshSource) return
    if (refreshInFlight) return refreshInFlight
    const refreshEpoch = ++canonicalReadEpoch
    // 账本终态按 source 归档；本次调用的账本可能被去重丢掉，但归档会留下。
    const ledgerTerminalReason = resolveGenerationLedgerTerminalReason(ledgerTurn)
    if (ledgerTerminalReason !== undefined) ledgerTerminalBySource.set(refreshSource, ledgerTerminalReason)

    const run = (async () => {
      try {
        const rows = await loadAll(refreshOwnerKey)
        const canonicalDuration = canonicalDurationFromRows(rows)
        const canonicalHasTerminal = canonicalHasTerminalFromRows(rows)
        // Session switches/rebinds invalidate the result. Do not let a late
        // canonical read replace the document belonging to the new owner.
        if (destroyed || bindingKey !== boundSessionBindingKey || ownerKey !== refreshOwnerKey
          || source !== refreshSource || boundSessionId !== refreshSessionId || generation !== refreshGeneration
          || canonicalReadEpoch !== refreshEpoch) return

        let refreshMalformedCount = 0
        const envelopes = rows.flatMap(row => {
          const migrated = toWorkbenchEnvelopes(row)
          if (migrated.length > 0) return migrated
          refreshMalformedCount += 1
          return []
        })
        // If refresh supersedes an initial bind read, fold events that arrived
        // while that read was in flight into the winning projection and release
        // the load buffer. Otherwise those events would remain stranded behind
        // the invalidated bind promise.
        const bufferedAtRefresh = buffered
        const current = runtime.getSnapshot().document ?? createWorkbenchDocument(refreshSource)
        // #81 L2：保留折入式投影（读快照建立后提交的 live 行不得被 replace 丢弃）。
        // 粒度互斥由 coverage 区间承担：journal 信封（单元 segment/逐 chunk）对
        // live 已应用区间完全覆盖者跳过（审核修复：恢复基线的 initialDocument: current）。
        const projected = projectWorkbench([...envelopes, ...bufferedAtRefresh], { initialDocument: current }).document
        const reconciled = withPendingOptimistic(refreshSource, projected)
        const document = refreshMalformedCount > 0
          ? withJournalDiagnostic(reconciled, refreshMalformedCount)
          : reconciled
        buffered = []
        loading = false
        runtime.replaceDocument(document, {
          ownerKey: refreshOwnerKey,
          generation: refreshGeneration,
          sessionId: refreshSessionId,
        })
        if (refreshMalformedCount > 0) {
          updateRuntimeState({ status: 'degraded', error: `canonical journal 有 ${refreshMalformedCount} 条事件无法迁移` })
        } else {
          updateRuntimeState({ status: 'ready', error: null })
          // A successful canonical refresh is authoritative evidence that any
          // earlier recoverable bind/replay notice for this session is stale.
          // Resolve by stable key only; errors from other sessions remain.
          resolveRuntimeErrors({ key: `session-recovery:${refreshSessionId}`, source: 'chat.session-recovery' })
        }
        // P52 D3：journal 终态证据封存时钟；活动时钟覆盖投影间隙的回退。
        // #99：账本是第二条终态证据——journal 读可能早于终态行落盘（后端
        // "done 先于 persist"），只认 journal 会让这类读把在途投影判成当前事实，
        // 既封不住时钟、也补不出摘要。
        const ledgerTerminalReason = ledgerTerminalBySource.get(refreshSource)
        const hasTerminalEvidence = canonicalHasTerminal || ledgerTerminalReason !== undefined
        settleTurnClockFromDocument(refreshSource, hasTerminalEvidence)
        reconcileTurnClock(refreshSource)
        const settled = runtime.getSnapshot()
        if (!settled.generating && !settled.summary && hasTerminalEvidence) {
          updateRuntimeState({
            summary: {
              elapsedMs: canonicalDuration?.elapsedMs ?? 0,
              tokenCount: settled.tokenCount,
              completedFrame: '',
              reason: ledgerTerminalReason ?? 'done',
              durationSource: canonicalDuration?.source ?? 'unknown',
              durationAvailable: canonicalDuration !== undefined,
              // Display-only restore: must not synthesize a terminal fence
              // (see normalizeRuntimeSnapshot), or the next controller-driven
              // generation cannot restart the indicator after a rebind.
              displayOnly: true,
            },
          })
        }
      } catch (error) {
        if (destroyed || bindingKey !== boundSessionBindingKey || ownerKey !== refreshOwnerKey
          || source !== refreshSource || boundSessionId !== refreshSessionId || generation !== refreshGeneration
          || canonicalReadEpoch !== refreshEpoch) return
        const bufferedAfterFailure = buffered
        buffered = []
        loading = false
        // A failed refresh may have superseded the initial bind read. Keep
        // already-observed live/session-response events visible even though
        // the canonical reload itself is degraded.
        for (const envelope of bufferedAfterFailure) {
          const current = runtime.getSnapshot().document ?? createWorkbenchDocument(refreshSource)
          runtime.applyDocument(reduceWorkbenchEvent(current, envelope), {
            ownerKey: refreshOwnerKey,
            generation: refreshGeneration,
            preserveGeneration: true,
          })
        }
        updateRuntimeState({ status: 'degraded', error: error instanceof Error ? error.message : String(error) })
      }
    })()
    const pending = run.finally(() => {
      if (refreshInFlight === pending) refreshInFlight = null
    })
    refreshInFlight = pending
    return pending
  }

  return {
    runtime, appearance, sessionUi, commands,
    /**
     * Project the response of the atomic `new_session` command into the same
     * disposable Workbench document used by canonical/live events.  This is a
     * transient bridge: it never appends to SQLite or the canonical journal.
     * The optional local Session.id lets callers publish before React's bind
     * effect runs; the response is buffered and consumed by bind().
     */
    applySessionResponse,
    applyLocalSessionFact,
    refresh,
    async bind(session: Session | undefined): Promise<void> {
      const nextBindingKey = workbenchSessionBindingKey(session)
      // Session objects are recreated for ordinary metadata updates (name,
      // lastReplyAt, autoName) and when canonical replay completes. Rebinding
      // in those cases replaces the whole document and looks like a page
      // refresh. Keep this seam idempotent; explicit identity changes still
      // pass through the normal reload path below. Workspace reloads use the
      // dedicated lifecycle/reload-token seam instead of rebinding here.
      if (boundSessionBindingKey === nextBindingKey) return
      boundSessionBindingKey = nextBindingKey
      // Invalidate any in-flight refresh for the previous binding. Its own
      // epoch/key guard will make the eventual result a no-op; clearing the
      // pointer lets the new binding schedule its own refresh immediately.
      canonicalReadEpoch += 1
      refreshInFlight = null
      const nextGeneration = ++generation
      turnEpoch = 0
      boundSessionId = session?.id
      boundProvider = session?.agentId || 'acp'
      source = session?.source
      ownerKey = session ? toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source }) : undefined
      buffered = []
      malformedCount = 0
      loading = Boolean(session)
      runtime.replaceDocument(createWorkbenchDocument(session?.source ?? ''), {
        ownerKey: ownerKey ?? `unbound:${nextGeneration}`, generation: nextGeneration, turnEpoch, terminalFence: null, sessionId: session?.id ?? null,
      })
      if (session) {
        const pendingResponses = [
          ...(pendingSessionResponses.get(session.id) ?? []),
          ...(pendingSessionResponses.get(session.source) ?? []),
        ]
        pendingSessionResponses.delete(session.id)
        pendingSessionResponses.delete(session.source)
        for (const response of pendingResponses) enqueueSessionResponse(response, session.id)
      }
      // P52 D3：bind 重置读 TurnClock——时钟按 source 隔离，切回同 source 的
      // 活动回合恢复（reconcileTurnClock 在 journal 读完成后执行）。
      const activeClock = source ? turnClocks.get(source) : undefined
      updateRuntimeState({
        status: loading ? 'loading' : 'idle', error: null,
        ...(activeClock && !activeClock.terminal
          ? { generating: true, generationStart: activeClock.generationStart, lastTokenAt: activeClock.lastTokenAt, summary: null }
          : { generating: false, generationStart: 0, lastTokenAt: undefined, generationPhase: undefined, generationActivity: undefined, thinkingStart: undefined, summary: null }),
      })
      if (!session || !ownerKey) return
      const loadingOwnerKey = ownerKey
      const bindReadEpoch = canonicalReadEpoch
      await loadAll(loadingOwnerKey).then(rows => {
        if (destroyed || generation !== nextGeneration || ownerKey !== loadingOwnerKey
          || canonicalReadEpoch !== bindReadEpoch) return
        const canonicalDuration = canonicalDurationFromRows(rows)
        const canonicalHasTerminal = canonicalHasTerminalFromRows(rows)
        const browserSnapshot = (isBrowserMockRuntime() || !IS_TAURI) && rows.length === 0 && typeof localStorage !== 'undefined'
          ? (() => {
            // Session snapshots historically used both the stable Session.id
            // and the provider source as keys. Prefer the stable id, then
            // recover a source-keyed snapshot left by older browser builds.
            const byId = parseMessageSnapshot<Message>(localStorage.getItem(messageStorageKey(session.id)))
            const bySource = parseMessageSnapshot<Message>(localStorage.getItem(messageStorageKey(session.source)))
            return messageSnapshotToWorkbenchEnvelopes(session.source, byId && byId.length > 0 ? byId : bySource ?? [])
          })()
          : []
        const envelopes = [...rows, ...browserSnapshot].flatMap(row => {
          const migrated = toWorkbenchEnvelopes(row)
          if (migrated.length > 0) return migrated
          malformedCount += 1
          return []
        })
        const projected = projectWorkbench([...envelopes, ...buffered], { initialDocument: createWorkbenchDocument(session.source) }).document
        const reconciled = withPendingOptimistic(session.source, projected)
        const document = malformedCount > 0 ? withJournalDiagnostic(reconciled, malformedCount) : reconciled
        buffered = []; loading = false
        runtime.replaceDocument(document, { ownerKey: loadingOwnerKey, generation: nextGeneration, sessionId: session.id })
        updateRuntimeState(malformedCount > 0
          ? { status: 'degraded', error: `canonical journal 有 ${malformedCount} 条事件无法迁移` }
          : { status: 'ready', error: null })
        if (malformedCount === 0) {
          resolveRuntimeErrors({ key: `session-recovery:${session.id}`, source: 'chat.session-recovery' })
        }
        // P52 D3：journal 终态证据封存时钟；活动时钟覆盖投影间隙的回退。
        settleTurnClockFromDocument(session.source, canonicalHasTerminal)
        reconcileTurnClock(session.source)
        // A restarted process has no live terminal summary, while the
        // canonical document already contains the completed turn. Publish a
        // display-only done summary so the footer remains in its terminal
        // state instead of disappearing; this does not add a journal event.
        const settled = runtime.getSnapshot()
        if (!settled.generating && !settled.summary && canonicalHasTerminal) {
          updateRuntimeState({
            summary: {
              elapsedMs: canonicalDuration?.elapsedMs ?? 0,
              tokenCount: settled.tokenCount,
              completedFrame: '',
              reason: 'done',
              durationSource: canonicalDuration?.source ?? 'unknown',
              durationAvailable: canonicalDuration !== undefined,
              // Display-only restore: must not synthesize a terminal fence
              // (see normalizeRuntimeSnapshot), or the next controller-driven
              // generation cannot restart the indicator after a rebind.
              displayOnly: true,
            },
          })
        }
      }).catch(error => {
        if (destroyed || generation !== nextGeneration || ownerKey !== loadingOwnerKey
          || canonicalReadEpoch !== bindReadEpoch) return
        loading = false; buffered = []
        updateRuntimeState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      })
    },
    destroy() {
      if (destroyed) return
      destroyed = true; unsubscribeTurnClockTerminal(); unsubscribeTerminalFallback(); unsubscribeEvents(); runtime.destroy(); appearance.destroy(); sessionUi.destroy()
      pendingSessionResponses.clear(); appliedSessionResponseKeys.clear(); transientSequenceBySource.clear(); turnClocks.clear(); clockOnlyStarts.clear(); ledgerTerminalBySource.clear()
    },
  }
}
