import type { Message } from '../../components/chat/messageTypes.ts'
import type { PlanEntry } from '../tasks/planTypes.ts'
import { normalizePlanEntries, type PlanEntryV2 } from './plan/goalModel.ts'
import type { GenerationPhase, GenerationSummary } from './generationFooterContracts.ts'
import type { WorkbenchDocument, WorkbenchMessage } from './workbenchProjector.ts'
import { createWorkbenchDocument, selectGoal, selectPlan } from './workbenchProjector.ts'
import type { JsonValue } from './events/workbenchEventSchema.ts'

export type WorkbenchRuntimeStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'error'

/** Legacy chat plan rows and canonical C08 plan rows coexist only at the runtime adapter boundary. */
export type WorkbenchTaskEntry = PlanEntry | PlanEntryV2

export type WorkbenchRuntimeSlice =
  | 'document' | 'timeline' | 'messages' | 'activities' | 'interactions'
  | 'session' | 'usage' | 'plan' | 'goal' | 'assist' | 'diagnostics' | 'extensions'
  | 'config' | 'commands' | 'tasks' | 'streaming' | 'capabilities'

export interface WorkbenchRuntimeSnapshot {
  revision: number
  sessionId: string | null
  /** Session owner identity used to reject late events after a session switch. */
  ownerKey?: string
  /** Agent/runtime generation associated with the current owner. */
  generation?: number
  status: WorkbenchRuntimeStatus
  messages: readonly Message[]
  streamingText: string
  streamingThinking: string
  generating: boolean
  generationPhase?: GenerationPhase
  generationStart: number
  lastTokenAt?: number
  tokenCount: number
  summary: GenerationSummary | null
  tasks: readonly WorkbenchTaskEntry[]
  thinkingStart?: number
  availableModels: readonly string[]
  activeModel: string
  availableModes: readonly string[]
  activeMode: string
  canAttach: boolean
  promptImage: boolean
  error: string | null
  /** A04 projection view; legacy fields remain compatibility selectors for the current Solid adapter. */
  document?: WorkbenchDocument
}

export interface WorkbenchRuntime {
  getSnapshot(): WorkbenchRuntimeSnapshot
  subscribe(listener: () => void): () => void
  getSlice<T = unknown>(slice: WorkbenchRuntimeSlice): T
  subscribeSlice(slice: WorkbenchRuntimeSlice, listener: () => void): () => void
}

export interface PreviewWorkbenchRuntime extends WorkbenchRuntime {
  setSnapshot(snapshot: WorkbenchRuntimeSnapshot): void
  update(patch: Partial<Omit<WorkbenchRuntimeSnapshot, 'revision'>>): void
  destroy(): void
  applyDocument(document: WorkbenchDocument, options?: WorkbenchDocumentApplyOptions): void
  replaceDocument(document: WorkbenchDocument, options?: WorkbenchDocumentApplyOptions): void
}

export interface WorkbenchDocumentApplyOptions {
  /** Owner key is stable for one session binding (agent + source + session). */
  readonly ownerKey?: string
  /** Lower generations are stale and are ignored once a newer one is active. */
  readonly generation?: number
  /** replaceDocument may explicitly clear the active session. */
  readonly sessionId?: string | null
}

