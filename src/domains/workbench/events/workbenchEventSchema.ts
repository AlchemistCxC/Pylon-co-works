import {
  createUnknownContentPart,
  isJsonValue,
  parseContentPart,
  type ContentPart,
  type ContentTruncation,
  type JsonValue,
  type SchemaIssue,
  type SchemaResult,
} from '../content/contentPartSchema.ts'

export type { JsonValue, SchemaIssue, SchemaResult }

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'reasoning' | 'developer' | 'unknown'

export interface MessageEvent {
  readonly type: 'message.started' | 'message.delta' | 'message.completed'
  readonly role: MessageRole
  readonly parts?: readonly ContentPart[]
}

export interface ReasoningEvent {
  readonly type: 'reasoning.delta' | 'reasoning.completed' | 'reasoning.redacted'
  readonly parts?: readonly ContentPart[]
  readonly durationMs?: number
  readonly reason?: string
}

export interface UnknownSemanticEvent {
  readonly type: 'event.unknown'
  readonly originalType: string
  readonly summary: string
  readonly raw: JsonValue
  readonly truncated: boolean
  readonly truncation?: ContentTruncation
}

export interface ExtensionEvent {
  readonly type: 'extension.event'
  readonly kind: `${string}.${string}`
  readonly payload: JsonValue
  readonly fallback: readonly ContentPart[]
}

export interface ToolEvent {
  readonly type: 'tool.started' | 'tool.progress' | 'tool.completed' | 'tool.failed'
  readonly tool?: JsonValue
  readonly progress?: JsonValue
  readonly parts?: readonly ContentPart[]
  readonly result?: JsonValue
}

export interface PlanEvent {
  readonly type: 'plan.replaced' | 'plan.entry-updated'
  readonly entries?: readonly JsonValue[]
  readonly entry?: JsonValue
}

export interface GoalEvent {
  readonly type: 'goal.updated' | 'goal.cleared'
  readonly goal?: JsonValue
  readonly goalId?: string
}

export const ACTIVITY_STATUSES = Object.freeze([
  'pending', 'starting', 'running', 'paused', 'completed', 'failed', 'interrupted',
  'cancel-requested', 'cancelled', 'timeout', 'blocked', 'unknown',
] as const)
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number]
const ACTIVITY_STATUS_SET: ReadonlySet<string> = new Set(ACTIVITY_STATUSES)

export function isActivityStatus(value: unknown): value is ActivityStatus {
  return typeof value === 'string' && ACTIVITY_STATUS_SET.has(value)
}

export interface ActivityEvent {
  readonly type: 'activity.started' | 'activity.progress' | 'activity.completed' | 'activity.failed' | 'activity.cancelled'
  readonly activity?: JsonValue
  readonly activityId?: string
  readonly patch?: JsonValue
  readonly result?: JsonValue
  readonly error?: JsonValue
  readonly reason?: string
}

export interface InteractionEvent {
  readonly type: 'interaction.requested' | 'interaction.resolved' | 'interaction.expired'
  readonly interactionId: string
  readonly request?: JsonValue
  readonly response?: JsonValue
  readonly reason?: string
}

export interface UsageEvent {
  readonly type: 'usage.updated' | 'budget.warning'
  readonly usage?: JsonValue
  readonly used?: number
  readonly limit?: number
  readonly threshold?: string
  readonly percent?: number
}

export interface SessionEvent {
  readonly type: 'session.started' | 'session.commands-updated' | 'session.config-updated' | 'session.model-updated' | 'session.mode-updated' | 'session.status-updated' | 'session.completed'
  readonly cwd?: string
  readonly model?: string
  readonly mode?: string
  readonly status?: string
  readonly commands?: readonly JsonValue[]
  readonly options?: readonly JsonValue[]
  readonly stopReason?: string
}

