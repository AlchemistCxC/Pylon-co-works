import type { Session } from '../../identityStore.ts'
import { toCanonicalOwnerKey, validateCanonicalEvent, type CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { migrateWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import { normalizeAgentEvent } from '../../domains/workbench/normalizers/agentEventNormalizer.ts'
import { createWorkbenchDocument, projectWorkbench, reduceWorkbenchEvent, type WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'
import { createSessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import { createZustandWorkbenchAppearanceStore } from '../../domains/workbench/zustandWorkbenchAppearanceStore.ts'
import { IS_TAURI } from '../../infrastructure/tauri/env.ts'
import { tauriCanonicalEventRepository } from '../../infrastructure/events/canonicalEventRepository.ts'
import { subscribePluginEvents } from '../../infrastructure/events/pluginEventBus.ts'
import { createAgentWorkbenchCommandFacade, type ResolvedWorkbenchInteraction } from './agentWorkbenchCommands.ts'

export interface AgentWorkbenchSessionRuntimeDependencies {
  loadAll(ownerKey: string): Promise<readonly unknown[]>
  subscribe(listener: (event: unknown) => void): () => void
}

function canonicalRowToWorkbench(row: unknown): readonly WorkbenchEventEnvelope[] | undefined {
  if (!row || typeof row !== 'object' || !('owner' in row) || !('rawPayload' in row) || !('eventType' in row)) return undefined
  if (validateCanonicalEvent(row).length > 0) return []
  const event = row as CanonicalConversationEvent
  const provider = event.provenance?.provider ?? event.owner.agentId
  const normalized = normalizeAgentEvent(event.rawPayload, {
    provider,
    sessionId: event.owner.localSessionId,
    sourceId: event.eventId,
    sequence: event.sequence,
    recordedAt: event.receivedAt,
    occurredAt: event.occurredAt,
    agentId: event.owner.agentId,
    provenance: event.provenance ?? { origin: 'migration', trust: 'unverified', provider },
  })
  return normalized.events.map(envelope => Object.freeze({
    ...envelope,
    eventId: normalized.events.length === 1 ? event.eventId : envelope.eventId,
    identity: Object.freeze({ ...event.identity, ...envelope.identity }),
  }))
}

function toWorkbenchEnvelopes(value: unknown): readonly WorkbenchEventEnvelope[] {
  const canonical = canonicalRowToWorkbench(value)
  if (canonical !== undefined) return canonical
  const migrated = migrateWorkbenchEnvelope(value)
  return migrated.ok ? [migrated.value] : []
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
    loadAll: ownerKey => IS_TAURI ? tauriCanonicalEventRepository().loadAll(ownerKey) : Promise.resolve([]),
    subscribe: listener => subscribePluginEvents(listener),
  }
}

export function createAgentWorkbenchSessionRuntime(dependencies: AgentWorkbenchSessionRuntimeDependencies = defaultDependencies()) {
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

  const updateRuntimeState = (patch: Parameters<typeof runtime.update>[0]) => {
    runtime.update({ ...patch, document: runtime.getSnapshot().document })
  }

  const applyLive = (envelope: WorkbenchEventEnvelope) => {
    if (loading) { buffered.push(envelope); return }
    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(envelope.sessionId)
    runtime.applyDocument(reduceWorkbenchEvent(current, envelope), { ownerKey, generation })
  }
  const unsubscribeEvents = dependencies.subscribe(event => {
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
      ownerKey = session ? toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source }) : undefined
      buffered = []
      malformedCount = 0
      loading = Boolean(session)
      runtime.replaceDocument(createWorkbenchDocument(session?.source ?? ''), {
        ownerKey: ownerKey ?? `unbound:${nextGeneration}`, generation: nextGeneration, sessionId: session?.id ?? null,
      })
      updateRuntimeState({ status: loading ? 'loading' : 'idle', error: null })
      if (!session || !ownerKey) return
      const loadingOwnerKey = ownerKey
      await dependencies.loadAll(loadingOwnerKey).then(rows => {
        if (destroyed || generation !== nextGeneration || ownerKey !== loadingOwnerKey) return
        const envelopes = rows.flatMap(row => {
          const migrated = toWorkbenchEnvelopes(row)
          if (migrated.length > 0) return migrated
          malformedCount += 1
          return []
        })
        const projected = projectWorkbench([...envelopes, ...buffered], { initialDocument: createWorkbenchDocument(session.source) }).document
        const document = malformedCount > 0 ? withJournalDiagnostic(projected, malformedCount) : projected
        buffered = []; loading = false
        runtime.replaceDocument(document, { ownerKey: loadingOwnerKey, generation: nextGeneration, sessionId: session.id })
        updateRuntimeState(malformedCount > 0
          ? { status: 'degraded', error: `canonical journal 有 ${malformedCount} 条事件无法迁移` }
          : { status: 'ready', error: null })
      }).catch(error => {
        if (destroyed || generation !== nextGeneration || ownerKey !== loadingOwnerKey) return
        loading = false; buffered = []
        updateRuntimeState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      })
    },
    destroy() {
      if (destroyed) return
      destroyed = true; unsubscribeEvents(); runtime.destroy(); appearance.destroy(); sessionUi.destroy()
    },
  }
}
