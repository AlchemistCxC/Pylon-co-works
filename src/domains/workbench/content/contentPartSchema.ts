/**
 * Framework-free semantic content contract.
 *
 * Content parts are deliberately independent from Message/React/Solid.  A
 * provider may introduce a namespaced kind, but an unrecognised kind is still
 * represented as `unknown` so the projector can show evidence instead of
 * silently dropping it.
 */

import { isNonEmptyContentLocation } from './fileContentValidation.ts'
import {
  hasForbiddenMediaSideChannel,
  isMediaSourceKind,
  isValidMediaContentInput,
  isValidMediaDimension,
  isValidMediaDuration,
  isValidMediaMime,
  type MediaSourceKind,
} from './mediaContentValidation.ts'

// 校验辅助：undefined 视为通过；仅接受非空字符串（保持原单行三连访问的语义）
function isMissingOrNonEmptyString(v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && v.trim().length > 0)
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

export type ContentKind =
  | 'text' | 'markdown' | 'code' | 'ansi'
  | 'reasoning' | 'thinking' | 'redacted-reasoning'
  | 'image' | 'audio' | 'video' | 'document' | 'resource'
  | 'file-reference' | 'file-selection' | 'diff'
  | 'location' | 'terminal' | 'log' | 'progress'
  | 'list' | 'key-value' | 'json' | 'link' | 'search-result' | 'diagnostic-lsp'
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
  readonly sourceKind?: MediaSourceKind
  readonly mimeType?: string
  readonly alt?: string
  readonly caption?: string
  readonly width?: number
  readonly height?: number
  readonly durationMs?: number
  readonly poster?: string
  readonly transcript?: string
}

export type MediaContentPart = ImageContentPart

export interface ResourceContentPart {
  readonly kind: 'resource'
  readonly uri: string
  readonly title?: string
  readonly mimeType?: string
  readonly text?: string
  /** Binary presence marker only; raw base64 is excluded from canonical display content. */
  readonly hasBlob?: boolean
}

export interface DocumentContentPart {
  readonly kind: 'document'
  readonly title?: string
  readonly path?: string
  readonly uri?: string
  readonly mimeType?: string
  readonly text?: string
  /** Binary presence marker only; raw base64 is excluded from canonical display content. */
  readonly hasBlob?: boolean
}

export interface SearchHighlightRange {
  readonly start: number
  readonly end: number
}

export interface SearchResultLocation {
  readonly path?: string
  readonly uri?: string
  readonly line?: number
  readonly column?: number
  readonly endLine?: number
  readonly endColumn?: number
}

export interface SearchResultEntry {
  readonly source: string
  readonly rank?: number
  readonly title?: string
  readonly location?: SearchResultLocation
  readonly snippet?: string
  readonly highlights?: readonly SearchHighlightRange[]
  readonly score?: number
  readonly pagingToken?: string
}

export interface SearchResultContentPart {
  readonly kind: 'search-result'
  readonly query?: string
  readonly total?: number
  readonly pagingToken?: string
  readonly results: readonly SearchResultEntry[]
}

export interface LinkContentPart {
  readonly kind: 'link'
  readonly url: string
  readonly title?: string
  readonly status?: number
}

export interface TextPosition {
  readonly line: number
  readonly character?: number
}

export interface TextRange {
  readonly start: TextPosition
  readonly end?: TextPosition
}

export interface DiffContentLine {
  readonly kind: 'context' | 'added' | 'removed'
  readonly text: string
}

export interface DiffContentHunk {
  readonly oldStart?: number
  readonly oldLines?: number
  readonly newStart?: number
  readonly newLines?: number
}

export interface DiffContentPart {
  readonly kind: 'diff'
  readonly path?: string
  readonly oldPath?: string
  readonly status?: string
  readonly range?: TextRange
  readonly hunks?: readonly DiffContentHunk[]
  readonly lines?: readonly DiffContentLine[]
  readonly oldText?: string
  readonly newText?: string
  readonly additions?: number
  readonly deletions?: number
  readonly binary?: boolean
  readonly truncated?: boolean
  readonly truncation?: ContentTruncation
  readonly unified?: string
  readonly rawPatch?: JsonValue
  readonly unknownFields?: readonly string[]
}