export interface LifecycleEvent {
  readonly type: 'lifecycle.retrying' | 'lifecycle.compact-started' | 'lifecycle.compact-completed' | 'lifecycle.rewind-preview' | 'lifecycle.rewind-completed' | 'lifecycle.suspended' | 'lifecycle.recovered'
  readonly attempt?: number
  readonly maxAttempts?: number
  readonly delayMs?: number
  readonly error?: JsonValue
  readonly strategy?: string
  readonly trigger?: string
  /** C13：compact 前后 token 与 rewind 文件/消息预览（总纲 4.4 lifecycle 字段） */
  readonly tokensBefore?: number
  readonly tokensAfter?: number
  readonly summary?: string
  readonly importedEvents?: number
  readonly files?: readonly JsonValue[]
  readonly messages?: readonly JsonValue[]
  readonly source?: 'canonical' | 'agent-import'
  readonly reason?: string
}

export interface AssistEvent {
  readonly type: 'assist.prediction' | 'assist.file-suggestions' | 'assist.queued-command'
  readonly placeholder?: string
  readonly actions?: readonly JsonValue[]
  readonly files?: readonly string[]
  readonly command?: string
}

export interface DiagnosticEvent {
  readonly type: 'diagnostic.updated' | 'diagnostic.notice'
  readonly diagnostics?: readonly JsonValue[]
  readonly level?: 'info' | 'warning' | 'error'
  readonly message?: string
  readonly code?: string
}

export type WorkbenchSemanticEvent =
  | MessageEvent
  | ReasoningEvent
  | ToolEvent
  | PlanEvent
  | GoalEvent
  | ActivityEvent
  | InteractionEvent
  | UsageEvent
  | SessionEvent
  | LifecycleEvent
  | AssistEvent
  | DiagnosticEvent
  | UnknownSemanticEvent
  | ExtensionEvent

export type ProvenanceOrigin = 'local-observed' | 'optimistic-local' | 'recovery-import' | 'migration' | 'plugin'
export type ProvenanceTrust = 'authoritative' | 'unverified'

export interface WorkbenchEventSource {
  readonly provider: string
  readonly sourceId: string
  readonly agentId?: string
  readonly parentAgentId?: string
}

export interface WorkbenchEventIdentity {
  readonly turnId?: string
  readonly messageId?: string
  readonly toolCallId?: string
  readonly taskId?: string
  readonly runId?: string
  readonly interactionId?: string
}

export interface WorkbenchEventProvenance {
  readonly origin: ProvenanceOrigin
  readonly trust: ProvenanceTrust
  readonly provider?: string
  readonly importId?: string
  readonly sourceOrdinal?: number
  readonly orderConfidence?: 'exact' | 'observed' | 'grouped' | 'unknown'
  readonly collectionComplete?: boolean
  readonly synthetic?: { readonly reason: string }
}

export interface WorkbenchRawMetadata extends ContentTruncation {
  readonly redactions?: readonly { readonly path: readonly (string | number)[]; readonly reason: 'sensitive' }[]
}

export interface WorkbenchEventEnvelope {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly sessionId: string
  readonly sequence: number
  readonly recordedAt: string
  readonly occurredAt?: string
  readonly source: WorkbenchEventSource
  readonly identity: WorkbenchEventIdentity
  readonly provenance: WorkbenchEventProvenance
  readonly event: WorkbenchSemanticEvent
  readonly raw?: JsonValue
  readonly rawMetadata?: WorkbenchRawMetadata
}

export type WorkbenchEnvelopeInput = Omit<WorkbenchEventEnvelope, 'schemaVersion' | 'eventId' | 'identity' | 'raw' | 'rawMetadata'> & {
  readonly eventId?: string
  readonly identity?: WorkbenchEventIdentity
  readonly raw?: unknown
  readonly rawMaxBytes?: number
}

export interface MigrationIssue extends SchemaIssue {
  readonly code: string
}

const CURRENT_SCHEMA_VERSION = 1 as const
const DEFAULT_RAW_MAX_BYTES = 64 * 1024