/** Mutable document runtime used by production composition and preview fixtures. */
export function createWorkbenchRuntime(
  initial: Omit<WorkbenchRuntimeSnapshot, 'revision'>,
): PreviewWorkbenchRuntime {
  let revision = 0
  let activeOwnerKey = initial.ownerKey
  let activeGeneration = initial.generation
  let snapshot = freezeSnapshot({ ...initial, revision, document: initial.document ?? documentFromLegacy(initial) })
  const listeners = new Set<() => void>()
  const sliceListeners = new Map<WorkbenchRuntimeSlice, Set<() => void>>()
  let destroyed = false

  const publish = (next: WorkbenchRuntimeSnapshot) => {
    if (destroyed || runtimeSnapshotsEqual(snapshot, next)) return
    const previous = snapshot
    revision += 1
    snapshot = freezeSnapshot({ ...next, revision, document: next.document ?? documentFromLegacy(next) })
    for (const listener of [...listeners]) listener()
    for (const slice of sliceListeners.keys()) {
      if (sliceChanged(previous, snapshot, slice)) {
        for (const listener of [...(sliceListeners.get(slice) ?? [])]) listener()
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSlice<T = unknown>(slice: WorkbenchRuntimeSlice): T {
      return selectSlice(snapshot, slice) as T
    },
    subscribeSlice(slice, listener) {
      if (destroyed) return () => {}
      const current = sliceListeners.get(slice) ?? new Set<() => void>()
      current.add(listener)
      sliceListeners.set(slice, current)
      return () => {
        current.delete(listener)
        if (current.size === 0) sliceListeners.delete(slice)
      }
    },
    setSnapshot(next) {
      publish(next)
    },
    update(patch) {
      const next = { ...snapshot, ...patch, revision }
      if (!Object.prototype.hasOwnProperty.call(patch, 'document') && legacyDocumentFields.some(field => Object.prototype.hasOwnProperty.call(patch, field))) {
        next.document = documentFromLegacy(next)
      }
      publish(next)
    },
    applyDocument(document, options = {}) {
      if (!acceptDocument(options)) return
      const nextDocument = freezeDocument(document, snapshot.document)
      publish({ ...snapshot, ...legacyFieldsFromDocument(nextDocument), document: nextDocument, sessionId: nextDocument.sessionId || snapshot.sessionId, ownerKey: options.ownerKey ?? activeOwnerKey, generation: options.generation ?? activeGeneration })
    },
    replaceDocument(document, options = {}) {
      if (!acceptDocument(options, true)) return
      const nextDocument = freezeDocument(document)
      publish({ ...snapshot, ...legacyFieldsFromDocument(nextDocument), document: nextDocument, sessionId: options.sessionId === undefined ? nextDocument.sessionId || snapshot.sessionId : options.sessionId, ownerKey: options.ownerKey ?? activeOwnerKey, generation: options.generation ?? activeGeneration })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      listeners.clear()
      sliceListeners.clear()
    },
  }

  function acceptDocument(options: WorkbenchDocumentApplyOptions, replace = false): boolean {
    if (options.generation !== undefined && (!Number.isSafeInteger(options.generation) || options.generation < 0)) return false
    const ownerChanged = options.ownerKey !== undefined && options.ownerKey !== activeOwnerKey
    if (ownerChanged && !replace) return false
    if (options.generation !== undefined && activeGeneration !== undefined && options.generation < activeGeneration && !(replace && ownerChanged)) return false
    if (replace && options.ownerKey !== undefined) activeOwnerKey = options.ownerKey
    if (replace && options.generation !== undefined) activeGeneration = options.generation
    return true
  }
}

/** Preview compatibility name; production callers use createWorkbenchRuntime. */
export function createPreviewWorkbenchRuntime(
  initial: Omit<WorkbenchRuntimeSnapshot, 'revision'>,
): PreviewWorkbenchRuntime {
  return createWorkbenchRuntime(initial)
}

function runtimeSnapshotsEqual(left: WorkbenchRuntimeSnapshot, right: WorkbenchRuntimeSnapshot): boolean {
  if (left === right) return true
  // Bug4（2026-08-20）：弃用全量 JSON.stringify 深比较——流式高频 tick 会对整个含全部历史消息
  // 的 snapshot 做一次 O(总字节) 序列化，消息越多越慢（实测 1000 条 ≈1.4ms/tick，成为流式卡顿
  // 源头）。改为逐字段浅比较：messages/tasks/availableModels 等数组字段在 freezeSnapshot 下引用
  // 稳定，引用相同即视为一致（避免把"仅 streamingText 变化"误当成整包变化）。
  return (
    left.sessionId === right.sessionId &&
    left.ownerKey === right.ownerKey &&
    left.generation === right.generation &&
    left.status === right.status &&
    left.messages === right.messages &&
    left.streamingText === right.streamingText &&
    left.streamingThinking === right.streamingThinking &&
    left.generating === right.generating &&
    left.generationPhase === right.generationPhase &&
    left.generationStart === right.generationStart &&
    left.lastTokenAt === right.lastTokenAt &&
    left.tokenCount === right.tokenCount &&
    left.summary === right.summary &&
    left.tasks === right.tasks &&
    left.thinkingStart === right.thinkingStart &&
    left.availableModels === right.availableModels &&
    left.activeModel === right.activeModel &&
    left.availableModes === right.availableModes &&
    left.activeMode === right.activeMode &&
    left.canAttach === right.canAttach &&
    left.promptImage === right.promptImage &&
    left.error === right.error
    && left.document === right.document
  )
}

function freezeSnapshot(snapshot: WorkbenchRuntimeSnapshot): WorkbenchRuntimeSnapshot {
  if (!Object.isFrozen(snapshot.messages)) snapshot.messages = Object.freeze([...snapshot.messages])
  if (!Object.isFrozen(snapshot.tasks)) snapshot.tasks = Object.freeze([...snapshot.tasks])
  if (snapshot.document && !Object.isFrozen(snapshot.document)) snapshot.document = freezeDocument(snapshot.document)
  return Object.freeze(snapshot)
}

function freezeDocument(document: WorkbenchDocument, previous?: WorkbenchDocument): WorkbenchDocument {
  const freezeItems = <T extends object>(
    items: readonly T[],
    previousItems?: readonly T[],
    freezeItem: (item: T) => T = item => Object.freeze({ ...item }) as T,
  ): readonly T[] => {
    if (items === previousItems && Object.isFrozen(items)) return items
    return Object.freeze(items.map((item, index) => item === previousItems?.[index] && Object.isFrozen(item)
      ? item
      : freezeItem(item)))
  }
  const session = document.session === previous?.session && Object.isFrozen(document.session)
    ? document.session
    : Object.freeze({
      ...document.session,
      ...(document.session.usage ? { usage: freezeUsage(document.session.usage) } : {}),
      commands: document.session.commands === previous?.session.commands && Object.isFrozen(document.session.commands)
        ? document.session.commands
        : Object.freeze(document.session.commands.map(command => Object.freeze({
          ...command,
          ...(command.raw ? { raw: freezeJsonRecord(command.raw) } : {}),
        }))),
      options: document.session.options === previous?.session.options && Object.isFrozen(document.session.options)
        ? document.session.options
        : Object.freeze(document.session.options.map(option => Object.freeze({
          ...option,
          ...(option.value !== undefined ? { value: freezeJsonValue(option.value) } : {}),
          ...(option.schema !== undefined ? { schema: freezeJsonValue(option.schema) } : {}),
          ...(option.raw ? { raw: freezeJsonRecord(option.raw) } : {}),
        }))),
    })
  const plan = document.plan === previous?.plan && Object.isFrozen(document.plan)
    ? document.plan
    : Object.freeze({
      ...document.plan,
      entries: freezeItems(document.plan.entries, previous?.plan.entries),
    })
  const extensions = document.extensions === previous?.extensions && Object.isFrozen(document.extensions)
    ? document.extensions
    : Object.freeze(document.extensions.map(extension => Object.freeze({
      ...extension,
      payload: freezeJsonValue(extension.payload),
      fallback: Object.freeze(extension.fallback.map(part => freezeJsonValue(part as unknown as JsonValue))) as typeof extension.fallback,
      identity: Object.freeze({ ...extension.identity }),
      source: Object.freeze({ ...extension.source }),
      provenance: Object.freeze({
        ...extension.provenance,
        ...(extension.provenance.synthetic ? { synthetic: Object.freeze({ ...extension.provenance.synthetic }) } : {}),
      }),
    })))
  return Object.freeze({
    ...document,
    appliedEventIds: document.appliedEventIds === previous?.appliedEventIds && Object.isFrozen(document.appliedEventIds) ? document.appliedEventIds : Object.freeze([...document.appliedEventIds]),
    timeline: freezeItems(document.timeline, previous?.timeline),
    messages: freezeItems(document.messages, previous?.messages, freezeDeepSnapshot),
    activities: freezeItems(document.activities, previous?.activities, freezeDeepSnapshot),
    interactions: freezeItems(document.interactions, previous?.interactions, freezeDeepSnapshot),
    extensions,
    diagnostics: freezeItems(document.diagnostics, previous?.diagnostics, freezeDeepSnapshot),
    session,
    assist: document.assist === previous?.assist && Object.isFrozen(document.assist)
      ? document.assist
      : Object.freeze({
        ...document.assist,
        files: Object.freeze([...document.assist.files]),
        ...(document.assist.prediction ? { prediction: Object.freeze({
          ...document.assist.prediction,
          actions: Object.freeze(document.assist.prediction.actions.map(freezeJsonValue)),
        }) } : {}),
      }),
    plan,
  })
}

function freezeDeepSnapshot<T extends object>(value: T): T {
  return freezeDeepValue(value) as T
}

function freezeDeepValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeepValue))
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, freezeDeepValue(nested)])))
  }
  return value
}

