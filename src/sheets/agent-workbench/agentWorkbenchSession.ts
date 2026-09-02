import type { Session } from '../../identityStore.ts'
import { toCanonicalOwnerKey, validateCanonicalEvent, type CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { createWorkbenchEnvelope, migrateWorkbenchEnvelope, type JsonValue, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
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
import {
  extractChoiceId,
  extractChoiceLabel,
  extractConfigOptionId,
  extractModeConfig,
  extractModelConfig,
  sessionResponseObject,
  type SessionResponseObject,
} from '../../infrastructure/acp/chatContracts.ts'

export interface AgentWorkbenchSessionRuntimeDependencies {
  loadAll(ownerKey: string): Promise<readonly unknown[]>
  subscribe(listener: (event: unknown) => void): () => void
  commands?: Partial<import('./agentWorkbenchCommands.ts').AgentWorkbenchCommandDependencies>
  chatController?: () => Pick<ChatControllerHandle,
    'subscribe' | 'getGenerating' | 'getStartTime' | 'getLastActivityAt' | 'getGenerationPhase' | 'getGenerationActivity' | 'rejectOptimisticUser'
    | 'getThinkingStart' | 'getTokenCount' | 'getSummary'> | null
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseChoice(value: unknown, kind?: 'model' | 'mode'): { id: string; label: string } | undefined {
  const id = extractChoiceId(value, kind)
  if (!id) return undefined
  return { id, label: extractChoiceLabel(value, id) ?? id }
}

function toJsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 8) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const items = value.map(item => toJsonValue(item, depth + 1)).filter((item): item is JsonValue => item !== undefined)
    return items
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const json = toJsonValue(item, depth + 1)
      if (json !== undefined) result[key] = json
    }
    return result
  }
  return undefined
}

function responseChoiceList(value: unknown): readonly { id: string; label: string }[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const choices: Array<{ id: string; label: string }> = []
  for (const item of value) {
    const choice = responseChoice(item)
    if (!choice || seen.has(choice.id.toLowerCase())) continue
    seen.add(choice.id.toLowerCase())
    choices.push(choice)
  }
  return choices
}

function syntheticSessionOption(
  kind: 'model' | 'mode',
  response: SessionResponseObject,
): Record<string, JsonValue> | undefined {
  const state = kind === 'model' ? response.models : response.modes
  if (!state) return undefined
  // Keep the discriminant on the original response instead of indexing the
  // `SessionModels | SessionModes` union through a conditional state variable;
  // this also makes the two wire shapes explicit for future schema additions.
  const rawChoices = kind === 'model'
    ? response.models?.availableModels ?? response.models?.available_models
    : response.modes?.availableModes ?? response.modes?.available_modes
  const choices = responseChoiceList(rawChoices)
  const current = kind === 'model'
    ? extractModelConfig(response.configOptions, response).model
    : extractModeConfig(response).mode
  if (!current && choices.length === 0) return undefined
  const schema: Record<string, JsonValue> = {
    options: choices.map(choice => ({ id: choice.id, label: choice.label })),
  }
  return {
    id: kind,
    label: kind === 'model' ? '模型' : '模式',
    valueType: 'select',
    editable: true,
    ...(current ? { value: current } : {}),
    schema,
  }
}

function optionId(value: unknown): string | undefined {
  return extractConfigOptionId(value)
}

function mergeSessionResponseOptions(response: SessionResponseObject): readonly JsonValue[] {
  const options: JsonValue[] = (Array.isArray(response.configOptions)
    ? response.configOptions
    : Array.isArray(response.config_options) ? response.config_options : [])
    .map(item => toJsonValue(item))
    .filter((item): item is JsonValue => item !== undefined)
  for (const synthetic of [syntheticSessionOption('model', response), syntheticSessionOption('mode', response)]) {
    if (!synthetic) continue
    const syntheticId = String(synthetic.id).toLowerCase()
    const index = options.findIndex(item => optionId(item)?.toLowerCase() === syntheticId)
    if (index < 0) {
      options.push(synthetic)
      continue
    }
    const existing = options[index]
    if (!isRecord(existing)) continue
    const merged: Record<string, JsonValue> = { ...existing }
    // Preserve provider metadata, but ensure the standard models/modes state
    // supplies choices/current value when the provider's config option omitted
    // them.  This gives every renderer one canonical selector surface.
    if (!('value' in merged) && 'value' in synthetic) merged.value = synthetic.value!
    if (!('valueType' in merged) && 'valueType' in synthetic) merged.valueType = synthetic.valueType!
    if (!('schema' in merged) && 'schema' in synthetic) merged.schema = synthetic.schema!
    options[index] = merged
  }
  return Object.freeze(options)
}

function responseProjectionKey(response: SessionResponseObject): string {
  try {
    return JSON.stringify({
      models: response.models,
      modes: response.modes,
      configOptions: response.configOptions ?? response.config_options,
    })
  } catch {
    return String(response)
  }
}

function shortHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function sessionResponseEnvelope(
  sessionId: string,
  provider: string,
  response: SessionResponseObject,
  sequence: number,
): WorkbenchEventEnvelope {
  const model = extractModelConfig(response.configOptions, response).model
  const mode = extractModeConfig(response).mode
  const options = mergeSessionResponseOptions(response)
  const fingerprint = shortHash(responseProjectionKey(response))
  return createWorkbenchEnvelope({
    eventId: `session-response:${sessionId}:${fingerprint}`,
    sessionId,
    sequence: Math.max(1, sequence),
    recordedAt: new Date().toISOString(),
    source: { provider: provider || 'acp', sourceId: `session-response:${fingerprint}` },
    identity: { runId: `session-response:${fingerprint}` },
    provenance: {
      origin: 'local-observed',
      trust: 'authoritative',
      provider: provider || 'acp',
      orderConfidence: 'observed',
      synthetic: { reason: 'session-new-response' },
    },
    event: {
      type: 'session.started',
      status: 'ready',
      ...(model ? { model } : {}),
      ...(mode ? { mode } : {}),
      ...(options.length > 0 ? { options } : {}),
    },
  })
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
  let boundProvider = 'acp'
  let boundSessionBindingKey: string | undefined
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

  const updateRuntimeState = (patch: Parameters<typeof runtime.update>[0]) => {
    runtime.update({ ...patch, document: runtime.getSnapshot().document })
  }

  const syncSourceRuntime = (targetSource: string) => {
    if (destroyed || source !== targetSource) return
    const controller = chatController()
    if (!controller) return
    const generating = controller.getGenerating(targetSource)
    const controllerSummary = controller.getSummary(targetSource)
    const existingSummary = runtime.getSnapshot().summary
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
      // Keep the display-only restored terminal summary stable across later
      // controller notifications that still have no in-memory summary.
      summary: controllerSummary ?? (!generating && existingSummary?.reason === 'done' ? existingSummary : null),
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
    runtime.applyDocument(reduceWorkbenchEvent(current, envelope), { ownerKey, generation, preserveGeneration: true })
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

  const enqueueSessionResponse = (response: SessionResponseObject, targetSessionId: string): void => {
    if (destroyed || !boundSessionId || !source || targetSessionId !== boundSessionId) return
    const key = responseProjectionKey(response)
    const applied = appliedSessionResponseKeys.get(targetSessionId) ?? new Set<string>()
    if (applied.has(key)) return
    applied.add(key)
    appliedSessionResponseKeys.set(targetSessionId, applied)

    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(source)
    const bufferedMax = buffered.reduce((max, item) => Math.max(max, item.sequence), 0)
    const previousTransient = transientSequenceBySource.get(source) ?? 0
    const sequence = Math.max(current.revision, bufferedMax, previousTransient) + 1
    transientSequenceBySource.set(source, sequence)
    const envelope = sessionResponseEnvelope(source, boundProvider, response, sequence)
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
    runtime.applyDocument(reduceWorkbenchEvent(current, envelope), { ownerKey, generation, preserveGeneration: true })
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

  const refresh = async (session: Session | undefined): Promise<void> => {
    if (destroyed || !session || !ownerKey || !boundSessionId || !source) return
    const bindingKey = workbenchSessionBindingKey(session)
    const refreshOwnerKey = ownerKey
    const refreshSource = source
    const refreshSessionId = boundSessionId
    const refreshGeneration = generation
    if (bindingKey !== boundSessionBindingKey || session.id !== refreshSessionId || session.source !== refreshSource) return
    if (refreshInFlight) return refreshInFlight
    const refreshEpoch = ++canonicalReadEpoch

    const run = (async () => {
      try {
        const rows = await loadAll(refreshOwnerKey)
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
        // Start from the live document so already-applied event ids remain
        // idempotent while newly persisted terminal updates (for example a tool
        // completion that raced the initial read) are folded in place.
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
        }
        syncSourceRuntime(refreshSource)
        const settled = runtime.getSnapshot()
        if (!settled.generating && !settled.summary && (settled.document?.messages.length ?? 0) > 0) {
          updateRuntimeState({
            summary: {
              elapsedMs: 0,
              tokenCount: settled.tokenCount,
              completedFrame: '',
              reason: 'done',
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
      boundSessionId = session?.id
      boundProvider = session?.agentId || 'acp'
      source = session?.source
      followSourceRuntime(source)
      ownerKey = session ? toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source }) : undefined
      buffered = []
      malformedCount = 0
      loading = Boolean(session)
      runtime.replaceDocument(createWorkbenchDocument(session?.source ?? ''), {
        ownerKey: ownerKey ?? `unbound:${nextGeneration}`, generation: nextGeneration, sessionId: session?.id ?? null,
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
      updateRuntimeState({
        status: loading ? 'loading' : 'idle', error: null,
        ...(source && chatController()?.getGenerating(source)
          ? {}
          : { generating: false, generationStart: 0, lastTokenAt: undefined, generationPhase: undefined, generationActivity: undefined, thinkingStart: undefined, summary: null }),
      })
      if (source) syncSourceRuntime(source)
      if (!session || !ownerKey) return
      const loadingOwnerKey = ownerKey
      const bindReadEpoch = canonicalReadEpoch
      await loadAll(loadingOwnerKey).then(rows => {
        if (destroyed || generation !== nextGeneration || ownerKey !== loadingOwnerKey
          || canonicalReadEpoch !== bindReadEpoch) return
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
        // A restarted process has no in-memory controller summary, while the
        // canonical document already contains the completed turn. Publish a
        // display-only done summary so the footer remains in its terminal
        // state instead of disappearing; this does not add a journal event.
        const settled = runtime.getSnapshot()
        if (!settled.generating && !settled.summary && (settled.document?.messages.length ?? 0) > 0) {
          updateRuntimeState({
            summary: {
              elapsedMs: 0,
              tokenCount: settled.tokenCount,
              completedFrame: '',
              reason: 'done',
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
      destroyed = true; unsubscribeSourceRuntime(); unsubscribeEvents(); runtime.destroy(); appearance.destroy(); sessionUi.destroy()
      pendingSessionResponses.clear(); appliedSessionResponseKeys.clear(); transientSequenceBySource.clear()
    },
  }
}