export function createWorkbenchEnvelope(input: WorkbenchEnvelopeInput): WorkbenchEventEnvelope {
  const identity = input.identity ?? {}
  const rawInfo = input.raw === undefined ? undefined : createUnknownContentPart('__envelope_raw__', input.raw, { maxRawBytes: input.rawMaxBytes ?? DEFAULT_RAW_MAX_BYTES })
  const raw = input.raw === undefined ? undefined : rawInfo!.raw
  const rawMetadata = rawInfo?.truncation
    ? { ...rawInfo.truncation, ...(rawInfo.redactions ? { redactions: rawInfo.redactions } : {}) }
    : rawInfo?.redactions?.length
      ? {
          truncated: false,
          originalBytes: JSON.stringify(rawInfo.raw).length,
          retainedBytes: JSON.stringify(rawInfo.raw).length,
          omittedBytes: 0,
          reason: 'sensitive' as const,
          redactions: rawInfo.redactions,
        }
      : undefined
  const base = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    sequence: input.sequence,
    recordedAt: input.recordedAt,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    source: { ...input.source },
    identity: { ...identity },
    provenance: { ...input.provenance },
    event: input.event,
    ...(raw !== undefined ? { raw } : {}),
    ...(rawMetadata ? { rawMetadata } : {}),
  } satisfies Omit<WorkbenchEventEnvelope, 'eventId'>
  return {
    ...base,
    eventId: input.eventId ?? deriveWorkbenchEventId(base),
  }
}

export function deriveWorkbenchEventId(input: Pick<WorkbenchEventEnvelope, 'sessionId' | 'sequence' | 'source' | 'identity' | 'event'>): string {
  // sequence is the explicit journal sequence, not an array position or a
  // wall-clock value; it prevents two deltas sharing one provider id colliding.
  const stableIdentity = Object.keys(input.identity).length > 0 ? input.identity : { sourceId: input.source.sourceId }
  return `wb-${fnv1a(stableStringify([input.sessionId, input.source.provider, input.source.sourceId, input.event.type, stableIdentity, input.sequence]))}`
}

export function parseWorkbenchEnvelope(value: unknown): SchemaResult<WorkbenchEventEnvelope> {
  const issues: SchemaIssue[] = []
  if (!isRecord(value)) return failure([schemaIssue([], 'type.object', 'object', value)])
  if (value.schemaVersion !== CURRENT_SCHEMA_VERSION) issues.push(schemaIssue(['schemaVersion'], 'schema.version', '1', value.schemaVersion))
  requireString(value, 'eventId', issues)
  requireString(value, 'sessionId', issues)
  requirePositiveInteger(value, 'sequence', issues)
  requireIsoDate(value, 'recordedAt', issues)
  if (value.occurredAt !== undefined) requireIsoDate(value, 'occurredAt', issues)
  validateSource(value.source, issues)
  validateIdentity(value.identity, issues)
  validateProvenance(value.provenance, issues)
  const eventResult = parseSemanticEvent(value.event)
  if (!eventResult.ok) issues.push(...eventResult.issues.map(item => ({ ...item, path: ['event', ...item.path] })))
  if (value.raw !== undefined && !isJsonValue(value.raw)) issues.push(schemaIssue(['raw'], 'json.invalid', 'JSON value', value.raw))
  if (value.raw !== undefined && isJsonValue(value.raw) && jsonBytes(value.raw) > DEFAULT_RAW_MAX_BYTES && (!isRecord(value.rawMetadata) || value.rawMetadata.truncated !== true)) {
    issues.push(schemaIssue(['rawMetadata'], 'raw.truncation-required', 'truncation metadata for oversized raw', value.rawMetadata))
  }
  if (value.rawMetadata !== undefined && !isValidRawMetadata(value.rawMetadata)) issues.push(schemaIssue(['rawMetadata'], 'shape.truncation', 'raw metadata', value.rawMetadata))
  if (issues.length > 0 || !eventResult.ok) return failure(issues)
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      eventId: value.eventId as string,
      sessionId: value.sessionId as string,
      sequence: value.sequence as number,
      recordedAt: value.recordedAt as string,
      ...(value.occurredAt !== undefined ? { occurredAt: value.occurredAt as string } : {}),
      source: value.source as WorkbenchEventSource,
      identity: value.identity as WorkbenchEventIdentity,
      provenance: value.provenance as WorkbenchEventProvenance,
      event: eventResult.value,
      ...(value.raw !== undefined ? { raw: value.raw as JsonValue } : {}),
      ...(value.rawMetadata !== undefined ? { rawMetadata: value.rawMetadata as WorkbenchRawMetadata } : {}),
    },
  }
}