export interface LspRelatedInformation {
  readonly message: string
  readonly path: string
  readonly range?: TextRange
}

export interface LspDiagnosticContentPart {
  readonly kind: 'diagnostic-lsp'
  readonly severity?: string
  readonly code?: string
  readonly source?: string
  readonly message: string
  readonly path: string
  readonly range?: TextRange
  readonly related?: readonly LspRelatedInformation[]
  readonly unknownFields?: readonly string[]
}

export type TerminalStreamKind = 'stdout' | 'stderr'
export type TerminalStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type TerminalTermination = 'timeout' | 'killed' | 'signal'

export interface TerminalStreamEntry {
  readonly stream: TerminalStreamKind
  readonly text: string
  readonly ordinal?: number
  readonly lateAfterTerminal?: boolean
  readonly timestamp?: string
  readonly timestampConfidence?: 'exact' | 'observed' | 'synthetic' | 'unknown'
}

export interface TerminalOutputTruncation {
  readonly capturedLines?: number
  readonly omittedLines?: number
  readonly capturedBytes?: number
  readonly omittedBytes?: number
}

export interface TerminalContentPart {
  readonly kind: 'terminal'
  readonly command?: string
  readonly processId?: string
  readonly sessionId?: string
  readonly streams: readonly TerminalStreamEntry[]
  readonly status?: TerminalStatus
  readonly exitCode?: number
  readonly terminatedBy?: TerminalTermination
  readonly durationMs?: number
  readonly env?: Readonly<Record<string, string>>
  readonly truncation?: TerminalOutputTruncation
  readonly error?: { readonly message: string; readonly code?: string }
}

export interface LogContentEntry {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'unknown'
  readonly originalLevel?: string
  readonly text: string
  readonly ordinal?: number
  readonly timestamp?: string
  readonly timestampConfidence?: 'exact' | 'observed' | 'synthetic' | 'unknown'
}

export interface LogContentPart {
  readonly kind: 'log'
  readonly source?: string
  readonly processId?: string
  readonly sessionId?: string
  readonly entries: readonly LogContentEntry[]
  readonly truncation?: TerminalOutputTruncation
}

export interface MemoryContentPart {
  readonly kind: 'memory'
  readonly memoryId: string
  readonly title: string
  readonly source: string
  readonly scope?: string
  readonly summary?: string
  readonly status?: string
  readonly version?: string | number
  readonly enabled?: boolean
  readonly used?: boolean
  readonly raw?: Readonly<Record<string, JsonValue>>
}

export interface SkillContentPart {
  readonly kind: 'skill'
  readonly skillId: string
  readonly title: string
  readonly source: string
  readonly scope?: string
  readonly summary?: string
  readonly status?: string
  readonly version?: string | number
  readonly enabled?: boolean
  readonly used?: boolean
  readonly uri?: string
  readonly raw?: Readonly<Record<string, JsonValue>>
}

export interface McpResourceContentPart {
  readonly kind: 'mcp-resource'
  readonly server: string
  readonly resourceUri: string
  readonly tool?: string
  readonly title?: string
  readonly mimeType?: string
  readonly summary?: string
  readonly connectionState?: string
  readonly status?: string
  readonly raw?: Readonly<Record<string, JsonValue>>
}

export interface ArtifactContentPart {
  readonly kind: 'artifact'
  readonly artifactId: string
  readonly title: string
  readonly uri: string
  readonly version?: string | number
  readonly mimeType?: string
  readonly summary?: string
  readonly status?: string
  readonly hasBlob?: boolean
  readonly parts?: readonly ContentPart[]
  readonly actions?: readonly string[]
  readonly raw?: Readonly<Record<string, JsonValue>>
}

