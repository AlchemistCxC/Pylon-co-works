import {
  coalesceAdjacentDisplayTextParts,
  createUnknownContentPart,
  MAX_ARTIFACT_PREVIEW_PARTS,
  parseContentPart,
  type ContentPart,
  type JsonValue,
  type LspRelatedInformation,
  type LogContentEntry,
  type SearchHighlightRange,
  type SearchResultEntry,
  type SearchResultLocation,
  type TerminalStreamEntry,
  type TerminalContentPart,
  type TerminalOutputTruncation,
  type TextPosition,
  type TextRange,
} from '../content/contentPartSchema.ts'
import { diffSnapshotFromPart } from '../diffSnapshot.ts'
import {
  isNonEmptyContentLocation,
  isOptionalNonNegativeFiniteNumber,
  isValidFileSelection,
} from '../content/fileContentValidation.ts'
import {
  hasForbiddenMediaSideChannel,
  isMediaSourceKind,
  isValidMediaContentInput,
  type MediaContentKind,
  type MediaSourceKind,
} from '../content/mediaContentValidation.ts'
import {
  createWorkbenchEnvelope,
  type WorkbenchEventEnvelope,
  type WorkbenchEventIdentity,
  type WorkbenchEventProvenance,
  type WorkbenchSemanticEvent,
} from '../events/workbenchEventSchema.ts'
import type { NormalizeContext, NormalizeDiagnostic } from './agentEventNormalizer.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MAX_CANONICAL_OUTPUT_ENTRIES = 20_000
const MAX_CANONICAL_OUTPUT_BYTES = 2 * 1024 * 1024
const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder()

export function extractUpdate(input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined
  const params = isRecord(input.params) ? input.params : undefined
  if (isRecord(params?.update)) return params.update
  if (isRecord(input.update)) return input.update
  if (typeof input.sessionUpdate === 'string') return input
  if (typeof params?.sessionUpdate === 'string') return params
  return undefined
}

export function wireKind(update: Record<string, unknown> | undefined): string {
  const value = update?.sessionUpdate ?? update?.type
  return typeof value === 'string' && value.trim() ? value : 'malformed'
}