export function migrateWorkbenchEnvelope(value: unknown): SchemaResult<WorkbenchEventEnvelope> {
  if (!isRecord(value)) return failure([schemaIssue([], 'type.object', 'object', value)])
  if (value.schemaVersion === CURRENT_SCHEMA_VERSION) return parseWorkbenchEnvelope(value)
  if (value.schemaVersion !== undefined && value.schemaVersion !== 0) {
    return failure([schemaIssue(['schemaVersion'], 'schema.unsupported', '0 or 1', value.schemaVersion)])
  }

  // Version zero already used the semantic shape but had no explicit version.
  if (value.event && value.sessionId && value.source && value.provenance) {
    const migrated = { ...value, schemaVersion: CURRENT_SCHEMA_VERSION }
    return parseWorkbenchEnvelope(migrated)
  }

  // Minimal read-seam bridge for the existing canonical row shape.  It keeps
  // the raw row for forensics and deliberately marks the result as migration.
  const owner = isRecord(value.owner) ? value.owner : {}
  const sessionId = typeof owner.localSessionId === 'string' ? owner.localSessionId : typeof value.sessionId === 'string' ? value.sessionId : undefined
  const sequence = typeof value.sequence === 'number' ? value.sequence : undefined
  const rawPayload = value.rawPayload
  if (!sessionId || sequence === undefined || !isJsonValue(rawPayload)) {
    return failure([schemaIssue([], 'migration.legacy-shape', 'version zero semantic or canonical event', value)])
  }
  const eventType = typeof value.eventType === 'string' ? value.eventType : 'unknown'
  const typed = isRecord(value.typedPayload) ? value.typedPayload : {}
  const text = typeof typed.text === 'string' ? typed.text : undefined
  const event: WorkbenchSemanticEvent = eventType === 'user.message' || eventType === 'assistant.text.delta'
    ? { type: 'message.delta', role: eventType === 'user.message' ? 'user' : 'assistant', ...(text !== undefined ? { parts: [{ kind: 'text', text }] } : { parts: [] }) }
    : { type: 'event.unknown', originalType: eventType, summary: `Migrated ${eventType}`, raw: rawPayload, truncated: false }
  const migrated = createWorkbenchEnvelope({
    sessionId,
    sequence,
    recordedAt: typeof value.receivedAt === 'string' ? value.receivedAt : new Date(0).toISOString(),
    source: { provider: 'migration', sourceId: typeof value.eventId === 'string' ? value.eventId : `${sessionId}:${sequence}` },
    identity: isRecord(value.identity) ? value.identity as WorkbenchEventIdentity : {},
    provenance: { origin: 'migration', trust: 'unverified', provider: 'migration' },
    event,
    raw: rawPayload,
    eventId: typeof value.eventId === 'string' ? value.eventId : undefined,
  })
  return parseWorkbenchEnvelope(migrated)
}

function parseSemanticEvent(value: unknown): SchemaResult<WorkbenchSemanticEvent> {
  if (!isRecord(value) || typeof value.type !== 'string') return failure([schemaIssue([], 'event.type', 'event object with type', value)])
  const issues: SchemaIssue[] = []
  if (value.type === 'event.unknown') {
    if (typeof value.originalType !== 'string') issues.push(schemaIssue(['originalType'], 'type.string', 'string', value.originalType))
    if (typeof value.summary !== 'string') issues.push(schemaIssue(['summary'], 'type.string', 'string', value.summary))
    if (!isJsonValue(value.raw)) issues.push(schemaIssue(['raw'], 'json value', 'JSON value', value.raw))
    if (typeof value.truncated !== 'boolean') issues.push(schemaIssue(['truncated'], 'type.boolean', 'boolean', value.truncated))
    if (isJsonValue(value.raw) && jsonBytes(value.raw) > DEFAULT_RAW_MAX_BYTES && value.truncated !== true) issues.push(schemaIssue(['truncated'], 'raw.truncation-required', 'true for oversized unknown raw', value.truncated))
  } else if (value.type === 'extension.event') {
    if (typeof value.kind !== 'string' || !value.kind.includes('.')) issues.push(schemaIssue(['kind'], 'type.namespaced', 'namespaced string', value.kind))
    if (!isJsonValue(value.payload)) issues.push(schemaIssue(['payload'], 'json.invalid', 'JSON value', value.payload))
    validateParts(value.fallback, ['fallback'], issues)
  } else if (MESSAGE_EVENT_TYPES.has(value.type)) {
    if (typeof value.role !== 'string') issues.push(schemaIssue(['role'], 'type.string', 'string', value.role))
    if (value.parts !== undefined) validateParts(value.parts, ['parts'], issues)
  } else if (value.type === 'reasoning.delta') {
    validateParts(value.parts, ['parts'], issues)
  } else if (KNOWN_EVENT_TYPES.has(value.type)) {
    if ('parts' in value && value.parts !== undefined) validateParts(value.parts, ['parts'], issues)
  } else {
    issues.push(schemaIssue(['type'], 'event.unknown-type', 'known semantic event or event.unknown', value.type))
  }
  if (issues.length > 0) return failure(issues)
  if (!isSemanticEvent(value)) return failure([schemaIssue(['type'], 'event.unknown-type', 'known semantic event', value.type)])
  return { ok: true, value }
}

