import type { Session } from '../../identityStore.ts'
import { toCanonicalOwnerKey, validateCanonicalEvent, type CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { createWorkbenchEnvelope, migrateWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import { normalizeAgentEvent } from '../../domains/workbench/normalizers/agentEventNormalizer.ts'
import { createWorkbenchDocument, projectWorkbench, reduceWorkbenchEvent, type WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'
import { reduceGenerationActivity } from '../../domains/activity/generationStateMachine.ts'
import { createSessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import { createZustandWorkbenchAppearanceStore } from '../../domains/workbench/zustandWorkbenchAppearanceStore.ts'
import { IS_TAURI, isBrowserMockRuntime } from '../../infrastructure/tauri/env.ts'
import { tauriCanonicalEventRepository } from '../../infrastructure/events/canonicalEventRepository.ts'
import { subscribePluginEvents } from '../../infrastructure/events/pluginEventBus.ts'
import { getChatController, type ChatControllerHandle } from '../../components/chat/chatEventController.ts'
import { messageStorageKey, parseMessageSnapshot } from '../../components/chat/messagePersistence.ts'
import type { Message } from '../../components/chat/messageTypes.ts'
import { createAgentWorkbenchCommandFacade, type ResolvedWorkbenchInteraction } from './agentWorkbenchCommands.ts'

export interface AgentWorkbenchSessionRuntimeDependencies {
  loadAll(ownerKey: string): Promise<readonly unknown[]>
  subscribe(listener: (event: unknown) => void): () => void
  commands?: Partial<import('./agentWorkbenchCommands.ts').AgentWorkbenchCommandDependencies>
  chatController?: () => Pick<ChatControllerHandle,
    'subscribe' | 'getGenerating' | 'getStartTime' | 'getLastActivityAt' | 'getGenerationPhase' | 'getGenerationActivity' | 'rejectOptimisticUser'
    | 'getThinkingStart' | 'getTokenCount' | 'getSummary'> | null
}

function canonicalRowToWorkbench(row: unknown): readonly WorkbenchEventEnvelope[] | undefined {
  if (!row || typeof row !== 'object' || !('owner' in row) || !('rawPayload' in row) || !('eventType' in row)) return undefined
  if (validateCanonicalEvent(row).length > 0) return []
  const event = row as CanonicalConversationEvent
  const provider = event.provenance?.provider ?? event.owner.agentId
  const optimistic = isOptimisticUserEvent(event.rawPayload)
  const normalized = normalizeAgentEvent(event.rawPayload, {
    provider,
    sessionId: event.owner.localSessionId,
    sourceId: event.eventId,
    sequence: event.sequence,
    recordedAt: event.receivedAt,
    occurredAt: event.occurredAt,
    agentId: event.owner.agentId,
    provenance: optimistic
      ? { origin: 'optimistic-local', trust: 'unverified', provider }
      : event.provenance ?? { origin: 'migration', trust: 'unverified', provider },
  })
  return normalized.events.map(envelope => Object.freeze({
    ...envelope,
    eventId: normalized.events.length === 1 ? event.eventId : envelope.eventId,
    identity: Object.freeze({ ...event.identity, ...envelope.identity }),
  }))
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

/** Browser/demo compatibility bridge. The visual seed predates the Workbench
 * journal and stores Message[] snapshots; terminal-like renders only the
 * Workbench projection, so hydrate those snapshots into provider-neutral events.
 */
export function messageSnapshotToWorkbenchEnvelopes(sessionId: string, messages: readonly Message[]): readonly WorkbenchEventEnvelope[] {
  const recordedBase = Date.now() - Math.max(0, messages.length - 1) * 1000
  const envelopes: WorkbenchEventEnvelope[] = []
  let sequence = 0
  messages.forEach((message, index) => {
    const messageId = message.id || `snapshot-message-${index + 1}`
    const recordedAt = new Date(recordedBase + index * 1000).toISOString()
    const identity = { messageId }
    const source = { provider: 'browser-demo', sourceId: messageId }
    const provenance = { origin: 'migration' as const, trust: 'unverified' as const, provider: 'browser-demo', orderConfidence: 'observed' as const, synthetic: { reason: 'message-snapshot-bridge' } }
    const text = message.content || ''
    const parts: Array<{ kind: 'text' | 'markdown'; text: string }> = text
      ? [{ kind: message.role === 'assistant' ? 'markdown' : 'text', text }]
      : []
    const push = (event: WorkbenchEventEnvelope['event'], suffix: string) => {
      sequence += 1
      envelopes.push(createWorkbenchEnvelope({
        eventId: `snapshot:${sessionId}:${messageId}:${suffix}`,
        sessionId, sequence, recordedAt, occurredAt: recordedAt,
        source, identity, provenance, event,
      }))
    }
    if (message.role === 'tool') {
      const toolCallId = messageId
      const tool: Record<string, string | Array<{ kind: 'text' | 'markdown'; text: string }>> = {
        toolCallId, name: message.toolName || 'Tool',
      }
      if (message.toolKind) tool.kind = message.toolKind
      if (message.toolInput) tool.input = message.toolInput
      if (message.toolStatus) tool.status = message.toolStatus
      if (message.toolOutput) tool.progress = message.toolOutput
      push({ type: 'tool.started', tool }, 'tool-start')
      if (message.running || (message.toolStatus && !['completed', 'failed', 'cancelled'].includes(message.toolStatus))) {
        push({ type: 'tool.progress', tool }, 'tool-progress')
      } else {
        const terminalType = message.toolStatus === 'failed' ? 'tool.failed' : 'tool.completed'
        const terminalTool = { ...tool, ...(parts.length > 0 ? { parts } : {}), ...(message.toolOutput ? { rawOutput: message.toolOutput } : {}) }
        push({ type: terminalType, tool: terminalTool, result: message.toolOutput }, 'tool-end')
      }
      return
    }
    if (message.role === 'reasoning') {
      push({ type: 'reasoning.delta', parts }, 'reasoning-delta')
      push({ type: 'reasoning.completed', parts: [], durationMs: message.thoughtDurationMs }, 'reasoning-end')
      return
    }
    if (message.role === 'assistant') {
      push({ type: 'message.started', role: 'assistant', parts: [] }, 'message-start')
      push({ type: 'message.delta', role: 'assistant', parts }, 'message-delta')
      push({ type: 'message.completed', role: 'assistant', parts: [] }, 'message-end')
      return
    }
    push({ type: 'message.completed', role: 'user', parts }, 'message-end')
  })
  return envelopes
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

function defaultDependencies(): AgentWorkbenchSessionRuntimeDependencies {
  return {
    loadAll: ownerKey => {
      if (IS_TAURI && !isBrowserMockRuntime()) return tauriCanonicalEventRepository().loadAll(ownerKey)
      // Browser snapshots are keyed by local Session.id, not the JSON owner key.
      // bind() adds that compatibility source once it has the concrete Session.
      return Promise.resolve([])
    },
    subscribe: listener => subscribePluginEvents(listener),
  }
}

export function createAgentWorkbenchSessionRuntime(dependencies: Partial<AgentWorkbenchSessionRuntimeDependencies> = {}) {
  const defaults = defaultDependencies()
  const loadAll = dependencies.loadAll ?? defaults.loadAll
  const subscribe = dependencies.subscribe ?? defaults.subscribe
  const chatController = () => dependencies.chatController?.() ?? getChatController()
  const runtime = createWorkbenchRuntime({
    sessionId: null, status: 'idle', messages: [], streamingText: '', streamingThinking: '',
    generating: false, generationStart: 0, tokenCount: 0, summary: null, tasks: [],
    availableModels: [], activeModel: '', availableModes: [], activeMode: '', canAttach: false,
    promptImage: false, error: null, document: createWorkbenchDocument(''),
  })
  const appearance = createZustandWorkbenchAppearanceStore()
  const sessionUi = createSessionUiStore()
  let boundSessionId: string | undefined
  const commands = createAgentWorkbenchCommandFacade({
    ...dependencies.commands,
    rejectOptimisticUser: (targetSource, clientMessageId) => chatController()?.rejectOptimisticUser(targetSource, clientMessageId),
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
  let loading = false
  let buffered: WorkbenchEventEnvelope[] = []
  let malformedCount = 0
  let destroyed = false
  let unsubscribeSourceRuntime = () => {}
  const pendingOptimisticBySource = new Map<string, Array<{
    clientMessageId: string
    content: string
    priorCanonicalMatches: number
    envelope: WorkbenchEventEnvelope
  }>>()

  const updateRuntimeState = (patch: Parameters<typeof runtime.update>[0]) => {
    runtime.update({ ...patch, document: runtime.getSnapshot().document })
  }

  const syncSourceRuntime = (targetSource: string) => {
    if (destroyed || source !== targetSource) return
    const controller = chatController()
    if (!controller) return
    const generating = controller.getGenerating(targetSource)
    updateRuntimeState({
      generating,
      generationStart: generating ? controller.getStartTime(targetSource) : 0,
      lastTokenAt: controller.getLastActivityAt(targetSource),
      generationPhase: controller.getGenerationPhase(targetSource),
      // Legacy controllers may not expose the activity axis. Write this
      // field explicitly so a missing getter clears stale context from a
      // previous session instead of leaving an old tool label behind.
      generationActivity: controller.getGenerationActivity?.(targetSource),
      thinkingStart: controller.getThinkingStart(targetSource),
      tokenCount: controller.getTokenCount(targetSource),
      summary: controller.getSummary(targetSource) ?? null,
    })
  }

  const followSourceRuntime = (targetSource: string | undefined) => {
    unsubscribeSourceRuntime()
    unsubscribeSourceRuntime = () => {}
    if (!targetSource) return
    const controller = chatController()
    if (!controller) return
    syncSourceRuntime(targetSource)
    unsubscribeSourceRuntime = controller.subscribe(targetSource, () => syncSourceRuntime(targetSource))
  }

  function projectOptimisticUser(targetSource: string, content: string, clientMessageId: string): void {
    if (destroyed || source !== targetSource || !boundSessionId) return
    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(targetSource)
    const existing = pendingOptimisticBySource.get(targetSource) ?? []
    if (existing.some(item => item.clientMessageId === clientMessageId)) return
    const now = Date.now()
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
    runtime.applyDocument(reduceWorkbenchEvent(current, envelope), { ownerKey, generation })
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
    if (!rejected) return
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
    const envelope = confirmPendingFromEnvelope(incoming)
    if (loading) { buffered.push(envelope); return }
    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(envelope.sessionId)
    runtime.applyDocument(reduceWorkbenchEvent(current, envelope), { ownerKey, generation })
  }
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

  return {
    runtime, appearance, sessionUi, commands,
    async bind(session: Session | undefined): Promise<void> {
      const nextGeneration = ++generation
      boundSessionId = session?.id
      source = session?.source
      followSourceRuntime(source)
      ownerKey = session ? toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source }) : undefined
      buffered = []
      malformedCount = 0
      loading = Boolean(session)
      runtime.replaceDocument(createWorkbenchDocument(session?.source ?? ''), {
        ownerKey: ownerKey ?? `unbound:${nextGeneration}`, generation: nextGeneration, sessionId: session?.id ?? null,
      })
      updateRuntimeState({
        status: loading ? 'loading' : 'idle', error: null,
        ...(source && chatController()?.getGenerating(source)
          ? {}
          : { generating: false, generationStart: 0, lastTokenAt: undefined, generationPhase: undefined, generationActivity: undefined, thinkingStart: undefined, summary: null }),
      })
      if (source) syncSourceRuntime(source)
      if (!session || !ownerKey) return
      const loadingOwnerKey = ownerKey
      await loadAll(loadingOwnerKey).then(rows => {
        if (destroyed || generation !== nextGeneration || ownerKey !== loadingOwnerKey) return
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
        syncSourceRuntime(session.source)
      }).catch(error => {
        if (destroyed || generation !== nextGeneration || ownerKey !== loadingOwnerKey) return
        loading = false; buffered = []
        updateRuntimeState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      })
    },
    destroy() {
      if (destroyed) return
      destroyed = true; unsubscribeSourceRuntime(); unsubscribeEvents(); runtime.destroy(); appearance.destroy(); sessionUi.destroy()
    },
  }
}