export interface HookSurfaceSnapshot {
  readonly phase: string
  readonly owner: Readonly<{ pluginId: string; runtimeInstanceId?: string; handlerId: string }>
  readonly status: string
  readonly durationMs?: number
  readonly decision?: string
  readonly error?: Readonly<{ message: string; code?: string }>
  readonly raw?: Readonly<Record<string, JsonValue>>
}

export type ContentPart =
  | TextContentPart
  | ImageContentPart
  | ResourceContentPart
  | DocumentContentPart
  | SearchResultContentPart
  | LinkContentPart
  | DiffContentPart
  | LspDiagnosticContentPart
  | TerminalContentPart
  | LogContentPart
  | MemoryContentPart
  | SkillContentPart
  | McpResourceContentPart
  | ArtifactContentPart
  | UnknownContentPart
  | { readonly kind: Exclude<ContentKind, TextContentPart['kind'] | ImageContentPart['kind'] | ResourceContentPart['kind'] | DocumentContentPart['kind'] | SearchResultContentPart['kind'] | LinkContentPart['kind'] | DiffContentPart['kind'] | LspDiagnosticContentPart['kind'] | TerminalContentPart['kind'] | LogContentPart['kind'] | MemoryContentPart['kind'] | SkillContentPart['kind'] | McpResourceContentPart['kind'] | ArtifactContentPart['kind'] | 'unknown'>; readonly [key: string]: unknown }

function isDisplayTextPart(part: ContentPart): part is TextContentPart {
  return part.kind === 'text' || part.kind === 'markdown'
}

function isReasoningTextPart(part: ContentPart): part is TextContentPart {
  return part.kind === 'text'
    || part.kind === 'markdown'
    || part.kind === 'reasoning'
    || part.kind === 'thinking'
}

/**
 * Streaming transports commonly emit one text part per delta. Those are wire
 * fragments, not semantic block boundaries: parsing each fragment as its own
 * Markdown document produces one paragraph per token. Preserve rich-content
 * boundaries while folding adjacent display-text fragments into one part.
 */
export function coalesceAdjacentDisplayTextParts(parts: readonly ContentPart[]): readonly ContentPart[] {
  if (parts.length < 2) return parts
  const merged: ContentPart[] = []
  let changed = false
  for (const part of parts) {
    const previous = merged.at(-1)
    if (previous && isDisplayTextPart(previous) && isDisplayTextPart(part)) {
      merged[merged.length - 1] = {
        ...previous,
        kind: previous.kind === 'markdown' || part.kind === 'markdown' ? 'markdown' : 'text',
        text: previous.text + part.text,
      }
      changed = true
    } else {
      merged.push(part)
    }
  }
  return changed ? merged : parts
}

/**
 * Reasoning deltas are wire fragments, not paragraph boundaries.  Unlike the
 * general display-text helper this also accepts the protocol's `reasoning`
 * and `thinking` text kinds, while deliberately keeping code/ANSI, media,
 * tool and other rich parts as hard boundaries.
 */