const MESSAGE_EVENT_TYPES = new Set(['message.started', 'message.delta', 'message.completed'])
const KNOWN_EVENT_TYPES = new Set([
  ...MESSAGE_EVENT_TYPES,
  'reasoning.delta', 'reasoning.completed', 'reasoning.redacted',
  'tool.started', 'tool.progress', 'tool.completed', 'tool.failed',
  'plan.replaced', 'plan.entry-updated', 'goal.updated', 'goal.cleared',
  'activity.started', 'activity.progress', 'activity.completed', 'activity.failed', 'activity.cancelled',
  'interaction.requested', 'interaction.resolved', 'interaction.expired',
  'usage.updated', 'budget.warning',
  'session.started', 'session.commands-updated', 'session.config-updated', 'session.model-updated', 'session.mode-updated', 'session.status-updated', 'session.completed',
  'lifecycle.retrying', 'lifecycle.compact-started', 'lifecycle.compact-completed', 'lifecycle.rewind-preview', 'lifecycle.rewind-completed', 'lifecycle.suspended', 'lifecycle.recovered',
  'assist.prediction', 'assist.file-suggestions', 'assist.queued-command',
  'diagnostic.updated', 'diagnostic.notice',
])

function isSemanticEvent(value: unknown): value is WorkbenchSemanticEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  return value.type === 'event.unknown'
    || value.type === 'extension.event'
    || KNOWN_EVENT_TYPES.has(value.type)
}

function validateParts(value: unknown, path: readonly (string | number)[], issues: SchemaIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(schemaIssue(path, 'type.array', 'array', value))
    return
  }
  value.forEach((part, index) => {
    const parsed = parseContentPart(part)
    if (!parsed.ok) issues.push(...parsed.issues.map(item => ({ ...item, path: [...path, index, ...item.path] })))
  })
}

function validateSource(value: unknown, issues: SchemaIssue[]): void {
  if (!isRecord(value)) {
    issues.push(schemaIssue(['source'], 'type.object', 'object', value))
    return
  }
  requireString(value, 'provider', issues, ['source', 'provider'])
  requireString(value, 'sourceId', issues, ['source', 'sourceId'])
  for (const key of ['agentId', 'parentAgentId']) if (value[key] !== undefined && typeof value[key] !== 'string') issues.push(schemaIssue(['source', key], 'type.string', 'string', value[key]))
}

function validateIdentity(value: unknown, issues: SchemaIssue[]): void {
  if (!isRecord(value)) {
    issues.push(schemaIssue(['identity'], 'type.object', 'object', value))
    return
  }
  for (const key of ['turnId', 'messageId', 'toolCallId', 'taskId', 'runId', 'interactionId']) if (value[key] !== undefined && typeof value[key] !== 'string') issues.push(schemaIssue(['identity', key], 'type.string', 'string', value[key]))
}

