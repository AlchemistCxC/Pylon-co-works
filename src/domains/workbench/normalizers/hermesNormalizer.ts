import type { AgentEventNormalizer, AgentWireEnvelope, NormalizeContext, NormalizeResult } from './agentEventNormalizer.ts'
import { normalizeAcpEvent } from './acpNormalizer.ts'
import { extractUpdate, isRecord, makeEnvelope } from './normalizerSupport.ts'
import { resolveToolSemantic } from '../../tool/toolRegistry.ts'
import { splitToolTitle } from '../../tool/toolResolution.ts'

export const hermesNormalizer: AgentEventNormalizer = {
  id: 'hermes',
  canNormalize: (_input, context) => context.provider.toLowerCase() === 'hermes',
  normalize: normalizeHermesEvent,
}

export function normalizeHermesEvent(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  const update = extractUpdate(input)
  // Hermes' progress callback historically serializes commands into `title`
  // (for example `terminal: git status`) and uses `args`/`arguments`/`preview`
  // instead of ACP's `input`.  Canonicalize that vendor shape at the adapter
  // seam so renderers receive a stable machine name + structured input.  The
  // original wire payload remains in the envelope raw field for forensics.
  const canonicalInput = canonicalizeHermesTool(input, update)
  const canonicalUpdate = extractUpdate(canonicalInput)
  const enrichedInput = enrichHermesToolContent(canonicalInput, canonicalUpdate)
  const result = normalizeAcpEvent(enrichedInput, context)
  // Adapter rewrites are renderer-facing only; keep the exact provider wire
  // payload as the envelope raw evidence (including the original title).
  const preservedResult = canonicalInput === input && enrichedInput === canonicalInput ? result : {
    events: result.events.map(event => makeEnvelope(
      event.event,
      input,
      context,
      update,
      event.provenance,
      event.identity,
    )),
    diagnostics: result.diagnostics,
  }
  const grouped = context.groupedReplay ?? context.replay ?? isGroupedReplay(update)
  if (!grouped) return preservedResult
  return {
    events: preservedResult.events.map(event => ({
      ...event,
      provenance: {
        ...event.provenance,
        orderConfidence: 'grouped' as const,
        collectionComplete: event.provenance.collectionComplete ?? true,
      },
    })),
    diagnostics: preservedResult.diagnostics,
  }
}