export function coalesceAdjacentReasoningParts(parts: readonly ContentPart[]): readonly ContentPart[] {
  if (parts.length < 2) return parts
  const merged: ContentPart[] = []
  let changed = false
  for (const part of parts) {
    const previous = merged.at(-1)
    if (previous && isReasoningTextPart(previous) && isReasoningTextPart(part)) {
      const kind = previous.kind === 'reasoning' || part.kind === 'reasoning'
        ? 'reasoning'
        : previous.kind === 'thinking' || part.kind === 'thinking'
          ? 'thinking'
          : previous.kind === 'markdown' || part.kind === 'markdown'
            ? 'markdown'
            : 'text'
      const language = previous.language === part.language ? previous.language : undefined
      merged[merged.length - 1] = {
        kind,
        text: previous.text + part.text,
        ...(language !== undefined ? { language } : {}),
      }
      changed = true
    } else {
      merged.push(part)
    }
  }
  return changed ? merged : parts
}

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
    if (typeof value.source !== 'string') issues.push(issue(['source'], 'type.string', 'non-empty canonical media source', value.source))
    else if (!isValidMediaContentInput(value, kind)) issues.push(issue(['source'], 'content.media-source', 'valid canonical media source', value.source))
    if (value.sourceKind !== undefined && !isMediaSourceKind(value.sourceKind)) {
      issues.push(issue(['sourceKind'], 'content.media-source-kind', 'url, path, base64, or blob', value.sourceKind))
    }
    validateOptionalString(value, 'mimeType', issues)
    validateOptionalString(value, 'alt', issues)
    validateOptionalString(value, 'caption', issues)
    validateOptionalString(value, 'poster', issues)
    validateOptionalString(value, 'transcript', issues)
    if (!isValidMediaMime(kind, value.mimeType)) issues.push(issue(['mimeType'], 'content.media-mime', `${kind}/*`, value.mimeType))
    if (!isValidMediaDimension(value.width)) issues.push(issue(['width'], 'number.positive-finite', 'positive finite number', value.width))
    if (!isValidMediaDimension(value.height)) issues.push(issue(['height'], 'number.positive-finite', 'positive finite number', value.height))
    if (!isValidMediaDuration(value.durationMs)) issues.push(issue(['durationMs'], 'number.non-negative-finite', 'non-negative finite number', value.durationMs))
    if (hasForbiddenMediaSideChannel(value)) issues.push(issue([], 'content.media-side-channel', 'single canonical source without secret/raw side channels', value))
  } else if (kind === 'resource') {
    if (!isNonEmptyContentLocation(value.uri)) issues.push(issue(['uri'], 'type.string', 'non-empty string', value.uri))
    validateOptionalString(value, 'title', issues)
    validateOptionalString(value, 'mimeType', issues)
    validateOptionalString(value, 'text', issues)
    validateOptionalBoolean(value, 'hasBlob', issues)
    rejectInlineBlob(value, issues)
  } else if (kind === 'document') {
    validateOptionalString(value, 'title', issues)
    validateOptionalString(value, 'path', issues)
    validateOptionalString(value, 'uri', issues)
    validateOptionalString(value, 'mimeType', issues)
    validateOptionalString(value, 'text', issues)
    validateOptionalBoolean(value, 'hasBlob', issues)
    if (!['path', 'uri', 'text'].some(key => isNonEmptyContentLocation(value[key]))) {
      issues.push(issue([], 'content.document-source', 'path, uri, or text', value))
    }
    rejectInlineBlob(value, issues)
  } else if (kind === 'search-result') {
    if (!isValidSearchResultContentInput(value)) issues.push(issue([], 'content.search-result', 'normalized non-empty search results', value))
  } else if (kind === 'link') {
    if (!isValidLinkContentInput(value)) issues.push(issue(['url'], 'content.link', 'normalized non-empty link', value.url))
  } else if (kind === 'diff') {
    if (!isValidDiffContentInput(value)) issues.push(issue([], 'content.diff', 'normalized structured diff', value))
  } else if (kind === 'diagnostic-lsp') {
    if (!isValidLspDiagnosticContentInput(value)) issues.push(issue([], 'content.diagnostic-lsp', 'normalized LSP diagnostic', value))
  } else if (kind === 'terminal') {
    if (!isValidTerminalContentInput(value)) issues.push(issue([], 'content.terminal', 'normalized terminal output', value))
  } else if (kind === 'log') {
    if (!isValidLogContentInput(value)) issues.push(issue([], 'content.log', 'normalized structured log', value))
  } else if (kind === 'memory') {
    if (!isValidMemoryContentInput(value)) issues.push(issue([], 'content.memory', 'normalized memory metadata', value))
  } else if (kind === 'skill') {
    if (!isValidSkillContentInput(value)) issues.push(issue([], 'content.skill', 'normalized skill metadata', value))
  } else if (kind === 'mcp-resource') {
    if (!isValidMcpResourceContentInput(value)) issues.push(issue([], 'content.mcp-resource', 'normalized MCP resource metadata', value))
  } else if (kind === 'artifact') {
    if (!isValidArtifactContentInput(value)) issues.push(issue([], 'content.artifact', 'normalized artifact metadata and preview parts', value))
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

export function isValidSearchResultContentInput(input: unknown): input is Omit<SearchResultContentPart, 'kind'> | SearchResultContentPart {
  if (!isRecord(input) || !Array.isArray(input.results) || input.results.length === 0) return false
  if (input.query !== undefined && typeof input.query !== 'string') return false
  if (input.total !== undefined && (!Number.isInteger(input.total) || Number(input.total) < 0)) return false
  if (input.pagingToken !== undefined && (typeof input.pagingToken !== 'string' || input.pagingToken.trim().length === 0)) return false
  return input.results.every(isValidSearchResultEntry)
}

export function isValidLinkContentInput(input: unknown): input is Omit<LinkContentPart, 'kind'> | LinkContentPart {
  if (!isRecord(input) || typeof input.url !== 'string' || input.url.trim().length === 0) return false
  if (input.title !== undefined && typeof input.title !== 'string') return false
  return input.status === undefined || (Number.isInteger(input.status) && Number(input.status) >= 100 && Number(input.status) <= 599)
}

export function isValidMemoryContentInput(input: unknown): input is MemoryContentPart {
  return isRecord(input) && input.kind === 'memory'
    && nonEmptyString(input.memoryId) && nonEmptyString(input.title) && nonEmptyString(input.source)
    && validC15Common(input) && hasOnlyKeys(input, MEMORY_CONTENT_KEYS)
}

export function isValidSkillContentInput(input: unknown): input is SkillContentPart {
  return isRecord(input) && input.kind === 'skill'
    && nonEmptyString(input.skillId) && nonEmptyString(input.title) && nonEmptyString(input.source)
    && validC15Common(input) && (input.uri === undefined || nonEmptyString(input.uri))
    && hasOnlyKeys(input, SKILL_CONTENT_KEYS)
}

export function isValidMcpResourceContentInput(input: unknown): input is McpResourceContentPart {
  if (!isRecord(input) || input.kind !== 'mcp-resource' || !nonEmptyString(input.server) || !nonEmptyString(input.resourceUri)) return false
  if (!['tool', 'title', 'mimeType', 'summary', 'connectionState', 'status'].every(key => input[key] === undefined || nonEmptyString(input[key]))) return false
  return validSafeRaw(input.raw) && hasOnlyKeys(input, MCP_RESOURCE_CONTENT_KEYS)
}

export function isValidArtifactContentInput(input: unknown): input is ArtifactContentPart {
  if (!isRecord(input) || input.kind !== 'artifact' || !nonEmptyString(input.artifactId)
    || !nonEmptyString(input.title) || !nonEmptyString(input.uri) || !validC15Common(input)) return false
  if (input.mimeType !== undefined && !nonEmptyString(input.mimeType)) return false
  if (input.hasBlob !== undefined && typeof input.hasBlob !== 'boolean') return false
  if (input.actions !== undefined && (!Array.isArray(input.actions) || !input.actions.every(nonEmptyString))) return false
  if (input.parts !== undefined && (!Array.isArray(input.parts) || input.parts.length > MAX_ARTIFACT_PREVIEW_PARTS
    || !input.parts.every(part => parseContentPart(part).ok))) return false
  return input.blob === undefined && hasOnlyKeys(input, ARTIFACT_CONTENT_KEYS)
}

export function isValidHookSurfaceInput(input: unknown): input is HookSurfaceSnapshot {
  if (!isRecord(input) || !nonEmptyString(input.phase) || !nonEmptyString(input.status) || !isRecord(input.owner)) return false
  if (!nonEmptyString(input.owner.pluginId) || !nonEmptyString(input.owner.handlerId)) return false
  if (!hasOnlyKeys(input.owner, new Set(['pluginId', 'runtimeInstanceId', 'handlerId']))) return false
  if (input.owner.runtimeInstanceId !== undefined && !nonEmptyString(input.owner.runtimeInstanceId)) return false
  if (input.durationMs !== undefined && (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0)) return false
  if (input.decision !== undefined && !nonEmptyString(input.decision)) return false
  if (input.error !== undefined && (!isRecord(input.error) || !nonEmptyString(input.error.message)
    || input.error.code !== undefined && !nonEmptyString(input.error.code)
    || !hasOnlyKeys(input.error, new Set(['message', 'code'])))) return false
  return validSafeRaw(input.raw) && hasOnlyKeys(input, HOOK_SURFACE_KEYS)
}

export function isValidDiffContentInput(input: unknown): input is Omit<DiffContentPart, 'kind'> | DiffContentPart {
  if (!isRecord(input)) return false
  if (![input.path, input.oldPath].some(value => typeof value === 'string' && value.trim().length > 0)) return false
  if (input.status !== undefined && typeof input.status !== 'string') return false
  if (input.range !== undefined && !isValidTextRange(input.range)) return false
  if (input.lines !== undefined && (!Array.isArray(input.lines) || input.lines.length === 0 || !input.lines.every(line => (
    isRecord(line) && ['context', 'added', 'removed'].includes(String(line.kind)) && typeof line.text === 'string'
  )))) return false
  if (input.hunks !== undefined && (!Array.isArray(input.hunks) || input.hunks.length === 0 || !input.hunks.every(isValidDiffHunk))) return false
  for (const key of ['oldText', 'newText', 'unified'] as const) if (input[key] !== undefined && typeof input[key] !== 'string') return false
  for (const key of ['additions', 'deletions'] as const) if (input[key] !== undefined && (!Number.isInteger(input[key]) || Number(input[key]) < 0)) return false
  for (const key of ['binary', 'truncated'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') return false
  if (input.truncation !== undefined && !isValidTruncation(input.truncation)) return false
  if (input.rawPatch !== undefined && !isJsonValue(input.rawPatch)) return false
  if (input.unknownFields !== undefined && (!Array.isArray(input.unknownFields) || !input.unknownFields.every(value => typeof value === 'string'))) return false
  return input.binary === true
    || Array.isArray(input.lines) && input.lines.length > 0
    || Array.isArray(input.hunks) && input.hunks.length > 0
    || typeof input.unified === 'string' && input.unified.length > 0
}

export function isValidLspDiagnosticContentInput(input: unknown): input is Omit<LspDiagnosticContentPart, 'kind'> | LspDiagnosticContentPart {
  if (!isRecord(input) || typeof input.message !== 'string' || !input.message.trim()
    || typeof input.path !== 'string' || !input.path.trim()) return false
  for (const key of ['severity', 'code', 'source'] as const) if (input[key] !== undefined && typeof input[key] !== 'string') return false
  if (input.range !== undefined && !isValidTextRange(input.range)) return false
  if (input.related !== undefined && (!Array.isArray(input.related) || !input.related.every(value => (
    isRecord(value) && typeof value.message === 'string' && value.message.trim().length > 0
    && typeof value.path === 'string' && value.path.trim().length > 0
    && (value.range === undefined || isValidTextRange(value.range))
  )))) return false
  return input.unknownFields === undefined
    || Array.isArray(input.unknownFields) && input.unknownFields.every(value => typeof value === 'string')
}

export function isValidTerminalContentInput(input: unknown): input is Omit<TerminalContentPart, 'kind'> | TerminalContentPart {
  if (!isRecord(input) || !Array.isArray(input.streams)) return false
  if (input.command !== undefined && (typeof input.command !== 'string' || !input.command.trim())) return false
  if (input.command === undefined && input.streams.length === 0 && input.error === undefined) return false
  for (const key of ['processId', 'sessionId'] as const) {
    if (!isMissingOrNonEmptyString(input[key])) return false
  }
  if (input.status !== undefined && !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(input.status))) return false
  if (input.terminatedBy !== undefined && !['timeout', 'killed', 'signal'].includes(String(input.terminatedBy))) return false
  if (input.exitCode !== undefined && !Number.isInteger(input.exitCode)) return false
  if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || Number(input.durationMs) < 0)) return false
  if (input.env !== undefined && (!isRecord(input.env) || !Object.values(input.env).every(value => typeof value === 'string'))) return false
  if (input.truncation !== undefined && !isValidTerminalTruncation(input.truncation)) return false
  if (input.error !== undefined && (!isRecord(input.error) || typeof input.error.message !== 'string' || !input.error.message.trim()
    || (input.error.code !== undefined && typeof input.error.code !== 'string'))) return false
  return input.streams.every(isValidTerminalStreamEntry)
}