export function identityFromUpdate(update: Record<string, unknown> | undefined): WorkbenchEventIdentity {
  if (!update) return {}
  const content = isRecord(update.content) ? update.content : undefined
  const meta = isRecord(update._meta) ? update._meta : undefined
  const claudeMeta = isRecord(meta?.claudeCode) ? meta.claudeCode : undefined
  const pick = (keys: readonly string[], records: readonly (Record<string, unknown> | undefined)[]): string | undefined => {
    for (const record of records) {
      for (const key of keys) {
        const value = record?.[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
    return undefined
  }
  const identity: WorkbenchEventIdentity = {
    ...(pick(['turnId', 'turn_id'], [content, update, meta]) ? { turnId: pick(['turnId', 'turn_id'], [content, update, meta]) } : {}),
    ...(pick(['messageId', 'message_id'], [content, update, meta]) ? { messageId: pick(['messageId', 'message_id'], [content, update, meta]) } : {}),
    ...(pick(['toolCallId', 'tool_call_id', 'toolUseId', 'tool_use_id'], [update, content, meta]) ? { toolCallId: pick(['toolCallId', 'tool_call_id', 'toolUseId', 'tool_use_id'], [update, content, meta]) } : {}),
    ...(pick(['taskId', 'task_id'], [content, update, meta]) ? { taskId: pick(['taskId', 'task_id'], [content, update, meta]) } : {}),
    ...(pick(['runId', 'run_id'], [content, update, meta]) ? { runId: pick(['runId', 'run_id'], [content, update, meta]) } : {}),
    ...(pick(['interactionId', 'interaction_id', 'requestId', 'request_id'], [content, update, meta]) ? { interactionId: pick(['interactionId', 'interaction_id', 'requestId', 'request_id'], [content, update, meta]) } : {}),
    ...(pick(['parentToolUseId', 'parent_tool_use_id'], [claudeMeta, meta]) ? { taskId: pick(['parentToolUseId', 'parent_tool_use_id'], [claudeMeta, meta]) } : {}),
  }
  return identity
}

export function createDiagnostic(
  context: NormalizeContext,
  update: Record<string, unknown> | undefined,
  code: string,
  message: string,
  path: readonly (string | number)[] = [],
  recoverable = true,
): NormalizeDiagnostic {
  return {
    provider: context.provider,
    sessionId: context.sessionId,
    wireKind: wireKind(update),
    path,
    code,
    message,
    recoverable,
  }
}

export function normalizeContentBlocks(
  raw: unknown,
  context: NormalizeContext,
  update: Record<string, unknown> | undefined,
): { parts: ContentPart[]; diagnostics: NormalizeDiagnostic[] } {
  const blocks = Array.isArray(raw) ? raw : raw === undefined ? [] : typeof raw === 'string' ? [{ type: 'text', text: raw }] : [raw]
  const parts: ContentPart[] = []
  const diagnostics: NormalizeDiagnostic[] = []
  blocks.forEach((block, index) => {
    const normalized = normalizeContentBlock(block)
    parts.push(normalized.part)
    if (normalized.diagnostic) diagnostics.push({
      ...createDiagnostic(context, update, normalized.diagnostic.code, normalized.diagnostic.message, ['content', index, ...normalized.diagnostic.path]),
      recoverable: true,
    })
  })
  return { parts: [...coalesceAdjacentDisplayTextParts(parts)], diagnostics }
}

export function normalizeContentBlock(raw: unknown): { part: ContentPart; diagnostic?: { code: string; message: string; path: readonly (string | number)[] } } {
  if (!isRecord(raw)) return {
    part: createUnknownContentPart('malformed', raw),
    diagnostic: { code: 'content.malformed', message: 'content block is not an object', path: [] },
  }
  const type = typeof raw.type === 'string' ? raw.type : typeof raw.kind === 'string' ? raw.kind : typeof raw.text === 'string' ? 'text' : 'unknown'
  switch (type) {
    case 'text':
      return typeof raw.text === 'string'
        ? { part: { kind: 'text', text: raw.text } }
        : { part: createUnknownContentPart('text', raw), diagnostic: { code: 'content.text.invalid', message: 'text block has no string text', path: ['text'] } }
    case 'thinking':
    case 'reasoning':
      return typeof raw.text === 'string'
        ? { part: { kind: 'reasoning', text: raw.text } }
        : { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.reasoning.invalid', message: 'reasoning block has no string text', path: ['text'] } }
    case 'image':
    case 'audio':
    case 'video':
      return normalizeMediaContentBlock(raw, type)
    case 'resource_link':
      return isNonEmptyContentLocation(raw.uri) ? { part: { kind: 'resource', uri: raw.uri, ...(typeof raw.name === 'string' ? { title: raw.name } : {}), ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType } : {}) } } : { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.resource.invalid', message: 'resource link has no URI', path: ['uri'] } }
    case 'resource': {
      const resource = isRecord(raw.resource) ? raw.resource : raw
      return isNonEmptyContentLocation(resource.uri) ? { part: { kind: 'resource', uri: resource.uri, ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}), ...(typeof resource.text === 'string' ? { text: resource.text } : {}), ...(typeof resource.blob === 'string' ? { hasBlob: true } : {}), ...(typeof resource.title === 'string' ? { title: resource.title } : {}) } } : { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.resource.invalid', message: 'embedded resource has no URI', path: ['resource', 'uri'] } }
    }
    // C05：搜索结果逐条收窄为 provider-neutral snapshot；provider 私有字段不越过 seam。
    case 'search_result': {
      const sourceResults = Array.isArray(raw.results) ? raw.results : []
      const results = sourceResults.flatMap(entry => {
        const normalized = normalizeSearchResultEntry(entry)
        return normalized ? [normalized] : []
      })
      if (results.length === 0) {
        return { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.search-result.empty', message: 'search result block has no entries', path: ['results'] } }
      }
      return {
        part: {
          kind: 'search-result',
          ...nonEmptyTrimmed(raw.query, 'query'),
          ...(Number.isInteger(raw.total) && Number(raw.total) >= 0 ? { total: Number(raw.total) } : {}),
          ...nonEmptyTrimmed(raw.pagingToken, 'pagingToken'),
          results,
        },
        ...(results.length < sourceResults.length ? { diagnostic: {
          code: 'content.search-result.entries-dropped',
          message: `${sourceResults.length - results.length} malformed search result entries were dropped`,
          path: ['results'],
        } } : {}),
      }
    }
    case 'memory':
      return normalizeC15ContentBlock(raw, 'memory')
    case 'skill':
      return normalizeC15ContentBlock(raw, 'skill')
    case 'mcp-resource':
    case 'mcp_resource':
      return normalizeC15ContentBlock(raw, 'mcp-resource')
    case 'artifact':
      return normalizeC15ContentBlock(raw, 'artifact')
    // C05：链接只保留 canonical URL/title/status；scheme 白名单由 command presentation 裁决。
    case 'link': {
      if (typeof raw.url !== 'string' || !raw.url.trim()) {
        return { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.link.invalid', message: 'link block has no URL', path: ['url'] } }
      }
      return {
        part: {
          kind: 'link',
          url: raw.url.trim(),
          ...nonEmptyTrimmed(raw.title, 'title'),
          ...(Number.isInteger(raw.status) && Number(raw.status) >= 100 && Number(raw.status) <= 599 ? { status: Number(raw.status) } : {}),
        },
      }
    }
    // C07：终端——command/streams/exit/status/durationMs 结构化保留；streams 分条不合并；
    // env 表 secret-like 值脱敏；缺 command 且缺 streams 进 unknown。
    case 'terminal': {
      const sourceStreams = Array.isArray(raw.streams) ? raw.streams : []
      const normalizedStreams = sourceStreams.flatMap(entry => {
        const normalized = normalizeTerminalStreamEntry(entry)
        return normalized ? [normalized] : []
      })
      const boundedStreams = boundCanonicalTextEntries(normalizedStreams)
      const streams = boundedStreams.entries
      const command = typeof raw.command === 'string' && raw.command.trim() ? raw.command.trim() : undefined
      const error = normalizeTerminalError(raw.error)
      const truncation = mergeCanonicalOutputTruncation(
        normalizeTerminalTruncation(raw.truncation),
        boundedStreams,
      )
      const droppedFields = terminalDroppedFields(raw)
      const malformedStreamCount = sourceStreams.length - normalizedStreams.length
      if (!command && streams.length === 0 && !error) {
        return { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.terminal.invalid', message: 'terminal block needs command, output, or error', path: [] } }
      }
      return {
        part: {
          kind: 'terminal',
          ...(command ? { command } : {}),
          ...nonEmptyTrimmed(raw.processId ?? raw.process_id, 'processId'),
          ...nonEmptyTrimmed(raw.sessionId ?? raw.session_id, 'sessionId'),
          streams,
          ...(Number.isInteger(raw.exitCode) ? { exitCode: Number(raw.exitCode) } : {}),
          ...(['timeout', 'killed', 'signal'].includes(String(raw.terminatedBy)) ? { terminatedBy: raw.terminatedBy as 'timeout' | 'killed' | 'signal' } : {}),
          ...(['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(raw.status)) ? { status: raw.status as 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' } : {}),
          ...(typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? { durationMs: raw.durationMs } : {}),
          ...(isRecord(raw.env) ? { env: redactSecretEnv(raw.env) } : {}),
          ...(truncation ? { truncation } : {}),
          ...(error ? { error } : {}),
        },
        ...(malformedStreamCount > 0 ? { diagnostic: {
          code: 'content.terminal.entries-dropped',
          message: `${malformedStreamCount} malformed terminal stream entries were dropped`,
          path: ['streams'],
        } } : droppedFields.length > 0 ? { diagnostic: {
          code: 'content.terminal.fields-dropped',
          message: `malformed or unknown terminal fields were dropped: ${droppedFields.join(', ')}`,
          path: [],
        } } : {}),
      }
    }
    // C07：结构化日志——source + entries（level/text/timestampConfidence）。
    case 'log': {
      const sourceEntries = Array.isArray(raw.entries) ? raw.entries : []
      const normalizedEntries = sourceEntries.flatMap(entry => {
        const normalized = normalizeLogContentEntry(entry)
        return normalized ? [normalized] : []
      })
      const boundedEntries = boundCanonicalTextEntries(normalizedEntries)
      const entries = boundedEntries.entries
      if (entries.length === 0) {
        return { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.log.empty', message: 'log block has no entries', path: ['entries'] } }
      }
      const truncation = mergeCanonicalOutputTruncation(
        normalizeTerminalTruncation(raw.truncation),
        boundedEntries,
      )
      const droppedFields = logDroppedFields(raw)
      const malformedEntryCount = sourceEntries.length - normalizedEntries.length
      return {
        part: {
          kind: 'log',
          ...nonEmptyTrimmed(raw.source, 'source'),
          ...nonEmptyTrimmed(raw.processId ?? raw.process_id, 'processId'),
          ...nonEmptyTrimmed(raw.sessionId ?? raw.session_id, 'sessionId'),
          entries,
          ...(truncation ? { truncation } : {}),
        },
        ...(malformedEntryCount > 0 ? { diagnostic: {
          code: 'content.log.entries-dropped',
          message: `${malformedEntryCount} malformed log entries were dropped`,
          path: ['entries'],
        } } : droppedFields.length > 0 ? { diagnostic: {
          code: 'content.log.fields-dropped',
          message: `malformed or unknown log fields were dropped: ${droppedFields.join(', ')}`,
          path: [],
        } } : {}),
      }
    }
    // C06：LSP diagnostic——severity/code/source/message/path/range/related 结构化保留；
    // 缺 message 或 path 进 unknown（diagnostic 无定位与内容则不可用）。
    case 'lsp_diagnostic': {
      if (typeof raw.message !== 'string' || !raw.message.trim() || typeof raw.path !== 'string' || !raw.path.trim()) {
        return { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.diagnostic-lsp.invalid', message: 'lsp diagnostic needs message and path', path: ['message'] } }
      }
      const range = normalizeTextRange(raw.range)
      const sourceRelated = Array.isArray(raw.related) ? raw.related : []
      const related = sourceRelated.flatMap(value => {
        const item = normalizeRelatedDiagnostic(value)
        return item ? [item] : []
      })
      const knownFields = new Set(['type', 'kind', 'severity', 'code', 'source', 'message', 'path', 'range', 'related'])
      const unknownFields = Object.keys(raw).filter(key => !knownFields.has(key))
      const fieldsDropped = unknownFields.length > 0
        || (raw.range !== undefined && (!range || hasUnknownRangeFields(raw.range)))
        || (raw.related !== undefined && !Array.isArray(raw.related))
        || related.length < sourceRelated.length
        || sourceRelated.some(hasUnknownRelatedFields)
        || hasInvalidKnownLspField(raw)
      return {
        part: {
          kind: 'diagnostic-lsp',
          ...nonEmptyTrimmed(raw.severity, 'severity'),
          ...(typeof raw.code === 'string' || typeof raw.code === 'number' && Number.isFinite(raw.code)
            ? { code: String(raw.code) } : {}),
          ...nonEmptyTrimmed(raw.source, 'source'),
          message: raw.message.trim(),
          path: raw.path.trim(),
          ...(range ? { range } : {}),
          ...(related.length > 0 ? { related } : {}),
          ...(unknownFields.length > 0 ? { unknownFields } : {}),
        },
        ...(fieldsDropped ? { diagnostic: {
          code: 'content.diagnostic-lsp.fields-dropped',
          message: 'malformed or provider-private LSP fields were dropped',
          path: [],
        } } : {}),
      }
    }
    // C02：文件引用——path 保持原样（Windows/URI 不做字符串猜测互转）
    case 'file_reference': {
      if (typeof raw.path !== 'string' || !raw.path.trim() || !isOptionalNonNegativeFiniteNumber(raw.size)) {
        return { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.file-reference.invalid', message: 'file reference has no path', path: ['path'] } }
      }
      return {
        part: {
          kind: 'file-reference',
          path: raw.path,
          ...(typeof raw.displayName === 'string' ? { displayName: raw.displayName } : {}),
          ...(typeof raw.mime === 'string' ? { mime: raw.mime } : {}),
          ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
        },
      }
    }
    // C02：选择区——必须带 path 与 selection；缺 path 进 unknown 不猜
    case 'file_selection': {
      if (typeof raw.path !== 'string' || !raw.path.trim() || !isRecord(raw.selection) || !isValidFileSelection(raw.selection)) {
        return { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.file-selection.invalid', message: 'file selection needs path and selection range', path: ['path'] } }
      }
      const selection = raw.selection
      const start = isRecord(selection.start) ? selection.start : {}
      const end = isRecord(selection.end) ? selection.end : {}
      return {
        part: {
          kind: 'file-selection',
          path: raw.path,
          selection: {
            ...(Number.isInteger(start.line) ? { start: { line: start.line, ...(Number.isInteger(start.column) ? { column: start.column } : {}) } } : {}),
            ...(Number.isInteger(end.line) ? { end: { line: end.line, ...(Number.isInteger(end.column) ? { column: end.column } : {}) } } : {}),
          },
          ...(typeof raw.language === 'string' ? { language: raw.language } : {}),
          ...(typeof raw.previewText === 'string' ? { previewText: raw.previewText } : {}),
        },
      }
    }
    case 'diff': {
      const rawPatch = raw.rawPatch === undefined
        ? undefined
        : createUnknownContentPart('diff.rawPatch', raw.rawPatch).raw
      const snapshot = diffSnapshotFromPart({
        ...raw,
        kind: 'diff',
        ...(rawPatch !== undefined ? { rawPatch } : {}),
      })
      const hasLocation = Boolean(snapshot?.path || snapshot?.oldPath)
      const hasDiff = Boolean(snapshot?.binary || snapshot?.lines?.length || snapshot?.hunks?.length || snapshot?.unified)
      if (!snapshot || !hasLocation || !hasDiff) {
        return { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.diff.invalid', message: 'diff block needs a path and structured diff content', path: ['path'] } }
      }
      const dropped = Boolean(
        snapshot.unknownFields?.length
        || (raw.range !== undefined && (!snapshot.range || hasUnknownRangeFields(raw.range)))
        || (Array.isArray(raw.lines) && raw.lines.length !== snapshot.lines?.length)
        || (Array.isArray(raw.hunks) && raw.hunks.length !== snapshot.hunks?.length)
        || hasInvalidKnownDiffField(raw, snapshot),
      )
      return {
        part: { kind: 'diff', ...snapshot },
        ...(dropped ? { diagnostic: {
          code: 'content.diff.fields-dropped',
          message: 'malformed or provider-private diff fields were dropped',
          path: [],
        } } : {}),
      }
    }
    case 'location':
      return { part: { kind: 'location', ...toJsonRecord(raw) } }
    case 'code':
      return typeof raw.text === 'string' ? { part: { kind: 'code', text: raw.text, ...(typeof raw.language === 'string' ? { language: raw.language } : {}) } } : { part: createUnknownContentPart(type, raw), diagnostic: { code: 'content.code.invalid', message: 'code block has no string text', path: ['text'] } }
    default:
      return { part: createUnknownContentPart(type, raw) }
  }
}

function normalizeC15ContentBlock(
  raw: Record<string, unknown>,
  kind: 'memory' | 'skill' | 'mcp-resource' | 'artifact',
): { part: ContentPart; diagnostic?: { code: string; message: string; path: readonly (string | number)[] } } {
  const statusSummary = {
    ...c15OptionalString(raw.summary, 'summary'),
    ...c15OptionalString(raw.status, 'status'),
  }
  const memorySkillCommon = {
    ...statusSummary,
    ...c15OptionalString(raw.scope, 'scope'),
    ...c15OptionalVersion(raw.version),
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(typeof raw.used === 'boolean' ? { used: raw.used } : {}),
  }
  const artifactCommon = { ...statusSummary, ...c15OptionalVersion(raw.version) }
  let candidate: Record<string, unknown>
  let known: readonly string[]
  if (kind === 'memory') {
    known = ['type', 'kind', 'memoryId', 'memory_id', 'id', 'title', 'source', 'scope', 'summary', 'status', 'version', 'enabled', 'used']
    candidate = {
      kind,
      memoryId: c15RequiredString(raw.memoryId ?? raw.memory_id ?? raw.id),
      title: c15RequiredString(raw.title), source: c15RequiredString(raw.source), ...memorySkillCommon,
    }
  } else if (kind === 'skill') {
    known = ['type', 'kind', 'skillId', 'skill_id', 'id', 'title', 'name', 'source', 'scope', 'summary', 'status', 'version', 'enabled', 'used', 'uri']
    candidate = {
      kind,
      skillId: c15RequiredString(raw.skillId ?? raw.skill_id ?? raw.id),
      title: c15RequiredString(raw.title ?? raw.name), source: c15RequiredString(raw.source), ...memorySkillCommon,
      ...c15OptionalString(raw.uri, 'uri'),
    }
  } else if (kind === 'mcp-resource') {
    known = ['type', 'kind', 'server', 'server_name', 'resourceUri', 'resource_uri', 'uri', 'tool', 'tool_name', 'title', 'mimeType', 'mime_type', 'summary', 'connectionState', 'connection_state', 'status']
    candidate = {
      kind,
      server: c15RequiredString(raw.server ?? raw.server_name),
      resourceUri: c15RequiredString(raw.resourceUri ?? raw.resource_uri ?? raw.uri),
      ...c15OptionalString(raw.tool ?? raw.tool_name, 'tool'),
      ...c15OptionalString(raw.title, 'title'),
      ...c15OptionalString(raw.mimeType ?? raw.mime_type, 'mimeType'),
      ...c15OptionalString(raw.summary, 'summary'),
      ...c15OptionalString(raw.connectionState ?? raw.connection_state, 'connectionState'),
      ...c15OptionalString(raw.status, 'status'),
    }
  } else {
    known = ['type', 'kind', 'artifactId', 'artifact_id', 'id', 'title', 'uri', 'version', 'mimeType', 'mime_type', 'summary', 'status', 'blob', 'hasBlob', 'has_blob', 'parts', 'content', 'actions']
    const sourceParts = Array.isArray(raw.parts) ? raw.parts : Array.isArray(raw.content) ? raw.content : []
    const parts = coalesceAdjacentDisplayTextParts(
      sourceParts.slice(0, MAX_ARTIFACT_PREVIEW_PARTS).map(part => normalizeContentBlock(part).part),
    )
    candidate = {
      kind,
      artifactId: c15RequiredString(raw.artifactId ?? raw.artifact_id ?? raw.id),
      title: c15RequiredString(raw.title), uri: c15RequiredString(raw.uri), ...artifactCommon,
      ...c15OptionalString(raw.mimeType ?? raw.mime_type, 'mimeType'),
      ...(raw.blob !== undefined || raw.hasBlob === true || raw.has_blob === true ? { hasBlob: true } : {}),
      ...(parts.length > 0 ? { parts } : {}),
      ...(Array.isArray(raw.actions) ? { actions: raw.actions.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) } : {}),
    }
  }
  const rawFields = c15SafeUnknownFields(raw, known)
  if (rawFields) candidate.raw = rawFields
  const parsed = parseContentPart(candidate)
  if (c15HasInvalidKnownField(raw, kind)) {
    return {
      part: c15UnknownPart(raw, kind),
      diagnostic: { code: `content.${kind}.invalid`, message: `invalid normalized ${kind} content`, path: [] },
    }
  }
  if (parsed.ok) return { part: parsed.value }
  return {
    part: c15UnknownPart(raw, kind),
    diagnostic: { code: `content.${kind}.invalid`, message: `invalid normalized ${kind} content`, path: [] },
  }
}

function c15UnknownPart(raw: Record<string, unknown>, kind: 'memory' | 'skill' | 'mcp-resource' | 'artifact'): ContentPart {
  if (kind !== 'artifact') return createUnknownContentPart(kind, raw)
  const malformedInlineContent = raw.content !== undefined && !Array.isArray(raw.content)
  const safe = Object.fromEntries(Object.entries(raw).filter(([key]) => (
    key !== 'blob' && key !== 'base64' && !(key === 'content' && malformedInlineContent)
  )).map(([key, value]) => [key, (key === 'parts' || key === 'content') && Array.isArray(value)
    ? value.slice(0, MAX_ARTIFACT_PREVIEW_PARTS) : value]))
  const hasBlob = raw.blob !== undefined || raw.base64 !== undefined || malformedInlineContent
    || raw.hasBlob === true || raw.has_blob === true
  const omittedParts = Math.max(
    Array.isArray(raw.parts) ? raw.parts.length - MAX_ARTIFACT_PREVIEW_PARTS : 0,
    Array.isArray(raw.content) ? raw.content.length - MAX_ARTIFACT_PREVIEW_PARTS : 0,
  )
  return createUnknownContentPart(kind, { ...safe, ...(hasBlob ? { hasBlob: true } : {}), ...(omittedParts > 0 ? { omittedParts } : {}) })
}

function c15RequiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function c15OptionalString<Key extends string>(value: unknown, key: Key): Partial<Record<Key, string>> {
  return typeof value === 'string' && value.trim() ? { [key]: value.trim() } as Partial<Record<Key, string>> : {}
}

function c15OptionalVersion(value: unknown): { version?: string | number } {
  if (typeof value === 'string' && value.trim()) return { version: value.trim() }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { version: value }
  return {}
}

function c15SafeUnknownFields(raw: Record<string, unknown>, known: readonly string[]): Readonly<Record<string, JsonValue>> | undefined {
  const knownNames = new Set(known)
  const unknown = Object.fromEntries(Object.entries(raw).filter(([key]) => !knownNames.has(key)))
  if (Object.keys(unknown).length === 0) return undefined
  const safe = createUnknownContentPart('c15.metadata', unknown).raw
  return isRecord(safe) ? safe : { value: safe }
}

function c15HasInvalidKnownField(raw: Record<string, unknown>, kind: 'memory' | 'skill' | 'mcp-resource' | 'artifact'): boolean {
  for (const key of ['summary', 'status'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) return true
  }
  if ((kind === 'memory' || kind === 'skill' || kind === 'artifact') && raw.version !== undefined
    && !(typeof raw.version === 'string' && raw.version.trim()
      || typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 0)) return true
  if (kind === 'memory' || kind === 'skill') {
    if (raw.scope !== undefined && (typeof raw.scope !== 'string' || !raw.scope.trim())) return true
    for (const key of ['enabled', 'used'] as const) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') return true
  }
  if (kind === 'skill' && raw.uri !== undefined && (typeof raw.uri !== 'string' || !raw.uri.trim())) return true
  if (kind === 'mcp-resource') {
    for (const key of ['tool', 'tool_name', 'title', 'mimeType', 'mime_type', 'summary', 'connectionState', 'connection_state', 'status'] as const) {
      if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) return true
    }
  }
  if (kind === 'artifact') {
    if ((raw.mimeType !== undefined && (typeof raw.mimeType !== 'string' || !raw.mimeType.trim()))
      || (raw.mime_type !== undefined && (typeof raw.mime_type !== 'string' || !raw.mime_type.trim()))) return true
    if (raw.hasBlob !== undefined && typeof raw.hasBlob !== 'boolean') return true
    if (raw.has_blob !== undefined && typeof raw.has_blob !== 'boolean') return true
    if (raw.parts !== undefined && (!Array.isArray(raw.parts) || raw.parts.length > MAX_ARTIFACT_PREVIEW_PARTS)) return true
    if (raw.content !== undefined && (!Array.isArray(raw.content) || raw.content.length > MAX_ARTIFACT_PREVIEW_PARTS)) return true
    if (raw.actions !== undefined && (!Array.isArray(raw.actions) || !raw.actions.every(value => typeof value === 'string' && value.trim()))) return true
  }
  return false
}

function normalizeSearchResultEntry(value: unknown): SearchResultEntry | undefined {
  if (!isRecord(value) || typeof value.source !== 'string' || value.source.trim().length === 0) return undefined
  const snippet = typeof value.snippet === 'string' ? value.snippet : undefined
  const highlights = snippet === undefined ? undefined : normalizeHighlightRanges(value.highlights, snippet.length)
  const location = normalizeSearchResultLocation(value.location)
  return {
    source: value.source.trim(),
    ...(Number.isInteger(value.rank) && Number(value.rank) >= 1 ? { rank: Number(value.rank) } : {}),
    ...nonEmptyTrimmed(value.title, 'title'),
    ...(location ? { location } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(highlights && highlights.length > 0 ? { highlights } : {}),
    ...(typeof value.score === 'number' && Number.isFinite(value.score) ? { score: value.score } : {}),
    ...nonEmptyTrimmed(value.pagingToken, 'pagingToken'),
  }
}

function normalizeTextPosition(value: unknown): TextPosition | undefined {
  if (!isRecord(value) || !Number.isInteger(value.line) || Number(value.line) < 0) return undefined
  if (value.character !== undefined && (!Number.isInteger(value.character) || Number(value.character) < 0)) return undefined
  return {
    line: Number(value.line),
    ...(value.character !== undefined ? { character: Number(value.character) } : {}),
  }
}

function normalizeTextRange(value: unknown): TextRange | undefined {
  if (!isRecord(value)) return undefined
  const start = normalizeTextPosition(value.start)
  const end = value.end === undefined ? undefined : normalizeTextPosition(value.end)
  if (!start || value.end !== undefined && !end) return undefined
  if (end && (end.line < start.line || end.line === start.line && (end.character ?? 0) < (start.character ?? 0))) return undefined
  return { start, ...(end ? { end } : {}) }
}

function hasUnknownRangeFields(value: unknown): boolean {
  if (!isRecord(value)) return true
  if (Object.keys(value).some(key => key !== 'start' && key !== 'end')) return true
  return [value.start, value.end].filter(item => item !== undefined)
    .some(item => !isRecord(item) || Object.keys(item).some(key => key !== 'line' && key !== 'character'))
}

function normalizeRelatedDiagnostic(value: unknown): LspRelatedInformation | undefined {
  if (!isRecord(value) || typeof value.message !== 'string' || !value.message.trim()
    || typeof value.path !== 'string' || !value.path.trim()) return undefined
  const range = value.range === undefined ? undefined : normalizeTextRange(value.range)
  if (value.range !== undefined && !range) return undefined
  return {
    message: value.message.trim(),
    path: value.path.trim(),
    ...(range ? { range } : {}),
  }
}

function hasUnknownRelatedFields(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => !['message', 'path', 'range'].includes(key))) return true
  return value.range !== undefined && hasUnknownRangeFields(value.range)
}

function hasInvalidKnownDiffField(raw: Record<string, unknown>, snapshot: NonNullable<ReturnType<typeof diffSnapshotFromPart>>): boolean {
  for (const key of ['oldPath', 'status'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) return true
  }
  for (const key of ['oldText', 'newText', 'unified'] as const) if (raw[key] !== undefined && typeof raw[key] !== 'string') return true
  for (const key of ['additions', 'deletions'] as const) {
    if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || Number(raw[key]) < 0)) return true
  }
  for (const key of ['binary', 'truncated'] as const) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') return true
  if (raw.truncation !== undefined && snapshot.truncation === undefined) return true
  if (raw.lines !== undefined && !Array.isArray(raw.lines)) return true
  if (raw.hunks !== undefined && !Array.isArray(raw.hunks)) return true
  return false
}

function hasInvalidKnownLspField(raw: Record<string, unknown>): boolean {
  for (const key of ['severity', 'source'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) return true
  }
  return raw.code !== undefined
    && !(typeof raw.code === 'string' || typeof raw.code === 'number' && Number.isFinite(raw.code))
}

function normalizeSearchResultLocation(value: unknown): SearchResultLocation | undefined {
  if (!isRecord(value)) return undefined
  const location: SearchResultLocation = {
    ...nonEmptyTrimmed(value.path, 'path'),
    ...nonEmptyTrimmed(value.uri, 'uri'),
    ...(Number.isInteger(value.line) && Number(value.line) >= 0 ? { line: Number(value.line) } : {}),
    ...(Number.isInteger(value.column) && Number(value.column) >= 0 ? { column: Number(value.column) } : {}),
    ...(Number.isInteger(value.endLine) && Number(value.endLine) >= 0 ? { endLine: Number(value.endLine) } : {}),
    ...(Number.isInteger(value.endColumn) && Number(value.endColumn) >= 0 ? { endColumn: Number(value.endColumn) } : {}),
  }
  return Object.keys(location).length > 0 ? location : undefined
}

function normalizeHighlightRanges(value: unknown, snippetLength: number): readonly SearchHighlightRange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ranges = value.flatMap(range => isRecord(range)
    && Number.isInteger(range.start) && Number.isInteger(range.end)
    && Number(range.start) >= 0 && Number(range.end) > Number(range.start)
    && Number(range.end) <= snippetLength
    ? [{ start: Number(range.start), end: Number(range.end) }]
    : [])
  return ranges.length > 0 ? ranges : undefined
}

function nonEmptyTrimmed<Key extends string>(value: unknown, key: Key): Partial<Record<Key, string>> {
  if (typeof value !== 'string' || value.trim().length === 0) return {}
  return { [key]: value.trim() } as Partial<Record<Key, string>>
}

function normalizeTerminalStreamEntry(value: unknown): TerminalStreamEntry | undefined {
  if (!isRecord(value) || (value.stream !== 'stdout' && value.stream !== 'stderr') || typeof value.text !== 'string') return undefined
  if (value.ordinal !== undefined && (!Number.isInteger(value.ordinal) || Number(value.ordinal) < 0)) return undefined
  if (value.lateAfterTerminal !== undefined && typeof value.lateAfterTerminal !== 'boolean') return undefined
  if (value.timestamp !== undefined && (typeof value.timestamp !== 'string' || !value.timestamp.trim())) return undefined
  if (value.timestampConfidence !== undefined && !['exact', 'observed', 'synthetic', 'unknown'].includes(String(value.timestampConfidence))) return undefined
  return {
    stream: value.stream,
    text: value.text,
    ...(value.ordinal !== undefined ? { ordinal: Number(value.ordinal) } : {}),
    ...(value.lateAfterTerminal === true ? { lateAfterTerminal: true } : {}),
    ...(typeof value.timestamp === 'string' ? { timestamp: value.timestamp.trim() } : {}),
    ...(typeof value.timestampConfidence === 'string'
      ? { timestampConfidence: value.timestampConfidence as TerminalStreamEntry['timestampConfidence'] }
      : {}),
  }
}

function normalizeLogContentEntry(value: unknown): LogContentEntry | undefined {
  if (!isRecord(value) || typeof value.text !== 'string') return undefined
  if (value.ordinal !== undefined && (!Number.isInteger(value.ordinal) || Number(value.ordinal) < 0)) return undefined
  if (value.timestamp !== undefined && (typeof value.timestamp !== 'string' || !value.timestamp.trim())) return undefined
  if (value.timestampConfidence !== undefined && !['exact', 'observed', 'synthetic', 'unknown'].includes(String(value.timestampConfidence))) return undefined
  const sourceLevel = typeof value.level === 'string' && value.level.trim() ? value.level.trim().toLowerCase() : 'unknown'
  const level = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(sourceLevel)
    ? sourceLevel as LogContentEntry['level']
    : 'unknown'
  return {
    level,
    ...(level === 'unknown' && sourceLevel !== 'unknown' ? { originalLevel: sourceLevel } : {}),
    text: value.text,
    ...(value.ordinal !== undefined ? { ordinal: Number(value.ordinal) } : {}),
    ...(typeof value.timestamp === 'string' ? { timestamp: value.timestamp.trim() } : {}),
    ...(typeof value.timestampConfidence === 'string'
      ? { timestampConfidence: value.timestampConfidence as LogContentEntry['timestampConfidence'] }
      : {}),
  }
}

function normalizeTerminalTruncation(value: unknown): TerminalOutputTruncation | undefined {
  if (!isRecord(value)) return undefined
  const field = (key: keyof TerminalOutputTruncation): number | undefined => {
    const candidate = value[key]
    return Number.isInteger(candidate) && Number(candidate) >= 0 ? Number(candidate) : undefined
  }
  const truncation: TerminalOutputTruncation = {
    ...(field('capturedLines') !== undefined ? { capturedLines: field('capturedLines') } : {}),
    ...(field('omittedLines') !== undefined ? { omittedLines: field('omittedLines') } : {}),
    ...(field('capturedBytes') !== undefined ? { capturedBytes: field('capturedBytes') } : {}),
    ...(field('omittedBytes') !== undefined ? { omittedBytes: field('omittedBytes') } : {}),
  }
  return Object.keys(truncation).length > 0 ? truncation : undefined
}

function mergeCanonicalOutputTruncation(
  upstream: TerminalOutputTruncation | undefined,
  bounded: CanonicalTextEntries<{ readonly text: string }>,
): TerminalOutputTruncation | undefined {
  if (!bounded.truncated) return upstream
  return {
    capturedLines: bounded.entries.length,
    omittedLines: (upstream?.omittedLines ?? 0) + bounded.omittedLines,
    capturedBytes: bounded.capturedBytes,
    omittedBytes: (upstream?.omittedBytes ?? 0) + bounded.omittedBytes,
  }
}

interface CanonicalTextEntries<Entry extends { readonly text: string }> {
  readonly entries: readonly Entry[]
  readonly capturedBytes: number
  readonly omittedLines: number
  readonly omittedBytes: number
  readonly truncated: boolean
}

function boundCanonicalTextEntries<Entry extends { readonly text: string }>(
  entries: readonly Entry[],
): CanonicalTextEntries<Entry> {
  const countOmitted = Math.max(0, entries.length - MAX_CANONICAL_OUTPUT_ENTRIES)
  const candidates = entries.slice(-MAX_CANONICAL_OUTPUT_ENTRIES)
  let omittedLines = countOmitted
  let omittedBytes = textEntriesByteLength(entries.slice(0, countOmitted))
  let remainingBytes = MAX_CANONICAL_OUTPUT_BYTES
  const retainedReverse: Entry[] = []

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index]!
    const boundedText = utf8Tail(entry.text, remainingBytes)
    omittedBytes += boundedText.omittedBytes
    if (boundedText.text.length > 0 || entry.text.length === 0 && remainingBytes > 0) {
      retainedReverse.push(boundedText.text === entry.text ? entry : { ...entry, text: boundedText.text })
      remainingBytes -= boundedText.retainedBytes
    } else {
      omittedLines += 1
    }
  }

  const retained = retainedReverse.reverse()
  const capturedBytes = MAX_CANONICAL_OUTPUT_BYTES - remainingBytes
  return {
    entries: retained,
    capturedBytes,
    omittedLines,
    omittedBytes,
    truncated: omittedLines > 0 || omittedBytes > 0,
  }
}

function textEntriesByteLength(entries: readonly { readonly text: string }[]): number {
  return entries.reduce((total, entry) => total + UTF8_ENCODER.encode(entry.text).byteLength, 0)
}

function utf8Tail(value: string, maxBytes: number): { text: string; retainedBytes: number; omittedBytes: number } {
  const encoded = UTF8_ENCODER.encode(value)
  if (encoded.byteLength <= maxBytes) {
    return { text: value, retainedBytes: encoded.byteLength, omittedBytes: 0 }
  }
  let start = Math.max(0, encoded.byteLength - maxBytes)
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1
  const text = UTF8_DECODER.decode(encoded.subarray(start))
  const retainedBytes = encoded.byteLength - start
  return { text, retainedBytes, omittedBytes: encoded.byteLength - retainedBytes }
}

function normalizeTerminalError(value: unknown): TerminalContentPart['error'] | undefined {
  if (!isRecord(value) || typeof value.message !== 'string' || !value.message.trim()) return undefined
  return {
    message: value.message.trim(),
    ...(typeof value.code === 'string' && value.code.trim() ? { code: value.code.trim() } : {}),
  }
}

function terminalDroppedFields(raw: Record<string, unknown>): readonly string[] {
  const known = new Set([
    'type', 'kind', 'command', 'processId', 'process_id', 'sessionId', 'session_id', 'streams',
    'exitCode', 'terminatedBy', 'status', 'durationMs', 'env', 'truncation', 'error',
  ])
  const dropped = Object.keys(raw).filter(key => !known.has(key))
  const nonEmptyString = (key: string): void => {
    const value = raw[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) dropped.push(key)
  }
  nonEmptyString('command')
  nonEmptyString('processId')
  nonEmptyString('process_id')
  nonEmptyString('sessionId')
  nonEmptyString('session_id')
  if (raw.streams !== undefined && !Array.isArray(raw.streams)) dropped.push('streams')
  if (raw.exitCode !== undefined && !Number.isInteger(raw.exitCode)) dropped.push('exitCode')
  if (raw.terminatedBy !== undefined && !['timeout', 'killed', 'signal'].includes(String(raw.terminatedBy))) dropped.push('terminatedBy')
  if (raw.status !== undefined && !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(raw.status))) dropped.push('status')
  if (raw.durationMs !== undefined && (typeof raw.durationMs !== 'number' || !Number.isFinite(raw.durationMs) || raw.durationMs < 0)) dropped.push('durationMs')
  if (raw.env !== undefined && !isRecord(raw.env)) dropped.push('env')
  collectTerminalTruncationDroppedFields(raw.truncation, dropped)
  collectTerminalErrorDroppedFields(raw.error, dropped)
  return [...new Set(dropped)]
}

function logDroppedFields(raw: Record<string, unknown>): readonly string[] {
  const known = new Set([
    'type', 'kind', 'source', 'processId', 'process_id', 'sessionId', 'session_id', 'entries', 'truncation',
  ])
  const dropped = Object.keys(raw).filter(key => !known.has(key))
  for (const key of ['source', 'processId', 'process_id', 'sessionId', 'session_id']) {
    const value = raw[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) dropped.push(key)
  }
  if (raw.entries !== undefined && !Array.isArray(raw.entries)) dropped.push('entries')
  collectTerminalTruncationDroppedFields(raw.truncation, dropped)
  return [...new Set(dropped)]
}

function collectTerminalTruncationDroppedFields(value: unknown, dropped: string[]): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    dropped.push('truncation')
    return
  }
  const fields = ['capturedLines', 'omittedLines', 'capturedBytes', 'omittedBytes'] as const
  if (!fields.some(key => value[key] !== undefined)) dropped.push('truncation')
  for (const key of fields) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 0)) {
      dropped.push(`truncation.${key}`)
    }
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key as typeof fields[number])) dropped.push(`truncation.${key}`)
  }
}