function canonicalizeHermesTool(input: AgentWireEnvelope | unknown, update: Record<string, unknown> | undefined): AgentWireEnvelope | unknown {
  if (!update || !['tool_call', 'tool_call_update'].includes(hermesUpdateKind(update)) || !isRecord(input)) return input

  const meta = firstRecord(update._meta, update.meta)
  const pylonCandidate = meta?.pylon
  const pylon = isRecord(pylonCandidate) ? pylonCandidate : undefined
  const explicitName = firstString(
    pylon?.toolName,
    pylon?.tool_name,
    wireField(update, ['name', 'toolName', 'tool_name', 'tool']),
  )
  const title = firstString(wireField(update, ['title', 'label']))
  const parsedTitle = title ? splitToolTitle(title) : { name: '', summary: '' }
  // Hermes ACP's ToolCallStart intentionally exposes only a human title
  // (the Python adapter has no machine-name field).  Recover the canonical
  // name before handing the event to the generic ACP normalizer; otherwise
  // every title-only call becomes `unknown` even though its wire kind is valid.
  const parsedName = parsedTitle.name ? canonicalHermesToolName(parsedTitle.name) : undefined
  const parsedEntry = parsedName ? resolveToolSemantic('hermes', parsedName) : null
  // Explicit machine metadata wins.  For Hermes' title-only ACP wire, use the
  // canonical alias when known; otherwise retain a conservative normalized token
  // (letters/digits/underscore) so a valid tool remains a generic *tool* card
  // instead of disappearing into event.unknown.
  const explicitCanonical = explicitName ? canonicalHermesToolName(explicitName) : undefined
  const name = explicitCanonical || explicitName || parsedName || (parsedEntry ? parsedName : undefined)
  if (!name) return input

  const nameEntry = resolveToolSemantic('hermes', name)
  const titlePrefixMatches = parsedTitle.summary.length > 0
    && (parsedName ?? parsedTitle.name).trim().toLowerCase() === name.trim().toLowerCase()
  const embeddedSummary = titlePrefixMatches ? parsedTitle.summary : ''
  const wireInput = wireField(update, ['input', 'rawInput', 'raw_input', 'args', 'arguments', 'parameters', 'preview'])
  const inputValue = wireInput !== undefined && wireInput !== null
    ? normalizeHermesInput(name, wireInput)
    : (embeddedSummary ? inputForEmbeddedSummary(name, embeddedSummary) : undefined)
  const canonicalTitle = Boolean(title && title.trim().toLowerCase() === name.trim().toLowerCase())
  const displayTitle = embeddedSummary || canonicalTitle
    ? nameEntry?.displayName ?? parsedTitle.name
    : title

  const nextUpdate: Record<string, unknown> = {
    ...update,
    name,
    ...(displayTitle ? { title: displayTitle } : {}),
    ...(inputValue !== undefined && (update.input === undefined || typeof update.input === 'string')
      ? { input: inputValue } : {}),
    _meta: {
      ...meta,
      pylon: { ...(pylon ?? {}), toolName: name },
    },
  }
  if (isRecord(input.params) && isRecord(input.params.update)) {
    return { ...input, params: { ...input.params, update: nextUpdate } }
  }
  if (isRecord(input.update)) return { ...input, update: nextUpdate }
  return nextUpdate
}

/**
 * Hermes currently serializes most polished results as a single Markdown text
 * block.  When the underlying result is still structured (or can be recovered
 * without guessing), expose a provider-neutral content part so Solid renderers can
 * use the search/skill/terminal/memory cards.  The original wire remains in the
 * envelope raw field; this function only changes the renderer-facing copy.
 */
function enrichHermesToolContent(input: AgentWireEnvelope | unknown, update: Record<string, unknown> | undefined): AgentWireEnvelope | unknown {
  if (!update || !isRecord(input)) return input
  const updateKind = hermesUpdateKind(update)
  if (updateKind !== 'tool_call_update') return input
  const meta = firstRecord(update._meta, update.meta)
  const name = firstString(
    isRecord(meta?.pylon) ? firstString(meta.pylon.toolName, meta.pylon.tool_name) : undefined,
    wireField(update, ['name', 'toolName', 'tool_name']),
  )
  if (!name) return input
  const canonicalName = canonicalHermesToolName(name) ?? name.trim().toLowerCase()
  const resultValue = wireField(update, ['rawOutput', 'raw_output', 'output', 'result', 'toolResult', 'tool_result'])
  const existingText = textFromContent(wireField(update, ['content', 'parts', 'blocks']))
  const block = structuredHermesResult(canonicalName, resultValue, update, existingText)
  if (!block) return input
  const nextUpdate = { ...update, content: [block] }
  if (isRecord(input.params) && isRecord(input.params.update)) return { ...input, params: { ...input.params, update: nextUpdate } }
  if (isRecord(input.update)) return { ...input, update: nextUpdate }
  return nextUpdate
}