export function isValidLogContentInput(input: unknown): input is Omit<LogContentPart, 'kind'> | LogContentPart {
  if (!isRecord(input) || !Array.isArray(input.entries) || input.entries.length === 0) return false
  for (const key of ['source', 'processId', 'sessionId'] as const) {
    if (!isMissingOrNonEmptyString(input[key])) return false
  }
  if (input.truncation !== undefined && !isValidTerminalTruncation(input.truncation)) return false
  return input.entries.every(entry => isRecord(entry)
    && ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'].includes(String(entry.level))
    && (entry.originalLevel === undefined || typeof entry.originalLevel === 'string' && entry.originalLevel.trim().length > 0)
    && typeof entry.text === 'string'
    && isOptionalNonNegativeInteger(entry.ordinal)
    && isOptionalTimestamp(entry.timestamp)
    && isOptionalTimestampConfidence(entry.timestampConfidence))
}

function isValidTerminalStreamEntry(entry: unknown): boolean {
  return isRecord(entry)
    && (entry.stream === 'stdout' || entry.stream === 'stderr')
    && typeof entry.text === 'string'
    && isOptionalNonNegativeInteger(entry.ordinal)
    && (entry.lateAfterTerminal === undefined || typeof entry.lateAfterTerminal === 'boolean')
    && isOptionalTimestamp(entry.timestamp)
    && isOptionalTimestampConfidence(entry.timestampConfidence)
}