function freezeUsage(usage: NonNullable<WorkbenchDocument['session']['usage']>): NonNullable<WorkbenchDocument['session']['usage']> {
  return Object.freeze({
    ...usage,
    ...(usage.budget ? { budget: Object.freeze({ ...usage.budget }) } : {}),
    ...(usage.raw ? { raw: freezeJsonRecord(usage.raw) } : {}),
  })
}

function freezeJsonRecord(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, freezeJsonValue(nested)])))
}

function freezeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    const frozen = value.map(freezeJsonValue)
    Object.freeze(frozen)
    return frozen
  }
  if (value && typeof value === 'object') return freezeJsonRecord(value)
  return value
}

function legacyFieldsFromDocument(document: WorkbenchDocument): Partial<WorkbenchRuntimeSnapshot> {
  const messages: Message[] = document.messages.map(message => ({
    id: message.id,
    role: message.role === 'reasoning' ? 'reasoning' : message.role === 'user' ? 'user' : 'assistant',
    sender: message.source.provider,
    content: message.content,
    time: message.time,
    running: message.running,
  }))
  const error = [...document.diagnostics].reverse().find(diagnostic => diagnostic.level === 'error')?.message ?? null
  const status = document.session.status === 'error' || document.session.status === 'degraded' || document.session.status === 'loading' || document.session.status === 'ready' || document.session.status === 'idle'
    ? document.session.status
    : document.session.status === 'completed' ? 'ready' : 'ready'
  return {
    messages,
    status,
    activeModel: document.session.model ?? '',
    activeMode: document.session.mode ?? 'default',
    generating: messages.some(message => message.running),
    error,
  }
}