function structuredHermesResult(
  name: string,
  resultValue: unknown,
  update: Record<string, unknown>,
  existingText: string,
): Record<string, unknown> | undefined {
  const parsed = parseJsonish(resultValue)
  const parsedRecord = isRecord(parsed) ? parsed : undefined
  // A few Hermes integrations wrap their tool payload under `data`/`result`.
  // Keep the outer object available for status/error fields, but read semantic
  // fields from the nested object when present.
  const nested = parsedRecord && isRecord(parsedRecord.data) ? parsedRecord.data : undefined
  const data = nested ? { ...parsedRecord, ...nested } : parsedRecord
  const inputValue = wireField(update, ['input', 'rawInput', 'raw_input', 'args', 'arguments', 'parameters'])
  const input = firstRecord(inputValue) ?? (typeof inputValue === 'string' ? { value: inputValue } : undefined)
  if (name === 'skill_view' || name === 'skill_manage' || name === 'skills_list') {
    const skillName = firstString(
      data?.name,
      data?.skill,
      data?.skill_name,
      input?.name,
      input?.skill,
      input?.skill_name,
      name === 'skills_list' ? data?.category : undefined,
    ) ?? name
    const file = firstString(data?.file, data?.path, data?.file_path, input?.file_path, input?.path) ?? 'SKILL.md'
    const summary = firstString(data?.description, data?.summary, data?.message, existingText)
    return {
      type: 'skill', id: `${skillName}:${file}`, title: skillName, source: 'hermes',
      ...(summary ? { summary: compactSummary(summary) } : {}),
      ...(firstString(data?.status, data?.state) ? { status: firstString(data?.status, data?.state) } : {}),
      ...(typeof data?.version === 'string' || typeof data?.version === 'number' ? { version: data.version } : {}),
      ...(typeof data?.enabled === 'boolean' ? { enabled: data.enabled } : {}),
      ...(typeof data?.used === 'boolean' ? { used: data.used } : {}),
      uri: file,
    }
  }
  if (name === 'search_files' || name === 'session_search' || name === 'web_search' || name === 'web_extract') {
    const rawResults = Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.matches)
        ? data.matches
        : Array.isArray(data?.files)
          ? data.files
          : Array.isArray(data?.web)
            ? data.web
            : Array.isArray(data?.items)
              ? data.items
              : Array.isArray(data?.hits) ? data.hits : undefined
    const results: Array<Record<string, unknown>> = rawResults?.map((entry, index): Record<string, unknown> | null => {
      if (typeof entry === 'string') return { source: entry, rank: index + 1 }
      if (!isRecord(entry)) return null
      const source = firstString(entry.source, entry.path, entry.file, entry.filename, entry.url, entry.href, entry.session_id, entry.sessionId, entry.session_id, entry.title)
      return source ? {
        source, rank: index + 1,
        ...(firstString(entry.title) ? { title: firstString(entry.title) } : {}),
        ...(firstString(entry.snippet, entry.content, entry.text, entry.description, entry.summary) ? { snippet: compactSummary(firstString(entry.snippet, entry.content, entry.text, entry.description, entry.summary)!) } : {}),
        ...(Number.isInteger(entry.line) || Number.isInteger(entry.line_number) || Number.isInteger(entry.lineNumber)
          ? { location: { path: source, line: Number(entry.line ?? entry.line_number ?? entry.lineNumber) } } : {}),
        ...(typeof entry.score === 'number' && Number.isFinite(entry.score) ? { score: entry.score } : {}),
      } : null
    }).filter((entry): entry is Record<string, unknown> => entry !== null) ?? []
    if (results.length > 0) {
      const totalCandidate = data?.total_count ?? data?.totalCount ?? data?.total ?? data?.count
      const parsedTotal = integerValue(totalCandidate)
      const total = parsedTotal !== undefined && parsedTotal >= 0 ? parsedTotal : results.length
      return {
        type: 'search_result',
        query: firstString(data?.query, data?.pattern, input?.query, input?.pattern),
        total,
        ...(typeof data?.paging_token === 'string' ? { pagingToken: data.paging_token } : typeof data?.pagingToken === 'string' ? { pagingToken: data.pagingToken } : {}),
        results,
      }
    }
    // The polished formatter is still useful when no JSON survived; recover only
    // explicit bullet lines, never arbitrary prose.
    const textResults = parseBulletResults(existingText)
    if (textResults.length > 0) return { type: 'search_result', query: firstString(input?.query, input?.pattern), total: textResults.length, results: textResults }
  }
  if (name === 'terminal' || name === 'process' || name === 'execute_code') {
    const command = firstString(input?.command, input?.code, input?.value, data?.command, data?.code, data?.cmd)
    const output = firstString(data?.stdout, data?.output, data?.new_output, data?.result, data?.log, existingText)
    const error = firstString(data?.stderr, data?.error, data?.error_message)
    const status = firstString(update.status, update.state, data?.status, data?.state)
    const exitCode = integerValue(data?.exit_code, data?.exitCode, data?.returncode, data?.return_code, data?.exit_status)
    const durationMs = finiteNumber(data?.duration_ms, data?.durationMs, data?.elapsed_ms, data?.elapsedMs)
    const processId = firstString(data?.process_id, data?.processId, input?.process_id, input?.processId)
    const sessionId = firstString(data?.session_id, data?.sessionId, input?.session_id, input?.sessionId)
    const truncation = terminalTruncation(data)
    if (command || output || error) {
      return {
        type: 'terminal', ...(command ? { command } : {}),
        streams: [
          ...(output ? [{ stream: 'stdout', text: output }] : []),
          ...(error ? [{ stream: 'stderr', text: error }] : []),
        ],
        ...(processId ? { processId } : {}),
        ...(sessionId ? { sessionId } : {}),
        status: status === 'cancelled' ? 'cancelled' : status === 'failed' || status === 'error' || error || exitCode !== undefined && exitCode !== 0 ? 'failed' : 'completed',
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(truncation ? { truncation } : {}),
        ...(error ? { error: { message: error } } : {}),
      }
    }
  }
  if (name === 'memory') {
    const target = firstString(data?.target, data?.key, input?.target, input?.key, data?.id) ?? 'memory'
    const summary = firstString(data?.message, data?.summary, data?.content, existingText)
    return { type: 'memory', id: target, title: target, source: 'hermes', ...(summary ? { summary: compactSummary(summary) } : {}), ...(firstString(data?.status, data?.state) ? { status: firstString(data?.status, data?.state) } : {}) }
  }
  if (name === 'vision_analyze' || name === 'image_generate' || name === 'text_to_speech') {
    const source = firstString(data?.url, data?.image_url, data?.audio_url, data?.file_path, data?.path, data?.source)
    if (source) return { type: name === 'text_to_speech' ? 'audio' : 'image', source, sourceKind: /^https?:/i.test(source) ? 'url' : 'path', alt: firstString(data?.description, data?.message, existingText), ...(firstString(data?.mime_type, data?.mimeType) ? { mimeType: firstString(data?.mime_type, data?.mimeType) } : {}) }
  }
  return undefined
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord)
}