function isValidTerminalTruncation(value: unknown): value is TerminalOutputTruncation {
  if (!isRecord(value)) return false
  const fields = ['capturedLines', 'omittedLines', 'capturedBytes', 'omittedBytes'] as const
  return fields.some(key => value[key] !== undefined)
    && fields.every(key => isOptionalNonNegativeInteger(value[key]))
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || Number.isInteger(value) && Number(value) >= 0
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || typeof value === 'string' && value.trim().length > 0
}

function isOptionalTimestampConfidence(value: unknown): boolean {
  return value === undefined || ['exact', 'observed', 'synthetic', 'unknown'].includes(String(value))
}

function isValidDiffHunk(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = ['oldStart', 'oldLines', 'newStart', 'newLines'] as const
  return keys.some(key => value[key] !== undefined)
    && keys.every(key => value[key] === undefined || Number.isInteger(value[key]) && Number(value[key]) >= 0)
}

function isValidTextRange(value: unknown): value is TextRange {
  if (!isRecord(value) || !isValidTextPosition(value.start)) return false
  if (value.end !== undefined && !isValidTextPosition(value.end)) return false
  if (!value.end) return true
  const start = value.start as TextPosition
  const end = value.end as TextPosition
  return end.line > start.line || end.line === start.line && (end.character ?? 0) >= (start.character ?? 0)
}