function validateProvenance(value: unknown, issues: SchemaIssue[]): void {
  if (!isRecord(value)) {
    issues.push(schemaIssue(['provenance'], 'type.object', 'object', value))
    return
  }
  const origins: ProvenanceOrigin[] = ['local-observed', 'optimistic-local', 'recovery-import', 'migration', 'plugin']
  const trusts: ProvenanceTrust[] = ['authoritative', 'unverified']
  if (!origins.includes(value.origin as ProvenanceOrigin)) issues.push(schemaIssue(['provenance', 'origin'], 'enum.origin', origins.join('|'), value.origin))
  if (!trusts.includes(value.trust as ProvenanceTrust)) issues.push(schemaIssue(['provenance', 'trust'], 'enum.trust', trusts.join('|'), value.trust))
  if (value.origin === 'local-observed' && value.trust !== 'authoritative') issues.push(schemaIssue(['provenance', 'trust'], 'provenance.trust', 'authoritative for local-observed', value.trust))
  if (value.origin !== 'local-observed' && value.trust === 'authoritative') issues.push(schemaIssue(['provenance', 'trust'], 'provenance.trust', 'unverified for non-local origin', value.trust))
  if (value.origin === 'recovery-import') {
    if (typeof value.provider !== 'string' || value.provider.length === 0) issues.push(schemaIssue(['provenance', 'provider'], 'required.provider', 'non-empty string', value.provider))
    if (typeof value.importId !== 'string' || value.importId.length === 0) issues.push(schemaIssue(['provenance', 'importId'], 'required.importId', 'non-empty string', value.importId))
  }
  if (value.sourceOrdinal !== undefined && (typeof value.sourceOrdinal !== 'number' || !Number.isInteger(value.sourceOrdinal) || value.sourceOrdinal < 0)) issues.push(schemaIssue(['provenance', 'sourceOrdinal'], 'number.integer', 'non-negative integer', value.sourceOrdinal))
  if (value.provider !== undefined && typeof value.provider !== 'string') issues.push(schemaIssue(['provenance', 'provider'], 'type.string', 'string', value.provider))
  if (value.importId !== undefined && typeof value.importId !== 'string') issues.push(schemaIssue(['provenance', 'importId'], 'type.string', 'string', value.importId))
  if (value.orderConfidence !== undefined && !['exact', 'observed', 'grouped', 'unknown'].includes(String(value.orderConfidence))) issues.push(schemaIssue(['provenance', 'orderConfidence'], 'enum.order-confidence', 'exact|observed|grouped|unknown', value.orderConfidence))
  if (value.collectionComplete !== undefined && typeof value.collectionComplete !== 'boolean') issues.push(schemaIssue(['provenance', 'collectionComplete'], 'type.boolean', 'boolean', value.collectionComplete))
  if (value.synthetic !== undefined) {
    if (!isRecord(value.synthetic) || typeof value.synthetic.reason !== 'string' || !value.synthetic.reason.trim()) issues.push(schemaIssue(['provenance', 'synthetic'], 'synthetic.reason', 'non-empty reason', value.synthetic))
    if (value.orderConfidence !== 'observed') issues.push(schemaIssue(['provenance', 'orderConfidence'], 'synthetic.order-confidence', 'observed for synthetic events', value.orderConfidence))
  }
}

function isValidRawMetadata(value: unknown): value is WorkbenchRawMetadata {
  if (!isRecord(value)) return false
  return (value.truncated === true || value.truncated === false)
    && [value.originalBytes, value.retainedBytes, value.omittedBytes].every(item => typeof item === 'number' && item >= 0)
    && ['size-limit', 'non-serializable', 'sensitive'].includes(String(value.reason))
}

function requireString(value: Record<string, unknown>, key: string, issues: SchemaIssue[], path: readonly (string | number)[] = [key]): void {
  if (typeof value[key] !== 'string' || value[key].length === 0) issues.push(schemaIssue(path, 'type.string', 'non-empty string', value[key]))
}

function requirePositiveInteger(value: Record<string, unknown>, key: string, issues: SchemaIssue[]): void {
  if (!Number.isInteger(value[key]) || Number(value[key]) < 1) issues.push(schemaIssue([key], 'number.positive-integer', 'positive integer', value[key]))
}

function requireIsoDate(value: Record<string, unknown>, key: string, issues: SchemaIssue[]): void {
  if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) issues.push(schemaIssue([key], 'date.iso', 'ISO date string', value[key]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaIssue(path: readonly (string | number)[], code: string, expected: string, value: unknown): SchemaIssue {
  return { path, code, expected, received: receivedType(value), summary: `Expected ${expected}` }
}

function receivedType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function jsonBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function failure(issues: readonly SchemaIssue[]): SchemaResult<never> {
  return { ok: false, issues }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