/**
 * Hermes has emitted all of `sessionUpdate`, `session_update`, and the SDK's
 * `updateType` spelling over its lifetime.  Keep this discriminator local to
 * the Hermes adapter so `kind` (which is the ACP ToolKind on tool calls) is
 * never mistaken for a session update.
 */
function hermesUpdateKind(update: Record<string, unknown>): string {
  const raw = wireField(update, ['sessionUpdate', 'session_update', 'updateType', 'update_type', 'eventType', 'event_type', 'type'])
  if (typeof raw !== 'string') return ''
  const normalized = raw.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[./:\\-\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  const aliases: Record<string, string> = {
    tool_call_start: 'tool_call',
    tool_call_started: 'tool_call',
    tool_call_progress: 'tool_call_update',
    tool_call_completed: 'tool_call_update',
    tool_call_result: 'tool_call_update',
    assistant_message_chunk: 'agent_message_chunk',
    message_chunk: 'agent_message_chunk',
    thinking_chunk: 'agent_thought_chunk',
    reasoning_chunk: 'agent_thought_chunk',
  }
  return aliases[normalized] ?? normalized
}

function normalizedWireKey(key: string): string {
  return key.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[./:\\-\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

/**
 * Read camelCase/snake_case aliases without letting provider null placeholders
 * shadow a later, populated alias.  Hermes' serializer commonly emits
 * `rawInput: null`/`rawOutput: null` alongside `args`/`result`; an explicit
 * null is only returned when every matching alias is null.
 */
function wireField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  const wanted = new Set(keys.map(normalizedWireKey))
  let explicitNull = false
  // The order of `keys` is authoritative when a payload contains both forms.
  for (const key of keys) {
    const canonical = normalizedWireKey(key)
    const actual = Object.keys(record).find(candidate => normalizedWireKey(candidate) === canonical)
    if (actual === undefined) continue
    const value = record[actual]
    if (value !== undefined && value !== null) return value
    if (value === null) explicitNull = true
  }
  // A final pass handles unusual Unicode/case variants without requiring the
  // caller to enumerate every spelling.
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.has(normalizedWireKey(key))) continue
    if (value !== undefined && value !== null) return value
    if (value === null) explicitNull = true
  }
  return explicitNull ? null : undefined
}

function integerValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== '' && /^[-+]?\d+$/.test(value.trim())
        ? Number(value.trim())
        : undefined
    if (number !== undefined && Number.isSafeInteger(number)) return number
  }
  return undefined
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))
        ? Number(value.trim())
        : undefined
    if (number !== undefined && Number.isFinite(number) && number >= 0) return number
  }
  return undefined
}

/** Convert Hermes' several stdout truncation reports into the C07 contract. */
function terminalTruncation(data: Record<string, unknown> | undefined): Record<string, number> | undefined {
  if (!data) return undefined
  const nested = firstRecord(
    wireField(data, ['truncation', 'outputTruncation', 'output_truncation']),
  )
  const source = nested ? { ...data, ...nested } : data
  const capturedLines = integerValue(source.capturedLines, source.captured_lines, source.shownLines, source.shown_lines)
  const omittedLines = integerValue(source.omittedLines, source.omitted_lines, source.droppedLines, source.dropped_lines)
  const capturedBytes = integerValue(
    source.capturedBytes, source.captured_bytes,
    source.stdoutBytesCaptured, source.stdout_bytes_captured,
    source.bytesCaptured, source.bytes_captured,
  )
  const omittedBytes = integerValue(
    source.omittedBytes, source.omitted_bytes,
    source.stdoutBytesOmitted, source.stdout_bytes_omitted,
    source.bytesOmitted, source.bytes_omitted,
  )
  const totalBytes = integerValue(source.totalBytes, source.total_bytes, source.stdoutBytesTotal, source.stdout_bytes_total)
  const totalLines = integerValue(source.totalLines, source.total_lines)
  const truncated = source.truncated === true || source.stdoutTruncated === true || source.stdout_truncated === true
  const result: Record<string, number> = {}
  if (capturedLines !== undefined && capturedLines >= 0) result.capturedLines = capturedLines
  if (omittedLines !== undefined && omittedLines >= 0) result.omittedLines = omittedLines
  if (capturedBytes !== undefined && capturedBytes >= 0) result.capturedBytes = capturedBytes
  if (omittedBytes !== undefined && omittedBytes >= 0) result.omittedBytes = omittedBytes
  if (result.capturedBytes === undefined && totalBytes !== undefined && result.omittedBytes !== undefined) {
    const captured = totalBytes - result.omittedBytes
    if (captured >= 0) result.capturedBytes = captured
  }
  if (result.omittedBytes === undefined && totalBytes !== undefined && result.capturedBytes !== undefined) {
    const omitted = totalBytes - result.capturedBytes
    if (omitted >= 0) result.omittedBytes = omitted
  }
  if (result.capturedLines === undefined && totalLines !== undefined && result.omittedLines !== undefined) {
    const captured = totalLines - result.omittedLines
    if (captured >= 0) result.capturedLines = captured
  }
  if (result.omittedLines === undefined && totalLines !== undefined && result.capturedLines !== undefined) {
    const omitted = totalLines - result.capturedLines
    if (omitted >= 0) result.omittedLines = omitted
  }
  return Object.keys(result).length > 0 && (truncated || Object.values(result).some(value => value > 0)) ? result : undefined
}