function isValidTextPosition(value: unknown): value is TextPosition {
  return isRecord(value) && Number.isInteger(value.line) && Number(value.line) >= 0
    && (value.character === undefined || Number.isInteger(value.character) && Number(value.character) >= 0)
}

function isValidSearchResultEntry(input: unknown): input is SearchResultEntry {
  if (!isRecord(input) || typeof input.source !== 'string' || input.source.trim().length === 0) return false
  const snippet = input.snippet
  if (input.rank !== undefined && (!Number.isInteger(input.rank) || Number(input.rank) < 1)) return false
  if (input.title !== undefined && typeof input.title !== 'string') return false
  if (snippet !== undefined && typeof snippet !== 'string') return false
  if (input.score !== undefined && (typeof input.score !== 'number' || !Number.isFinite(input.score))) return false
  if (input.pagingToken !== undefined && (typeof input.pagingToken !== 'string' || input.pagingToken.trim().length === 0)) return false
  if (input.location !== undefined && !isValidSearchResultLocation(input.location)) return false
  if (input.highlights !== undefined) {
    if (!Array.isArray(input.highlights) || typeof snippet !== 'string') return false
    if (!input.highlights.every(range => isRecord(range)
      && Number.isInteger(range.start) && Number.isInteger(range.end)
      && Number(range.start) >= 0 && Number(range.end) > Number(range.start)
      && Number(range.end) <= snippet.length)) return false
  }
  return true
}