function collectTerminalErrorDroppedFields(value: unknown, dropped: string[]): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    dropped.push('error')
    return
  }
  if (typeof value.message !== 'string' || !value.message.trim()) dropped.push('error.message')
  if (value.code !== undefined && (typeof value.code !== 'string' || !value.code.trim())) dropped.push('error.code')
  for (const key of Object.keys(value)) {
    if (key !== 'message' && key !== 'code') dropped.push(`error.${key}`)
  }
}

function normalizeMediaContentBlock(
  raw: Record<string, unknown>,
  kind: MediaContentKind,
): { part: ContentPart; diagnostic?: { code: string; message: string; path: readonly (string | number)[] } } {
  if (hasForbiddenMediaSideChannel(raw)) {
    return {
      part: createUnknownContentPart(kind, raw),
      diagnostic: { code: `content.${kind}.invalid`, message: `${kind} block contains a forbidden media side channel`, path: [] },
    }
  }
  const sourceRecord = isRecord(raw.source) ? raw.source : undefined
  const source = typeof raw.source === 'string'
    ? raw.source
    : typeof sourceRecord?.data === 'string'
      ? sourceRecord.data
      : typeof sourceRecord?.url === 'string'
        ? sourceRecord.url
        : undefined
  const explicitSourceKind = isMediaSourceKind(raw.sourceKind) ? raw.sourceKind : undefined
  const nestedSourceKind = canonicalMediaSourceKind(sourceRecord?.type)
  const sourceKind = explicitSourceKind ?? nestedSourceKind
  const mimeType = typeof sourceRecord?.media_type === 'string'
    ? sourceRecord.media_type
    : typeof sourceRecord?.mimeType === 'string'
      ? sourceRecord.mimeType
      : typeof raw.mimeType === 'string'
        ? raw.mimeType
        : undefined
  const part = {
    kind,
    ...(source !== undefined ? { source } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(typeof raw.alt === 'string' ? { alt: raw.alt } : {}),
    ...(typeof raw.caption === 'string' ? { caption: raw.caption } : {}),
    ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
    ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
    ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
    ...(typeof raw.poster === 'string' ? { poster: raw.poster } : {}),
    ...(typeof raw.transcript === 'string' ? { transcript: raw.transcript } : {}),
  }
  return isValidMediaContentInput(part, kind)
    ? { part: part as ContentPart }
    : {
        part: createUnknownContentPart(kind, raw),
        diagnostic: { code: `content.${kind}.invalid`, message: `${kind} block has no safe canonical source`, path: ['source'] },
      }
}

function canonicalMediaSourceKind(value: unknown): MediaSourceKind | undefined {
  switch (value) {
    case 'url': return 'url'
    case 'path':
    case 'local-path': return 'path'
    case 'base64': return 'base64'
    case 'blob': return 'blob'
    default: return undefined
  }
}

export function createUnknownEvent(
  input: unknown,
  update: Record<string, unknown> | undefined,
  originalType = wireKind(update),
): WorkbenchSemanticEvent {
  const unknown = createUnknownContentPart(originalType, input)
  return {
    type: 'event.unknown',
    originalType,
    summary: unknown.summary,
    raw: unknown.raw,
    truncated: unknown.truncated,
    ...(unknown.truncation ? { truncation: unknown.truncation } : {}),
  }
}

export function makeEnvelope(
  event: WorkbenchSemanticEvent,
  input: unknown,
  context: NormalizeContext,
  update: Record<string, unknown> | undefined,
  provenancePatch: Partial<WorkbenchEventProvenance> = {},
  identity = identityFromUpdate(update),
): WorkbenchEventEnvelope {
  const source = isRecord(input) && typeof input.source === 'string' ? input.source : context.sourceId
  return createWorkbenchEnvelope({
    sessionId: context.sessionId,
    sequence: context.sequence,
    recordedAt: context.recordedAt,
    ...(context.occurredAt ? { occurredAt: context.occurredAt } : {}),
    source: {
      provider: context.provider,
      sourceId: source,
      ...(context.agentId ? { agentId: context.agentId } : {}),
      ...(context.parentAgentId ? { parentAgentId: context.parentAgentId } : {}),
    },
    identity,
    provenance: { ...context.provenance, ...provenancePatch },
    event,
    raw: input,
  })
}

export function makeSyntheticEnvelope(
  event: WorkbenchSemanticEvent,
  input: unknown,
  context: NormalizeContext,
  update: Record<string, unknown> | undefined,
  reason: string,
): WorkbenchEventEnvelope {
  const normalizedReason = reason.trim()
  if (!normalizedReason) throw new Error('Synthetic event reason must be non-empty')
  const rawInput = isRecord(input)
    ? { ...input, _pylonSynthetic: { reason: normalizedReason } }
    : { observed: toJsonValue(input), _pylonSynthetic: { reason: normalizedReason } }
  return makeEnvelope(event, rawInput, context, update, {
    orderConfidence: 'observed',
    synthetic: { reason: normalizedReason },
  })
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJsonValue(child)]))
  return String(value)
}

const SECRET_ENV_KEY = /(?:token|secret|password|api[-_]?key|credential|authorization|cookie)/i

/** C07：secret-like 环境变量值脱敏（保留键名与占位，不显示 raw）。 */
function redactSecretEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = typeof value === 'string'
      ? (SECRET_ENV_KEY.test(key) ? '[REDACTED]' : value)
      : String(value)
  }
  return out
}

function toJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return toJsonValue(value) as Record<string, JsonValue>
}
