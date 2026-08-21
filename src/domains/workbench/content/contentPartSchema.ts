/**
 * Framework-free semantic content contract.
 *
 * Content parts are deliberately independent from Message/React/Solid.  A
 * provider may introduce a namespaced kind, but an unrecognised kind is still
 * represented as `unknown` so the projector can show evidence instead of
 * silently dropping it.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

export type ContentKind =
  | 'text' | 'markdown' | 'code' | 'ansi'
  | 'reasoning' | 'thinking' | 'redacted-reasoning'
  | 'image' | 'audio' | 'video' | 'document' | 'resource'
  | 'file-reference' | 'file-selection' | 'diff'
  | 'location' | 'terminal' | 'log' | 'progress'
  | 'list' | 'key-value' | 'json' | 'link' | 'search-result'
  | 'tool-use' | 'tool-result' | 'artifact' | 'unknown'
  | `${string}.${string}`

export interface ContentTruncation {
  readonly truncated: boolean
  readonly originalBytes: number
  readonly retainedBytes: number
  readonly omittedBytes: number
  readonly reason: 'size-limit' | 'non-serializable' | 'sensitive'
}

export interface SchemaIssue {
  readonly path: readonly (string | number)[]
  readonly code: string
  readonly expected: string
  readonly received: string
  readonly summary: string
}

export type SchemaResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] }

export interface UnknownContentPart {
  readonly kind: 'unknown'
  readonly originalType: string
  readonly summary: string
  readonly raw: JsonValue
  readonly truncated: boolean
  readonly truncation?: ContentTruncation
  readonly redactions?: readonly { readonly path: readonly (string | number)[]; readonly reason: 'sensitive' }[]
}

export interface TextContentPart {
  readonly kind: 'text' | 'markdown' | 'code' | 'ansi' | 'reasoning' | 'thinking'
  readonly text: string
  readonly language?: string
}

export interface ImageContentPart {
  readonly kind: 'image' | 'audio' | 'video'
  readonly source: string
  readonly mimeType?: string
  readonly alt?: string
  readonly width?: number
  readonly height?: number
  readonly durationMs?: number
  readonly poster?: string
  readonly transcript?: string
}

export interface ResourceContentPart {
  readonly kind: 'resource'
  readonly uri: string
  readonly title?: string
  readonly mimeType?: string
  readonly text?: string
  readonly blob?: string
}

export type ContentPart =
  | TextContentPart
  | ImageContentPart
  | ResourceContentPart
  | UnknownContentPart
  | { readonly kind: Exclude<ContentKind, TextContentPart['kind'] | ImageContentPart['kind'] | ResourceContentPart['kind'] | 'unknown'>; readonly [key: string]: unknown }

export interface UnknownContentOptions {
  readonly maxRawBytes?: number
}

const DEFAULT_MAX_RAW_BYTES = 8 * 1024
const SENSITIVE_KEY = /(?:token|secret|password|authorization|api[-_]?key|credential|cookie)/i

export function createUnknownContentPart(
  originalType: string,
  raw: unknown,
  options: UnknownContentOptions = {},
): UnknownContentPart {
  const maxRawBytes = Math.max(128, Math.floor(options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES))
  const redactions: { path: readonly (string | number)[]; reason: 'sensitive' }[] = []
  const sanitized = sanitizeJson(raw, [], redactions)
  const encoded = safeJsonStringify(sanitized)
  const originalBytes = byteLength(encoded)
  if (originalBytes <= maxRawBytes) {
    return {
      kind: 'unknown',
      originalType: normalizeType(originalType),
      summary: unknownSummary(originalType, originalBytes),
      raw: sanitized,
      truncated: false,
      ...(redactions.length > 0 ? { redactions } : {}),
    }
  }

  const preview = encoded.slice(0, Math.max(1, maxRawBytes - 64))
  const retainedBytes = byteLength(preview)
  const truncation: ContentTruncation = {
    truncated: true,
    originalBytes,
    retainedBytes,
    omittedBytes: Math.max(0, originalBytes - retainedBytes),
    reason: 'size-limit',
  }
  return {
    kind: 'unknown',
    originalType: normalizeType(originalType),
    summary: unknownSummary(originalType, originalBytes),
    // The preview is a string, therefore it remains valid JSON even though it
    // is intentionally not presented as the complete provider payload.
    raw: { preview, truncated: true },
    truncated: true,
    truncation,
    ...(redactions.length > 0 ? { redactions } : {}),
  }
}

export function parseContentPart(value: unknown): SchemaResult<ContentPart> {
  const issues: SchemaIssue[] = []
  if (!isRecord(value)) return failure([issue([], 'type.object', 'object', value)])
  const kind = value.kind
  if (typeof kind !== 'string' || kind.length === 0) {
    issues.push(issue(['kind'], 'type.string', 'non-empty string', kind))
    return failure(issues)
  }

  if (kind === 'unknown') return parseUnknown(value)
  if (isTextKind(kind)) {
    if (typeof value.text !== 'string') issues.push(issue(['text'], 'type.string', 'string', value.text))
  } else if (kind === 'image' || kind === 'audio' || kind === 'video') {
    if (typeof value.source !== 'string') issues.push(issue(['source'], 'type.string', 'string', value.source))
    validateOptionalString(value, 'mimeType', issues)
    validateOptionalString(value, 'alt', issues)
  } else if (kind === 'resource') {
    if (typeof value.uri !== 'string') issues.push(issue(['uri'], 'type.string', 'string', value.uri))
    validateOptionalString(value, 'title', issues)
  } else if (kind === 'tool-result' && value.parts !== undefined) {
    if (!Array.isArray(value.parts)) {
      issues.push(issue(['parts'], 'type.array', 'array', value.parts))
    } else {
      value.parts.forEach((part, index) => {
        const parsed = parseContentPart(part)
        if (!parsed.ok) issues.push(...parsed.issues.map(item => ({ ...item, path: ['parts', index, ...item.path] })))
      })
    }
  } else if (kind.includes('.') || isKnownStructuredKind(kind)) {
    // Structured/extension kinds intentionally keep their provider fields;
    // the envelope parser still requires the value to be a JSON object.
    if (!isJsonValue(value)) issues.push(issue([], 'json.invalid', 'JSON value', value))
  } else {
    // Unknown provider kind is normalised into the explicit visible fallback.
    return { ok: true, value: createUnknownContentPart(kind, value) }
  }

  return issues.length > 0 ? failure(issues) : { ok: true, value: value as ContentPart }
}

function parseUnknown(value: Record<string, unknown>): SchemaResult<UnknownContentPart> {
  const issues: SchemaIssue[] = []
  if (typeof value.originalType !== 'string' || value.originalType.length === 0) issues.push(issue(['originalType'], 'type.string', 'non-empty string', value.originalType))
  if (typeof value.summary !== 'string') issues.push(issue(['summary'], 'type.string', 'string', value.summary))
  if (!isJsonValue(value.raw)) issues.push(issue(['raw'], 'json.invalid', 'JSON value', value.raw))
  if (typeof value.truncated !== 'boolean') issues.push(issue(['truncated'], 'type.boolean', 'boolean', value.truncated))
  if (value.truncation !== undefined && !isValidTruncation(value.truncation)) issues.push(issue(['truncation'], 'shape.truncation', 'truncation metadata', value.truncation))
  if (issues.length > 0) return failure(issues)
  return {
    ok: true,
    value: {
      kind: 'unknown',
      originalType: value.originalType as string,
      summary: value.summary as string,
      raw: value.raw as JsonValue,
      truncated: value.truncated as boolean,
      ...(value.truncation !== undefined ? { truncation: value.truncation as ContentTruncation } : {}),
      ...(value.redactions !== undefined ? { redactions: value.redactions as UnknownContentPart['redactions'] } : {}),
    },
  }
}

function isTextKind(kind: string): kind is TextContentPart['kind'] {
  return ['text', 'markdown', 'code', 'ansi', 'reasoning', 'thinking'].includes(kind)
}

function isKnownStructuredKind(kind: string): boolean {
  return ['redacted-reasoning', 'document', 'file-reference', 'file-selection', 'diff', 'location', 'terminal', 'log', 'progress', 'list', 'key-value', 'json', 'link', 'search-result', 'tool-use', 'artifact'].includes(kind)
}

function validateOptionalString(value: Record<string, unknown>, key: string, issues: SchemaIssue[]): void {
  if (value[key] !== undefined && typeof value[key] !== 'string') issues.push(issue([key], 'type.string', 'string', value[key]))
}

function isValidTruncation(value: unknown): value is ContentTruncation {
  if (!isRecord(value)) return false
  return value.truncated === true
    && typeof value.originalBytes === 'number'
    && typeof value.retainedBytes === 'number'
    && typeof value.omittedBytes === 'number'
    && ['size-limit', 'non-serializable', 'sensitive'].includes(String(value.reason))
}

function normalizeType(value: string): string {
  const trimmed = value.trim()
  return trimmed || 'unknown'
}

function unknownSummary(type: string, bytes: number): string {
  return `Unknown content type ${normalizeType(type)} (${bytes} bytes)`
}

function sanitizeJson(value: unknown, path: readonly (string | number)[], redactions: { path: readonly (string | number)[]; reason: 'sensitive' }[]): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item, index) => sanitizeJson(item, [...path, index], redactions))
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {}
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = '[REDACTED]'
        redactions.push({ path: [...path, key], reason: 'sensitive' })
      } else {
        output[key] = sanitizeJson(child, [...path, key], redactions)
      }
    }
    return output
  }
  redactions.push({ path, reason: 'sensitive' })
  return '[REDACTED]'
}

function safeJsonStringify(value: JsonValue): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ redacted: true })
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

function received(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function issue(path: readonly (string | number)[], code: string, expected: string, value: unknown): SchemaIssue {
  return { path, code, expected, received: received(value), summary: `Expected ${expected}` }
}

function failure(issues: readonly SchemaIssue[]): SchemaResult<never> {
  return { ok: false, issues }
}