function selectSlice(snapshot: WorkbenchRuntimeSnapshot, slice: WorkbenchRuntimeSlice): unknown {
  const document = snapshot.document
  switch (slice) {
    case 'document': return document
    case 'timeline': return document?.timeline ?? []
    case 'messages': return document?.messages ?? snapshot.messages
    case 'activities': return document?.activities ?? []
    case 'interactions': return document?.interactions ?? []
    case 'extensions': return document?.extensions ?? []
    case 'session': return document?.session
    case 'usage': return document?.session.usage
    case 'config': return document?.session.options ?? []
    case 'commands': return document?.session.commands ?? []
    case 'plan': return document ? selectPlan(document) : undefined
    case 'goal': return document ? selectGoal(document) : undefined
    case 'assist': return document?.assist
    case 'diagnostics': return document?.diagnostics ?? []
    case 'tasks': return snapshot.tasks
    case 'streaming': return { text: snapshot.streamingText, thinking: snapshot.streamingThinking }
    case 'capabilities': return { canAttach: snapshot.canAttach, promptImage: snapshot.promptImage }
  }
}

function sliceChanged(left: WorkbenchRuntimeSnapshot, right: WorkbenchRuntimeSnapshot, slice: WorkbenchRuntimeSlice): boolean {
  if (slice === 'streaming') return left.streamingText !== right.streamingText || left.streamingThinking !== right.streamingThinking
  if (slice === 'capabilities') return left.canAttach !== right.canAttach || left.promptImage !== right.promptImage
  return selectSlice(left, slice) !== selectSlice(right, slice)
}

function documentFromLegacy(snapshot: Omit<WorkbenchRuntimeSnapshot, 'revision'> | WorkbenchRuntimeSnapshot): WorkbenchDocument {
  const base = createWorkbenchDocument(snapshot.sessionId ?? '')
  const messages: WorkbenchMessage[] = snapshot.messages.map(message => ({
    id: message.id,
    segmentId: message.id,
    role: message.role === 'reasoning' ? 'reasoning' : message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
    parts: [],
    identity: {},
    source: { provider: message.sender, sessionId: snapshot.sessionId ?? '', sourceId: message.sender },
    sequence: 0,
    running: message.running === true,
    time: message.time,
  }))
  return {
    ...base,
    messages,
    plan: {
      ...base.plan,
      entries: normalizePlanEntries(snapshot.tasks),
    },
    session: {
      ...base.session,
      status: snapshot.status,
      model: snapshot.activeModel || undefined,
      mode: snapshot.activeMode || undefined,
      usage: undefined,
    },
  }
}

const legacyDocumentFields: readonly (keyof WorkbenchRuntimeSnapshot)[] = [
  'sessionId', 'status', 'messages', 'activeModel', 'activeMode', 'error',
]