function parseJsonish(value: unknown): unknown {
  if (isRecord(value) || Array.isArray(value)) return value
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  try { return JSON.parse(text) } catch { /* formatter may append a hint */ }

  // Python's Hermes adapter uses JSONDecoder.raw_decode(), which accepts a
  // valid JSON prefix followed by a human hint.  Mirror that behaviour rather
  // than trying to parse the hint as JSON.  The scanner is quote/escape aware,
  // so braces inside markdown strings do not terminate the value early.
  const maxScan = Math.min(text.length, 4 * 1024 * 1024)
  for (let start = 0; start < maxScan; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue
    const end = jsonValueEnd(text, start, maxScan)
    if (end === undefined) continue
    try { return JSON.parse(text.slice(start, end)) } catch { /* try the next candidate */ }
  }
  return undefined
}

function jsonValueEnd(text: string, start: number, limit: number): number | undefined {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let index = start; index < limit; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{' || char === '[') { stack.push(char); continue }
    if (char !== '}' && char !== ']') continue
    const opening = stack.pop()
    if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) return undefined
    if (stack.length === 0) return index + 1
  }
  return undefined
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join('\n').trim()
  if (!isRecord(value)) return ''
  const type = typeof value.type === 'string' ? normalizedWireKey(value.type) : typeof value.kind === 'string' ? normalizedWireKey(value.kind) : ''
  if (['content', 'tool_content', 'tool_content_part'].includes(type)) return textFromContent(value.content)
  if (['text', 'markdown', 'code', 'ansi', 'reasoning', 'thinking'].includes(type)) {
    return firstString(value.text, value.value, value.content) ?? ''
  }
  if (type === 'resource' || type === 'resource_link') return firstString(value.text, value.description, value.title) ?? ''
  const nested = value.content ?? value.parts ?? value.blocks ?? value.output ?? value.message
  if (nested !== undefined) return textFromContent(nested)
  return firstString(value.text, value.value) ?? ''
}

function parseBulletResults(text: string): Record<string, unknown>[] {
  return text.split(/\r?\n/).map(line => line.match(/^\s*[-•]\s+(.+?)\s*$/)?.[1]?.trim()).filter((value): value is string => Boolean(value)).slice(0, 100).map((source, index) => ({ source, rank: index + 1 }))
}

function compactSummary(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 2000)
}

function inputForEmbeddedSummary(name: string, summary: string): Record<string, string> | undefined {
  const normalized = name.trim().toLowerCase()
  if (normalized === 'terminal' || normalized === 'process') return { command: summary }
  if (normalized === 'execute_code') return { code: summary }
  if (normalized === 'search_files') return { pattern: summary }
  if (normalized === 'session_search') return { query: summary }
  if (normalized === 'web_search') return { query: summary }
  if (normalized === 'read_file') return { path: summary }
  if (normalized === 'write_file' || normalized === 'patch') return { path: summary }
  if (normalized === 'skill_view' || normalized === 'skill_manage') {
    const separator = summary.indexOf('/')
    return separator > 0
      ? { name: summary.slice(0, separator).trim(), file_path: summary.slice(separator + 1).trim() || 'SKILL.md' }
      : { name: summary }
  }
  return undefined
}

function normalizeHermesInput(name: string, value: unknown): unknown {
  if (typeof value !== 'string') return value
  const normalized = name.trim().toLowerCase()
  if (normalized === 'terminal' || normalized === 'process') return { command: value }
  if (normalized === 'execute_code') return { code: value }
  return value
}

function firstString(...values: unknown[]): string | undefined {
  const value = values.find(item => typeof item === 'string' && item.trim().length > 0)
  return typeof value === 'string' ? value.trim() : undefined
}

