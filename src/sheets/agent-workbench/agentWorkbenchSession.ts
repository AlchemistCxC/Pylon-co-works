/**
 * Workbench session host: binding, canonical replay/live reconciliation and
 * generation ownership. Stateless response/snapshot adapters live alongside
 * this module (agentWorkbenchProjection.ts); they cannot mutate lifecycle
 * state or access persistence. The TurnClock/liveness subsystem
 * (agentWorkbenchTurnClock.ts) and the optimistic-echo subsystem
 * (agentWorkbenchOptimisticEcho.ts) are extracted collaborators; the shared
 * binding/fold state lives in the `binding`/`fold` objects below.
 */
import { createSessionResponseEnvelope, sessionResponseProjectionKey } from './sessionResponseProjection.ts'
import { messageSnapshotToWorkbenchEnvelopes } from './messageSnapshotProjection.ts'
import type { Session } from '../../identityStore.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'
import { resolveGenerationLedgerTerminalReason } from '../../domains/workbench/generationLedgerSummary.ts'
import {
  createWorkbenchEnvelope,
  type WorkbenchEventEnvelope,
} from '../../domains/workbench/events/workbenchEventSchema.ts'
import {
  createWorkbenchDocument,
  projectWorkbench,
  reduceWorkbenchEvent,
  type WorkbenchDocument,
} from '../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'
import { createSessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import { createZustandWorkbenchAppearanceStore } from '../../domains/workbench/zustandWorkbenchAppearanceStore.ts'
import { IS_TAURI, isBrowserMockRuntime } from '../../infrastructure/tauri/env.ts'
import { discardInterruptedDraft, keepInterruptedDraft, loadCanonicalDraftFragments, tauriCanonicalEventRepository, type CanonicalDraftFragment } from '../../infrastructure/events/canonicalEventRepository.ts'
import { subscribePluginEvents } from '../../infrastructure/events/pluginEventBus.ts'
import { messageStorageKey, parseMessageSnapshot } from '../../components/chat/messagePersistence.ts'
import type { Message } from '../../components/chat/messageTypes.ts'
import { resolveRuntimeErrors } from '../../runtimeError.ts'
import { createAgentWorkbenchCommandFacade, type ResolvedWorkbenchInteraction } from './agentWorkbenchCommands.ts'
import {
  extractModelConfig,
  extractModeConfig,
  extractConfigOptionValue,
  sessionResponseObject,
  type PromptFailureMetadata,
  type SessionResponseObject,
} from '../../infrastructure/acp/chatContracts.ts'
import {
  canonicalDurationFromRows,
  canonicalHasTerminalFromRows,
  draftChunkToWorkbenchEnvelopes,
  isLiveTextDelta,
  localSessionFactEvent,
  runningTailStartTime,
  toWorkbenchEnvelopes,
  withJournalDiagnostic,
  type LocalSessionFact,
} from './agentWorkbenchProjection.ts'
import { createAgentWorkbenchTurnClock } from './agentWorkbenchTurnClock.ts'
import { createAgentWorkbenchOptimisticEcho } from './agentWorkbenchOptimisticEcho.ts'
import type { CanonicalDraftChunkNotification, CanonicalTerminalSignal } from '../../infrastructure/events/canonicalEventFeed.ts'
import { getCanonicalEventFeed, subscribeWindowTerminalFrames } from '../../infrastructure/events/canonicalEventFeed.ts'

export type { LocalSessionFact } from './agentWorkbenchProjection.ts'

export interface AgentWorkbenchSessionRuntimeDependencies {
  loadAll(ownerKey: string): Promise<readonly unknown[]>
  loadDrafts?(ownerKey: string): Promise<readonly CanonicalDraftFragment[]>
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

export function createAgentWorkbenchSessionRuntime(dependencies: Partial<AgentWorkbenchSessionRuntimeDependencies> = {}) {
  const defaults = defaultDependencies()
  const loadAll = dependencies.loadAll ?? defaults.loadAll
  const loadDrafts = dependencies.loadDrafts ?? (ownerKey => IS_TAURI && !isBrowserMockRuntime()
    ? loadCanonicalDraftFragments(ownerKey) : Promise.resolve([]))
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
  // 会话宿主的共享绑定/折叠状态（原散落闭包 let 的单源化，接口见
  // agentWorkbenchOptimisticEcho.ts）：子系统与宿主经同一对象读写，跨块共享的
  // 竞态控制面（generation/epoch/source/...）由此显式化。
  const binding = {
    boundSessionId: undefined as string | undefined,
    boundSession: undefined as Session | undefined,
    boundProvider: 'acp',
    boundSessionBindingKey: undefined as string | undefined,
    ownerKey: undefined as string | undefined,
    source: undefined as string | undefined,
    generation: 0,
    turnEpoch: 0,
    loading: false,
    buffered: [] as WorkbenchEventEnvelope[],
    malformedCount: 0,
    destroyed: false,
    // A canonical replay can finish after this runtime's initial bind. Keep a
    // separate, coalesced refresh seam so the same binding key does not make a
    // later durable tool terminal event invisible (bind itself is intentionally
    // idempotent for ordinary Session metadata updates).
    refreshInFlight: null as Promise<void> | null,
    // Every canonical read gets a monotonically increasing token. A bind read
    // that started before a refresh (or before a new bind) must not publish its
    // older snapshot after the newer read has won the race.
    canonicalReadEpoch: 0,
    selectorRequestInFlight: false,
  }
  // #220 折叠已下沉 wasm：折叠状态常驻会话持有的投影核（PylonProjector），JS 文档
  // 是其产出的物化视图。foldLog 保留全部已折信封（到达序、按 eventId 去重，与投影
  // 核幂等判据同口径——refresh 全量重折的 journal 行不会重复入日志），供 reject 回滚
  // 时「整页重折、剔除被拒乐观信封」重建投影核——wasm 侧没有就地删除已入账事件的出口。
  const fold = {
    log: [] as WorkbenchEventEnvelope[],
    ids: new Set<string>(),
    // journal 迁移失败诊断（canonical.journal.malformed）是宿主侧 overlay：折叠物化
    // 出来的文档不带它，物化后按当前计数重挂（withJournalDiagnostic 幂等：filter+append）。
    journalDiagnosticCount: 0,
  }
  const draft = {
    seen: new Set<string>(),
    activeIds: new Set<string>(),
    interruptedIds: new Set<string>(),
    reconcilePending: false,
    liveDuringReconcile: [] as WorkbenchEventEnvelope[],
  }
  /** Responses from the atomic empty-state create transaction can arrive
   * before React has rebound the Workbench to the newly-added local Session.
   * Keep them keyed by local Session.id until that bind completes. */
  const pendingSessionResponses = new Map<string, SessionResponseObject[]>()
  const appliedSessionResponseKeys = new Map<string, { key: string; session: WorkbenchDocument['session'] | undefined }>()
  const transientSequenceBySource = new Map<string, number>()

  const updateRuntimeState = (patch: Parameters<typeof runtime.update>[0]) => {
    const current = runtime.getSnapshot()
    if (!current.document) {
      runtime.update(patch)
      return
    }
    const { document: _ignoredDocument, ...generationPatch } = patch
    runtime.applyDocument(current.document, {
      ownerKey: binding.ownerKey,
      generation: binding.generation,
      preserveGeneration: false,
      generationPatch,
    })
  }

  /**
   * 页级折叠（**TS 纯函数投影核**）：一页一次「文档入、文档出」。
   *
   * 2026-09-21 投影自 wasm 回退 TS（判决与依据见 ADR-0018 的 scope 修订）：wasm 投影在现实
   * 入口只有 1.12×、页级 1.92×，而文档必须在核里与 JS 里**各存一份**（持有成本 4.4–6.1×）
   * —— 换来的是负收益。回退后文档只有一份，也再没有「核就绪」这回事。
   *
   * `base` 的语义是**承重的**，别一律省：
   * - 缺省 = 续折当前文档（live / session-response / refresh 的语义）；
   * - **冷装载（bind）与回滚重折必须显式传新的空文档** —— 那是「重建」不是「续折」；
   *   上游那条「审核修复：恢复基线的 `initialDocument: current`」指的就是这里别传错。
   */
  const foldPage = (
    envelopes: readonly WorkbenchEventEnvelope[],
    base?: WorkbenchDocument,
  ): WorkbenchDocument => {
    const initial = base ?? runtime.getSnapshot().document ?? createWorkbenchDocument(binding.source ?? '')
    const projected = projectWorkbench(envelopes, { initialDocument: initial }).document
    for (const envelope of envelopes) {
      if (fold.ids.has(envelope.eventId)) continue
      fold.ids.add(envelope.eventId)
      fold.log.push(envelope)
    }
    return fold.journalDiagnosticCount > 0 ? withJournalDiagnostic(projected, fold.journalDiagnosticCount) : projected
  }

  /**
   * 单事件折叠（live 路径）：走**单事件归约器**而不是 `foldPage([one])`。
   * 页级入口为取得工作数组所有权会整份复制 timeline（#205 的优化），逐事件用它就是
   * Θ(N²) —— 这正是 #205 当初把 live 从页级入口挪开的原因，不要合流。
   */
  const foldEvent = (
    envelope: WorkbenchEventEnvelope,
    base?: WorkbenchDocument,
  ): WorkbenchDocument => {
    const current = base ?? runtime.getSnapshot().document ?? createWorkbenchDocument(binding.source ?? '')
    const next = reduceWorkbenchEvent(current, envelope)
    if (binding.boundSessionId && (next.session.model !== current.session.model || next.session.mode !== current.session.mode || next.session.options !== current.session.options)) {
      sessionUi.set(binding.boundSessionId, 'selector-pending', '')
    }
    return next
  }

  const clock = createAgentWorkbenchTurnClock({
    runtime,
    updateRuntimeState,
    getSource: () => binding.source,
  })
  const echo = createAgentWorkbenchOptimisticEcho({
    runtime,
    binding,
    fold,
    clock,
    updateRuntimeState,
    foldPage,
    foldEvent,
  })

  const commands = createAgentWorkbenchCommandFacade({
    ...dependencies.commands,
    // P52 D4：controller React 状态面死亡——乐观 echo 撤销只剩 document 侧投影。
    optimisticDocument: echo.project,
    rejectOptimisticDocument: echo.reject,
    resolveConfigOption(sessionId, key) {
      if (binding.boundSessionId !== sessionId) return undefined
      const option = runtime.getSnapshot().document?.session.options.find(item => item.id === key)
      return option ? { value: option.value, version: option.version } : undefined
    },
    resolveInteraction(sessionId, interactionId): ResolvedWorkbenchInteraction | undefined {
      const snapshot = runtime.getSnapshot()
      if (binding.boundSessionId !== sessionId) return undefined
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

  const enqueueSessionResponse = (response: SessionResponseObject, targetSessionId: string): void => {
    if (binding.destroyed || !binding.boundSessionId || !binding.source || targetSessionId !== binding.boundSessionId) return
    const key = sessionResponseProjectionKey(response)
    const last = appliedSessionResponseKeys.get(targetSessionId)
    if (last?.key === key && last.session === runtime.getSnapshot().document?.session) return

    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(binding.source)
    const bufferedMax = binding.buffered.reduce((max, item) => Math.max(max, item.sequence), 0)
    const previousTransient = transientSequenceBySource.get(binding.source) ?? 0
    const sequence = Math.max(current.revision, bufferedMax, previousTransient) + 1
    transientSequenceBySource.set(binding.source, sequence)
    const envelope = createSessionResponseEnvelope(binding.source, binding.boundProvider, response, sequence)
    if (binding.loading) {
      binding.buffered.push(envelope)
      appliedSessionResponseKeys.set(targetSessionId, { key, session: runtime.getSnapshot().document?.session })
      return
    }
    runtime.applyDocument(foldEvent(envelope), { ownerKey: binding.ownerKey, generation: binding.generation, preserveGeneration: true })
    appliedSessionResponseKeys.set(targetSessionId, { key, session: runtime.getSnapshot().document?.session })
  }

  const applySessionResponse = (response: unknown, targetSessionId?: string): void => {
    if (binding.destroyed) return
    const normalized = sessionResponseObject(response)
    const target = targetSessionId?.trim() || binding.boundSessionId
    if (!target) return
    if (binding.boundSessionId && (target === binding.boundSessionId || target === binding.source)) {
      enqueueSessionResponse(normalized, binding.boundSessionId)
      return
    }
    const pending = pendingSessionResponses.get(target) ?? []
    pending.push(normalized)
    pendingSessionResponses.set(target, pending)
  }

  /** Execute one selector write against this binding. Replies update the same
   * document as notifications, never a second optimistic selector store. */
  const runSessionControl = async (
    context: { agentId: string; source: string },
    fact: LocalSessionFact,
    request: () => Promise<unknown>,
  ): Promise<void> => {
    if (binding.destroyed || !binding.boundSessionId || binding.source !== context.source || binding.boundProvider !== context.agentId) throw new Error('selector_owner_stale')
    if (binding.selectorRequestInFlight) throw new Error('selector_request_in_flight')
    const requestGeneration = binding.generation
    const sessionId = binding.boundSessionId
    const before = runtime.getSnapshot().document?.session
    binding.selectorRequestInFlight = true
    sessionUi.set(sessionId, 'selector-pending', '')
    try {
      const response = sessionResponseObject(await request())
      if (binding.destroyed || binding.generation !== requestGeneration || binding.boundSessionId !== sessionId) return
      const current = runtime.getSnapshot().document ?? createWorkbenchDocument(context.source)
      const receivedSelectorUpdate = before && (before.model !== current.session.model || before.mode !== current.session.mode || before.options !== current.session.options)
      const model = extractModelConfig(response.configOptions, response).model
      const mode = extractModeConfig(response).mode
      const options = response.configOptions ?? response.config_options
      if (options?.length) {
        const sequence = Math.max(current.revision, transientSequenceBySource.get(context.source) ?? 0, ...binding.buffered.map(item => item.sequence)) + 1
        transientSequenceBySource.set(context.source, sequence)
        const envelope = createSessionResponseEnvelope(context.source, binding.boundProvider, response, sequence, 'session.config-updated')
        if (binding.loading) binding.buffered.push(envelope)
        else runtime.applyDocument(foldEvent(envelope), { ownerKey: binding.ownerKey, generation: binding.generation, preserveGeneration: true })
      } else {
        if (model) applyLocalSessionFact({ kind: 'model', model }, context.source)
        if (mode) applyLocalSessionFact({ kind: 'mode', mode }, context.source)
      }
      const confirmed = fact.kind === 'model' ? model : fact.kind === 'mode' ? mode
        : options?.find(option => option.id === fact.id) && extractConfigOptionValue(options.find(option => option.id === fact.id))
      if (confirmed === undefined && !receivedSelectorUpdate) {
        const requested = fact.kind === 'model' ? fact.model : fact.kind === 'mode' ? fact.mode : String(fact.value)
        sessionUi.set(sessionId, 'selector-pending', `${requested}（等待 Agent 确认）`)
      }
    } finally {
      binding.selectorRequestInFlight = false
    }
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
    if (binding.destroyed || !binding.boundSessionId || !binding.source) return
    const target = targetSessionId?.trim()
    if (target && target !== binding.boundSessionId && target !== binding.source) return
    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(binding.source)
    const event = localSessionFactEvent(fact, current)
    if (!event) return
    const bufferedMax = binding.buffered.reduce((max, item) => Math.max(max, item.sequence), 0)
    const previousTransient = transientSequenceBySource.get(binding.source) ?? 0
    const sequence = Math.max(current.revision, bufferedMax, previousTransient) + 1
    transientSequenceBySource.set(binding.source, sequence)
    const envelope = createWorkbenchEnvelope({
      eventId: `local-fact:${binding.source}:${sequence}`,
      sessionId: binding.source,
      sequence,
      recordedAt: new Date().toISOString(),
      source: { provider: 'local-write', sourceId: `local-fact:${sequence}` },
      provenance: {
        origin: 'local-observed',
        trust: 'authoritative',
        provider: binding.boundProvider,
        orderConfidence: 'observed',
        synthetic: { reason: 'local-write-confirmed' },
      },
      event,
    })
    if (binding.loading) {
      binding.buffered.push(envelope)
      return
    }
    runtime.applyDocument(foldEvent(envelope), { ownerKey: binding.ownerKey, generation: binding.generation, preserveGeneration: true })
  }

  const applyLive = (incoming: WorkbenchEventEnvelope) => {
    const currentBefore = runtime.getSnapshot().document
    const priorUser = [...(currentBefore?.messages ?? [])].reverse().find(message => message.role === 'user')
    const isUserStart = incoming.event.type === 'message.delta' && incoming.event.role === 'user'
      && !(priorUser?.running === true)
    const content = isUserStart ? (incoming.event.parts ?? []).map(part => 'text' in part ? part.text : '').join('') : ''
    const echoesOptimistic = echo.matchesPending(incoming.sessionId, incoming.identity.interactionId, content)
    if (isUserStart && !echoesOptimistic) binding.turnEpoch += 1
    const envelope = echo.confirm(incoming)
    const envelopeTime = envelope.occurredAt ? Date.parse(envelope.occurredAt) || Date.now() : Date.now()
    // P52 D3：非乐观 user echo 是真实回合起点（发送方可能是同账号其它客户端）；
    // 覆盖 TurnClock，与 applyDocument 的 terminalFence:null 清除通道对齐。
    // #200：loading 期间到达的是 session/load 的**重放历史**帧——不是新回合。
    // 空 journal（#155 T2 重建升级）时 refresh 无终态证据可压住时钟，重放的 user
    // 帧会把历史回合复活成「仍在等待后端响应」的生成态并阻塞发送队列。缓冲帧在
    // 载入完成后经 wasm 投影核整页折叠（不走 applyLive），不会二次开启时钟。
    // #217：本 source 有内核表态（kernelLivenessBySource.has）时，"采纳实时帧"的
    // 启发式停用——是否在途由内核事实回答，本进程不再从观察物猜（ADR-0017 收敛
    // 推断）。clockOnlyStarts 的记账保留（canonical echo 仍需确认派发意图）。
    const kernelAuthoritative = clock.kernelAuthoritative(envelope.sessionId)
    if (isUserStart && !echoesOptimistic && !binding.loading) {
      // 空态路径的回合起点已在发送入口建立：live echo 不得把它推迟到 echo 时刻
      // （elapsed 从用户发出算起，与已绑定路径一致）。
      if (!kernelAuthoritative && !clock.hasClockOnlyStart(envelope.sessionId)) clock.start(envelope.sessionId, envelopeTime)
      clock.clearClockOnlyStart(envelope.sessionId)
      // #213：权威活性必须**明确表态**——不能再指望文档里那个 running 行把 generating 顶起来
      // （文档派生的活性已让位给回合时钟）。回合不终结，时钟就一直是权威。
      if (!kernelAuthoritative) clock.reconcile(envelope.sessionId)
    }
    // #213 补强：本 source 还没有回合时钟时，**实时**文本 delta 本身就是「在途回合」的证据
    //（同账号其它客户端先开了回合、本进程后启动）。起点取文档里首个 running 行的时间，
    // 不用 now()——否则 elapsed 会从「我们看见它」开始算。loading 期间到达的是重放历史
    //（见上），不在此列。
    // #217：内核表态可用时本启发式停用——他端先开回合的"是否在途"由内核回答（语义
    // 严格为「本进程已派发 prompt」），不再从实时帧采纳。
    if (!kernelAuthoritative && !binding.loading && isLiveTextDelta(incoming) && !clock.hasClock(envelope.sessionId)) {
      clock.start(envelope.sessionId, runningTailStartTime(currentBefore) ?? envelopeTime)
      clock.reconcile(envelope.sessionId)
    }
    // 每条 live envelope 刷新时钟活性（append-delta 不更新 message.time）。
    clock.touch(envelope.sessionId, envelopeTime)
    if (binding.loading) { binding.buffered.push(envelope); return }
    const liveness = clock.effectiveLiveness(envelope.sessionId)
    runtime.applyDocument(foldEvent(envelope), {
      ownerKey: binding.ownerKey,
      generation: binding.generation,
      turnEpoch: binding.turnEpoch,
      terminalFence: isUserStart ? null : undefined,
      preserveGeneration: true,
      livenessSource: liveness.source,
      livenessGenerating: liveness.generating,
    })
  }

  const applyDraftChunk = (chunk: CanonicalDraftChunkNotification): void => {
    if (binding.destroyed || binding.ownerKey !== chunk.ownerKey || binding.source !== chunk.source) return
    const key = `${chunk.draftId}:${chunk.chunkIndex}`
    if (draft.seen.has(key)) return
    draft.seen.add(key)
    draft.activeIds.add(chunk.draftId)
    const current = runtime.getSnapshot().document
    const sequence = Math.max(current?.revision ?? 0, transientSequenceBySource.get(chunk.source) ?? 0) + 1
    transientSequenceBySource.set(chunk.source, sequence)
    const envelopes = draftChunkToWorkbenchEnvelopes({
      provider: binding.boundProvider, source: chunk.source,
      draftId: chunk.draftId, chunkIndex: chunk.chunkIndex,
      raw: chunk.raw, sequence, recordedAt: new Date().toISOString(),
    })
    envelopes.forEach(applyLive)
  }

  const projectRecoveredDrafts = (
    fragments: readonly CanonicalDraftFragment[], startSequence: number,
  ): WorkbenchEventEnvelope[] => {
    const envelopes: WorkbenchEventEnvelope[] = []
    let sequence = startSequence
    const chunkIndexByDraft = new Map<string, number>()
    for (const fragment of fragments) {
      if (fragment.interrupted) draft.interruptedIds.add(fragment.draftId)
      draft.activeIds.add(fragment.draftId)
      for (const raw of fragment.rawPayload) {
        const chunkIndex = chunkIndexByDraft.get(fragment.draftId) ?? 0
        chunkIndexByDraft.set(fragment.draftId, chunkIndex + 1)
        const key = `${fragment.draftId}:${chunkIndex}`
        if (draft.seen.has(key)) continue
        draft.seen.add(key)
        sequence += 1
        envelopes.push(...draftChunkToWorkbenchEnvelopes({
          provider: binding.boundProvider, source: binding.source ?? '',
          draftId: fragment.draftId, chunkIndex,
          raw, sequence, recordedAt: fragment.firstReceivedAt,
        }))
      }
    }
    return envelopes
  }

  const withInterruptedDraftMarker = (
    document: WorkbenchDocument,
    envelopes: readonly WorkbenchEventEnvelope[],
  ): WorkbenchDocument => {
    if (draft.interruptedIds.size === 0) return document
    // A draft can continue a message whose first chunks are already canonical
    // (for example after the 48 KiB split). The projected message then keeps
    // the first canonical source, so identify the provisional tail by its
    // latest sequence as well.
    const draftBySequence = new Map<number, string>()
    for (const envelope of envelopes) {
      const sourceId = envelope.source.sourceId
      if (!sourceId.startsWith('draft:')) continue
      const draftId = sourceId.slice('draft:'.length).split(':')[0]
      if (draft.interruptedIds.has(draftId)) draftBySequence.set(envelope.sequence, draftId)
    }
    return {
      ...document,
      messages: document.messages.map(message => {
        const sourceId = message.source.sourceId
        const draftId = sourceId.startsWith('draft:')
          ? sourceId.slice('draft:'.length).split(':')[0]
          : draftBySequence.get(message.sequence)
        return draftId && draft.interruptedIds.has(draftId)
          ? { ...message, running: false, interruptedDraft: true, draftId }
          : message
      }),
    }
  }

  // P52 D3：feed 终帧信号 → TurnClock 终态（done/error；cancelled 映射 cancelled）。
  // 时钟幂等：首个终态 wins；不在当前 source 的终帧只封存该 source 的时钟。
  // 终态收敛的唯一入口：TurnClock 幂等（首个终态 wins），故 Channel 主轨与 window
  // 广播兜底轨重复投递同一终帧是安全的——两条路都到就只是个 no-op。
  const handleTerminalSignal = (signal: CanonicalTerminalSignal): void => {
    if (!signal.source) return
    const payload = signal.payload as { cancelled?: unknown; failure?: unknown; data?: { stopReason?: unknown } } | null
    // #324：done 帧携带 stopReason=cancelled（内核中性结算的用户主动停止）——
    // 页脚按「已停止」呈现，不冒充自然完成。
    const doneStopReason = payload && typeof payload.data === 'object' && payload.data !== null
      ? payload.data.stopReason
      : undefined
    const reason: 'done' | 'cancelled' | 'error' = signal.kind === 'error'
      ? (payload?.cancelled === true ? 'cancelled' : 'error')
      : doneStopReason === 'cancelled' ? 'cancelled' : 'done'
    const failure = signal.kind === 'error' && payload && typeof payload === 'object' && typeof payload.failure === 'object'
      ? payload.failure as PromptFailureMetadata
      : undefined
    clock.terminal(signal.source, reason, Date.now(), failure)
  }
  const unsubscribeTurnClockTerminal = getCanonicalEventFeed().onTerminal(handleTerminalSignal)
  const unsubscribeTerminalFallback = listenTerminalFallback(handleTerminalSignal)
  const unsubscribeEvents = subscribe(event => {
    if (binding.destroyed || !binding.ownerKey || !binding.source || !event || typeof event !== 'object') return
    const candidate = event as { owner?: Parameters<typeof toCanonicalOwnerKey>[0]; sessionId?: unknown }
    const matchesOwner = candidate.owner ? toCanonicalOwnerKey(candidate.owner) === binding.ownerKey : candidate.sessionId === binding.source
    if (!matchesOwner) return
    const envelopes = toWorkbenchEnvelopes(event)
    if (envelopes.length > 0) {
      if (draft.reconcilePending) draft.liveDuringReconcile.push(...envelopes)
      envelopes.forEach(applyLive)
    }
    else {
      binding.malformedCount += 1
      fold.journalDiagnosticCount = binding.malformedCount
      if (!binding.loading) {
        const snapshot = runtime.getSnapshot()
        if (snapshot.document) runtime.replaceDocument(withJournalDiagnostic(snapshot.document, binding.malformedCount), {
          ownerKey: binding.ownerKey, generation: binding.generation, sessionId: snapshot.sessionId,
        })
        updateRuntimeState({ status: 'degraded', error: `canonical journal 有 ${binding.malformedCount} 条事件无法迁移` })
      }
    }
  })

  /**
   * Canonical 重载/冷装载的成功尾巴（refresh 与 bind 的共享发布路径）：把折好的
   * 文档替换进 runtime、按权威活性申报、收敛时钟与账本证据、按需发布 display-only
   * 摘要。`withLedgerEvidence` 区分两条路——refresh 携带 #99 账本快照（bind 不据
   * journal 终态**行**置内核表态，内核事实只来自冷挂载快照的 turnInFlight/账本、
   * 终帧与本地生命周期）。
   */
  const publishCanonicalRead = (input: {
    readSource: string
    readOwnerKey: string
    readGeneration: number
    readSessionId: string
    envelopes: readonly WorkbenchEventEnvelope[]
    bufferedAtRead: readonly WorkbenchEventEnvelope[]
    base: WorkbenchDocument
    malformedCount: number
    canonicalDuration: ReturnType<typeof canonicalDurationFromRows>
    canonicalHasTerminal: boolean
    withLedgerEvidence: boolean
  }): void => {
    const readEnvelopes = input.bufferedAtRead.length === 0 ? input.envelopes : [...input.envelopes, ...input.bufferedAtRead]
    const projected = foldPage(readEnvelopes, input.base)
    const reconciled = echo.withPending(input.readSource, projected)
    const document = withInterruptedDraftMarker(input.malformedCount > 0 ? withJournalDiagnostic(reconciled, input.malformedCount) : reconciled, readEnvelopes)
    binding.buffered = []
    binding.loading = false
    const readLiveness = clock.effectiveLiveness(input.readSource)
    runtime.replaceDocument(document, {
      ownerKey: input.readOwnerKey,
      generation: input.readGeneration,
      sessionId: input.readSessionId,
      livenessSource: readLiveness.source,
      livenessGenerating: readLiveness.generating,
    })
    if (input.malformedCount > 0) {
      updateRuntimeState({ status: 'degraded', error: `canonical journal 有 ${input.malformedCount} 条事件无法迁移` })
    } else {
      updateRuntimeState({ status: 'ready', error: null })
      // A successful canonical refresh is authoritative evidence that any
      // earlier recoverable bind/replay notice for this session is stale.
      // Resolve by stable key only; errors from other sessions remain.
      resolveRuntimeErrors({ key: `session-recovery:${input.readSessionId}`, source: 'chat.session-recovery' })
    }
    // P52 D3：journal 终态证据封存时钟；活动时钟覆盖投影间隙的回退。
    // #99：账本是第二条终态证据——journal 读可能早于终态行落盘（后端
    // "done 先于 persist"），只认 journal 会让这类读把在途投影判成当前事实，
    // 既封不住时钟、也补不出摘要。
    // #217：终态证据同样收敛内核在途事实——账本/journal 终态就是内核自己在说
    // 「回合已终态」（终帧丢失时这是唯一落静路，displayOnly 摘要依赖它）。
    const ledgerTerminalReason = input.withLedgerEvidence ? clock.ledgerTerminalOf(input.readSource) : undefined
    const hasTerminalEvidence = input.canonicalHasTerminal || ledgerTerminalReason !== undefined
    clock.settleFromDocument(input.readSource, hasTerminalEvidence)
    // #217：终态证据收敛内核事实。**只认账本终态**（ledgerTerminalReason，内核
    // 自己的账本）——journal 终态行是文档历史，不是内核活性事实，不得制造内核
    // 条目（时钟封存那一半维持 #99 无条件既有语义，kernel 写跟随账本那一半）。
    // 这是无条件写，与顶部的新鲜度守卫刻意不同：账本终态是点时内核事实的
    // 收敛陈述，早于它发出的 true 快照已被守卫二的回合身份挡住。
    if (ledgerTerminalReason !== undefined) clock.settleKernelFromLedger(input.readSource)
    clock.settleRuntimeLiveness(input.readSource)
    clock.reconcile(input.readSource)
    const settled = runtime.getSnapshot()
    if (!settled.generating && !settled.summary && hasTerminalEvidence) {
      updateRuntimeState({
        summary: {
          elapsedMs: input.canonicalDuration?.elapsedMs ?? 0,
          tokenCount: settled.tokenCount,
          completedFrame: '',
          reason: ledgerTerminalReason ?? 'done',
          durationSource: input.canonicalDuration?.source ?? 'unknown',
          durationAvailable: input.canonicalDuration !== undefined,
          // Display-only restore: must not synthesize a terminal fence
          // (see normalizeRuntimeSnapshot), or the next controller-driven
          // generation cannot restart the indicator after a rebind.
          displayOnly: true,
        },
      })
    }
  }

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
    if (binding.destroyed || !session || !binding.ownerKey || !binding.boundSessionId || !binding.source) return
    const bindingKey = workbenchSessionBindingKey(session)
    const refreshOwnerKey = binding.ownerKey
    const refreshSource = binding.source
    const refreshSessionId = binding.boundSessionId
    const refreshGeneration = binding.generation
    if (bindingKey !== binding.boundSessionBindingKey || session.id !== refreshSessionId || session.source !== refreshSource) return
    if (binding.refreshInFlight) return binding.refreshInFlight
    const refreshEpoch = ++binding.canonicalReadEpoch
    // 账本终态按 source 归档；本次调用的账本可能被去重丢掉，但归档会留下。
    const ledgerTerminalReason = resolveGenerationLedgerTerminalReason(ledgerTurn)
    if (ledgerTerminalReason !== undefined) clock.archiveLedgerTerminal(refreshSource, ledgerTerminalReason)
    // #217：内核在途事实随快照入库（守卫逻辑见 clock.observeKernelSnapshot）。
    clock.observeKernelSnapshot(refreshSource, ledgerTurn)

    const run = (async () => {
      try {
        const rows = await loadAll(refreshOwnerKey)
        const fragments = await loadDrafts(refreshOwnerKey)
        const current = runtime.getSnapshot().document ?? createWorkbenchDocument(refreshSource)
        const canonicalDuration = canonicalDurationFromRows(rows)
        const canonicalHasTerminal = canonicalHasTerminalFromRows(rows)
        // Session switches/rebinds invalidate the result. Do not let a late
        // canonical read replace the document belonging to the new owner.
        if (binding.destroyed || bindingKey !== binding.boundSessionBindingKey || binding.ownerKey !== refreshOwnerKey
          || binding.source !== refreshSource || binding.boundSessionId !== refreshSessionId || binding.generation !== refreshGeneration
          || binding.canonicalReadEpoch !== refreshEpoch) return

        let refreshMalformedCount = 0
        const envelopes = rows.flatMap(row => {
          const migrated = toWorkbenchEnvelopes(row)
          if (migrated.length > 0) return migrated
          refreshMalformedCount += 1
          return []
        })
        if (draft.reconcilePending) {
          draft.seen.clear(); draft.activeIds.clear(); draft.interruptedIds.clear()
        }
        envelopes.push(...projectRecoveredDrafts(fragments, rows.reduce<number>((max, row) => {
          const sequence = row && typeof row === 'object' && 'sequence' in row ? Number(row.sequence) : 0
          return Math.max(max, Number.isSafeInteger(sequence) ? sequence : 0)
        }, 0)))
        // If refresh supersedes an initial bind read, fold events that arrived
        // while that read was in flight into the winning projection and release
        // the load buffer. Otherwise those events would remain stranded behind
        // the invalidated bind promise.
        const bufferedAtRefresh = draft.reconcilePending
          ? [...binding.buffered, ...draft.liveDuringReconcile]
          : binding.buffered
        // #81 L2：保留折入式投影（读快照建立后提交的 live 行不得被 replace 丢弃）。
        // 粒度互斥由 coverage 区间承担：journal 信封（单元 segment/逐 chunk）对
        // live 已应用区间完全覆盖者跳过——折叠状态在会话投影核里，live 行与 journal
        // 行同判幂等，整页重折即收敛。
        if (refreshMalformedCount > 0) fold.journalDiagnosticCount = refreshMalformedCount
        // #204③：foldLog 以本次 journal 权威集**整体替换**。此前 log 永远保留 bind 时代
        // 的旧信封实例——refresh 重建文档后它们不再与文档共享事件对象，等于把一整份
        // 旧事件图钉在内存里（大会话的主要留存浪费之一）。替换后 log 的信封与文档
        // timeline 共享同一语义事件对象（仅余信封壳），且被拒回滚的整页重折源恰好
        // 就是这份 journal 权威集（未提交的乐观行由 withPendingOptimistic 随后补入）。
        fold.log = []
        fold.ids.clear()
        publishCanonicalRead({
          readSource: refreshSource,
          readOwnerKey: refreshOwnerKey,
          readGeneration: refreshGeneration,
          readSessionId: refreshSessionId,
          envelopes,
          bufferedAtRead: bufferedAtRefresh,
          base: draft.reconcilePending ? createWorkbenchDocument(refreshSource) : current,
          malformedCount: refreshMalformedCount,
          canonicalDuration,
          canonicalHasTerminal,
          withLedgerEvidence: true,
        })
        draft.reconcilePending = false
        draft.liveDuringReconcile = []
      } catch (error) {
        if (binding.destroyed || bindingKey !== binding.boundSessionBindingKey || binding.ownerKey !== refreshOwnerKey
          || binding.source !== refreshSource || binding.boundSessionId !== refreshSessionId || binding.generation !== refreshGeneration
          || binding.canonicalReadEpoch !== refreshEpoch) return
        const bufferedAfterFailure = binding.buffered
        binding.buffered = []
        binding.loading = false
        // A failed refresh may have superseded the initial bind read. Keep
        // already-observed live/session-response events visible even though
        // the canonical reload itself is degraded.
        for (const envelope of bufferedAfterFailure) {
          runtime.applyDocument(foldEvent(envelope), {
            ownerKey: refreshOwnerKey,
            generation: refreshGeneration,
            preserveGeneration: true,
          })
        }
        updateRuntimeState({ status: 'degraded', error: error instanceof Error ? error.message : String(error) })
      }
    })()
    const pending = run.finally(() => {
      if (binding.refreshInFlight === pending) binding.refreshInFlight = null
    })
    binding.refreshInFlight = pending
    return pending
  }

  const feed = getCanonicalEventFeed()
  const unsubscribeDraftChunks = feed.onDraftChunk(applyDraftChunk)
  const unsubscribeDraftCommits = feed.onDraftCommit((ownerKey, draftId) => {
    if (binding.destroyed || binding.ownerKey !== ownerKey || !draft.activeIds.has(draftId)) return
    const session = binding.boundSession
    if (!session) return
    draft.reconcilePending = true
    void (async () => {
      if (binding.refreshInFlight) await binding.refreshInFlight.catch(() => {})
      if (binding.destroyed || binding.boundSession !== session) return
      draft.reconcilePending = true
      await refresh(session)
    })()
  })
  const commandsWithDraft = {
    ...commands,
    async resolveDraft(sessionId: string, draftId: string, action: 'keep' | 'discard') {
      if (binding.destroyed || binding.boundSessionId !== sessionId || !binding.ownerKey
        || !binding.boundSession || !draft.interruptedIds.has(draftId)) {
        return { ok: false, error: 'draft_not_bound' }
      }
      const ownerKey = binding.ownerKey
      const session = binding.boundSession
      try {
        if (action === 'keep') await keepInterruptedDraft(ownerKey, draftId)
        else if (!await discardInterruptedDraft(ownerKey, draftId)) return { ok: false, error: 'draft_not_found' }
        getCanonicalEventFeed().flush()
        if (binding.refreshInFlight) await binding.refreshInFlight
        draft.reconcilePending = true
        await refresh(session)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  return {
    runtime, appearance, sessionUi, commands: commandsWithDraft,
    /**
     * Project the response of the atomic `new_session` command into the same
     * disposable Workbench document used by canonical/live events.  This is a
     * transient bridge: it never appends to SQLite or the canonical journal.
     * The optional local Session.id lets callers publish before React's bind
     * effect runs; the response is buffered and consumed by bind().
     */
    applySessionResponse,
    runSessionControl,
    applyLocalSessionFact,
    refresh,
    async bind(session: Session | undefined): Promise<void> {
      const nextBindingKey = workbenchSessionBindingKey(session)
      // 幂等检查保持同步 no-op；折叠出口的就绪等待放在**同步状态前缀之后**：
      // boundSessionId/source 必须在本函数首个 await 前就位（发送入口的乐观投影
      // 依赖它们判定「已绑定」），Node 宿主的 wasm 导入即就绪，浏览器端在此补一次
      // 异步等待，后续 folding 都在就绪之后。
      if (binding.boundSessionBindingKey === nextBindingKey) return
      // Session objects are recreated for ordinary metadata updates (name,
      // lastReplyAt, autoName) and when canonical replay completes. Rebinding
      // in those cases replaces the whole document and looks like a page
      // refresh. Keep this seam idempotent; explicit identity changes still
      // pass through the normal reload path below. Workspace reloads use the
      // dedicated lifecycle/reload-token seam instead of rebinding here.
      binding.boundSessionBindingKey = nextBindingKey
      // Invalidate any in-flight refresh for the previous binding. Its own
      // epoch/key guard will make the eventual result a no-op; clearing the
      // pointer lets the new binding schedule its own refresh immediately.
      binding.canonicalReadEpoch += 1
      binding.refreshInFlight = null
      const nextGeneration = ++binding.generation
      // #204 ②：`turnEpoch` 是 runtime 局部的**单调**围栏（`workbenchRuntime.acceptDocument`
      // 对 live 帧执行 `options.turnEpoch < snapshot.turnEpoch` 即拒收）。绑定重建不得把它
      // 回落为 0——切回时 snapshot 的 epoch 仍停在切走前那一轮，回落会让切回后到达的思考帧
      // 被静默丢弃（正文截断在切换点），并在终帧后的 journal 重折里另起一块（思考块分裂）。
      // 这里承接当前值，新回合仍由 applyLive 的 user 帧推进（`turnEpoch += 1`）。
      binding.turnEpoch = runtime.getSnapshot().turnEpoch ?? 0
      binding.boundSessionId = session?.id
      binding.boundSession = session
      binding.boundProvider = session?.agentId || 'acp'
      binding.source = session?.source
      binding.ownerKey = session ? toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source }) : undefined
      binding.buffered = []
      draft.seen.clear(); draft.activeIds.clear(); draft.interruptedIds.clear()
      draft.reconcilePending = false; draft.liveDuringReconcile = []
      binding.malformedCount = 0
      fold.journalDiagnosticCount = 0
      // 绑定重建：折叠日志清空（journal 重放会重新入日志），文档由下面的整页折从空文档起。
      fold.log = []
      fold.ids.clear()
      binding.loading = Boolean(session)
      // #217：空文档的活性申报走有效权威（内核表态随 source 的 map 跨 rebind 保留；
      // 无表态回退时钟，语义与 #213 一致）。
      const bindLiveness = clock.effectiveLiveness(session?.source ?? '')
      runtime.replaceDocument(createWorkbenchDocument(session?.source ?? ''), {
        ownerKey: binding.ownerKey ?? `unbound:${nextGeneration}`, generation: nextGeneration, turnEpoch: binding.turnEpoch, terminalFence: null, sessionId: session?.id ?? null,
        // #213：**必须**随这发空文档申报权威值。不申报时 merge 会继承上一个会话的
        // `livenessSource`/`generating`（切走一个在途会话 ⇒ 空文档带 generating:true 发布一拍，
        // 页脚闪一次 spinner、调度器还会按"直播"处理）。
        livenessSource: bindLiveness.source,
        livenessGenerating: bindLiveness.generating,
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
      // #217：内核已表态「不在途」时，活动时钟不得顶起生成态（权威让位）。
      const activeClock = binding.source ? clock.activeUnsettledClock(binding.source) : undefined
      updateRuntimeState({
        status: binding.loading ? 'loading' : 'idle', error: null,
        ...(activeClock
          ? { generating: true, generationStart: activeClock.generationStart, lastTokenAt: activeClock.lastTokenAt, summary: null }
          : { generating: false, generationStart: 0, lastTokenAt: undefined, generationPhase: undefined, generationActivity: undefined, thinkingStart: undefined, summary: null }),
      })
      if (!session || !binding.ownerKey) return
      const loadingOwnerKey = binding.ownerKey
      const bindReadEpoch = binding.canonicalReadEpoch
      // loadAll 必须**同步**调用：hanging-load 测试在 bind() 返回的同步窗口内拿 release 句柄。
      await loadAll(loadingOwnerKey).then(async rows => {
        const fragments = await loadDrafts(loadingOwnerKey)
        if (binding.destroyed || binding.generation !== nextGeneration || binding.ownerKey !== loadingOwnerKey
          || binding.canonicalReadEpoch !== bindReadEpoch) return
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
        // #205：不再先 concat 再 flatMap——直接按序收集（冷重放这份数组与行数同阶，
        // 少一次整集合拷贝与中间数组）。浏览器快照轨照旧排在 journal 行之后。
        const envelopes: WorkbenchEventEnvelope[] = []
        const collect = (source: readonly unknown[]): void => {
          for (const row of source) {
            const migrated = toWorkbenchEnvelopes(row)
            if (migrated.length === 0) {
              binding.malformedCount += 1
              continue
            }
            for (const envelope of migrated) envelopes.push(envelope)
          }
        }
        collect(rows)
        envelopes.push(...projectRecoveredDrafts(fragments, rows.reduce<number>((max, row) => {
          const sequence = row && typeof row === 'object' && 'sequence' in row ? Number(row.sequence) : 0
          return Math.max(max, Number.isSafeInteger(sequence) ? sequence : 0)
        }, 0)))
        collect(browserSnapshot)
        // buffered 为空是冷切会话的常态：入参已是有序数组，整页一帧过界
        //（回放按页合批，边界穿越 2 次，与页内事件数无关）。
        if (binding.malformedCount > 0) fold.journalDiagnosticCount = binding.malformedCount
        // 冷装载 = 重建：显式以空文档为基座（不是续折当前文档）。
        // #213：本进程的回合时钟（turnClocks）是活性的权威来源，随文档一并申报——
        // 否则重放出的 `running` 尾行会让 generating 复活成永久「生成中」。
        // #217：权威升级为内核在途事实优先（kernel > clock，见 effectiveLiveness）。
        publishCanonicalRead({
          readSource: session.source,
          readOwnerKey: loadingOwnerKey,
          readGeneration: nextGeneration,
          readSessionId: session.id,
          envelopes,
          bufferedAtRead: binding.buffered,
          base: createWorkbenchDocument(session.source),
          malformedCount: binding.malformedCount,
          canonicalDuration,
          canonicalHasTerminal,
          withLedgerEvidence: false,
        })
      }).catch(error => {
        if (binding.destroyed || binding.generation !== nextGeneration || binding.ownerKey !== loadingOwnerKey
          || binding.canonicalReadEpoch !== bindReadEpoch) return
        binding.loading = false
        binding.buffered = []
        updateRuntimeState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      })
    },
    destroy() {
      if (binding.destroyed) return
      binding.destroyed = true
      unsubscribeTurnClockTerminal(); unsubscribeTerminalFallback(); unsubscribeEvents()
      unsubscribeDraftChunks(); unsubscribeDraftCommits()
      runtime.destroy(); appearance.destroy(); sessionUi.destroy()
      pendingSessionResponses.clear(); appliedSessionResponseKeys.clear(); transientSequenceBySource.clear()
      clock.clearAll(); echo.clear()
      fold.log = []; fold.ids.clear()
    },
  }
}