function isValidSearchResultLocation(input: unknown): input is SearchResultLocation {
  if (!isRecord(input)) return false
  for (const key of ['path', 'uri'] as const) {
    if (!isMissingOrNonEmptyString(input[key])) return false
  }
  for (const key of ['line', 'column', 'endLine', 'endColumn'] as const) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || Number(input[key]) < 0)) return false
  }
  return ['path', 'uri', 'line', 'column', 'endLine', 'endColumn'].some(key => input[key] !== undefined)
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
  return ['redacted-reasoning', 'document', 'file-reference', 'file-selection', 'diff', 'location', 'terminal', 'log', 'progress', 'list', 'key-value', 'json', 'link', 'search-result', 'diagnostic-lsp', 'tool-use', 'tool-result', 'artifact', 'memory', 'skill', 'mcp-resource'].includes(kind)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validC15Common(value: Record<string, unknown>): boolean {
  if (!['scope', 'summary', 'status'].every(key => value[key] === undefined || nonEmptyString(value[key]))) return false
  if (!['enabled', 'used'].every(key => value[key] === undefined || typeof value[key] === 'boolean')) return false
  if (value.version !== undefined && !(nonEmptyString(value.version)
    || typeof value.version === 'number' && Number.isFinite(value.version) && value.version >= 0)) return false
  return value.blob === undefined && validSafeRaw(value.raw)
}

function validSafeRaw(value: unknown): value is Readonly<Record<string, JsonValue>> | undefined {
  return value === undefined || isRecord(value) && Object.values(value).every(isJsonValue)
}

const MEMORY_CONTENT_KEYS = new Set(['kind', 'memoryId', 'title', 'source', 'scope', 'summary', 'status', 'version', 'enabled', 'used', 'raw'])
const SKILL_CONTENT_KEYS = new Set([...MEMORY_CONTENT_KEYS, 'skillId', 'uri'].filter(key => key !== 'memoryId'))
const MCP_RESOURCE_CONTENT_KEYS = new Set(['kind', 'server', 'resourceUri', 'tool', 'title', 'mimeType', 'summary', 'connectionState', 'status', 'raw'])
const ARTIFACT_CONTENT_KEYS = new Set(['kind', 'artifactId', 'title', 'uri', 'version', 'mimeType', 'summary', 'status', 'hasBlob', 'parts', 'actions', 'raw'])
const HOOK_SURFACE_KEYS = new Set(['phase', 'owner', 'status', 'durationMs', 'decision', 'error', 'raw'])
export const MAX_ARTIFACT_PREVIEW_PARTS = 256

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function validateOptionalString(value: Record<string, unknown>, key: string, issues: SchemaIssue[]): void {
  if (value[key] !== undefined && typeof value[key] !== 'string') issues.push(issue([key], 'type.string', 'string', value[key]))
}

function validateOptionalBoolean(value: Record<string, unknown>, key: string, issues: SchemaIssue[]): void {
  if (value[key] !== undefined && typeof value[key] !== 'boolean') issues.push(issue([key], 'type.boolean', 'boolean', value[key]))
}

function rejectInlineBlob(value: Record<string, unknown>, issues: SchemaIssue[]): void {
  if (value.blob !== undefined) issues.push(issue(['blob'], 'content.binary-inline', 'omitted binary payload', value.blob))
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