/** Map the labels emitted by Hermes' ACP title formatter back to machine names. */
function canonicalHermesToolName(value: string): string | undefined {
  const raw = value.trim()
  if (!raw) return undefined
  // Titles from different Hermes frontends use spaces, dots, slashes, and
  // camelCase interchangeably (`skill view`, `skillView`, `skill.view`).
  // Normalize those separators before consulting the provider dictionary.
  const normalized = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/::/g, '__')
    .replace(/[./:\\-\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  const aliases: Record<string, string> = {
    'skill_view': 'skill_view', skill: 'skill_view',
    'skills_list': 'skills_list', skills: 'skills_list',
    search: 'search_files', 'search_files': 'search_files', 'file_search': 'search_files',
    'session_search': 'session_search',
    'web_search': 'web_search',
    read: 'read_file', 'read_file': 'read_file',
    write: 'write_file', 'write_file': 'write_file',
    edit: 'patch', patch: 'patch',
    terminal: 'terminal', shell: 'terminal', bash: 'terminal',
    process: 'process',
    execute_code: 'execute_code', python: 'execute_code',
    todo: 'todo', 'todo_list': 'todo',
    'skill_manage': 'skill_manage',
    'web_extract': 'web_extract', extract: 'web_extract',
    memory: 'memory',
    delegate: 'delegate_task', 'delegate_task': 'delegate_task',
    delegation: 'delegate_task', 'delegate_task_batch': 'delegate_task',
    'browser_navigate': 'browser_navigate', 'browser_click': 'browser_click',
    'browser_type': 'browser_type', 'browser_snapshot': 'browser_snapshot',
    'browser_vision': 'browser_vision', 'browser_scroll': 'browser_scroll',
    'browser_press': 'browser_press', 'browser_back': 'browser_back',
    'browser_get_images': 'browser_get_images', 'browser_console': 'browser_console',
    'image_generate': 'image_generate', 'text_to_speech': 'text_to_speech',
    'vision_analyze': 'vision_analyze', 'cronjob': 'cronjob',
    'send_message': 'send_message', 'clarify': 'clarify',
    '_thinking': '_thinking', 'thinking': '_thinking',
  }
  if (aliases[normalized]) return aliases[normalized]
  // Qualified provider names (`hermes.tools.search_files`) should resolve by
  // their final *wire token*, not merely the final underscore-delimited word
  // (`files`). Preserve the provider separators long enough to try
  // `search_files`, `tools_search_files`, … in suffix order. Only do this for
  // an explicit namespace separator; otherwise prose such as “please use
  // skill” must not be silently promoted to `skill_view`.
  if (/[./:\\]/.test(raw)) {
    const qualifiedTokens = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .split(/[./:\\]+/)
      .map(token => token.trim().replace(/[\s-]+/g, '_').toLowerCase())
      .filter(Boolean)
    for (let start = qualifiedTokens.length - 1; start >= 0; start -= 1) {
      const candidate = qualifiedTokens.slice(start).join('_')
      if (aliases[candidate]) return aliases[candidate]
    }
  }
  if (/^mcp__[^_]+__[^_]+/.test(normalized)) return normalized
  // Hermes integrations/kanban/Yuanbao expose stable snake_case names even when
  // they are not in the built-in catalog.  Retain that machine identity for the
  // generic renderer rather than collapsing the whole update to event.unknown.
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(normalized)
    && (normalized.startsWith('browser_') || normalized.startsWith('kanban_') || normalized.startsWith('yb_')
      || normalized.startsWith('discord') || normalized.startsWith('feishu') || normalized.startsWith('ha_')
      || normalized.startsWith('integration_'))) return normalized
  // Do not turn an arbitrary localized/prose title into a machine identity.
  // Hermes' real title-only wire has a small, evidence-backed alias set above;
  // when no alias or qualified integration name matches, keep the identity
  // unknown and let the diagnostic surface explain the missing machine field.
  return undefined
}

function isGroupedReplay(update: Record<string, unknown> | undefined): boolean {
  const meta = update?._meta
  return typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>).hermesReplay === true
}
