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
  if (!update || !['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate ?? update.session_update)) || !isRecord(input)) return input

  const meta = isRecord(update._meta) ? update._meta : undefined
  const pylonCandidate = meta?.pylon
  const pylon = isRecord(pylonCandidate) ? pylonCandidate : undefined
  const explicitName = firstString(pylon?.toolName, pylon?.tool_name, update.name, update.toolName, update.tool_name, update.tool)
  const title = firstString(update.title)
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
  const wireInput = update.input ?? update.rawInput ?? update.raw_input ?? update.args ?? update.arguments ?? update.parameters ?? update.preview
  const inputValue = wireInput !== undefined
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
    ...(inputValue !== undefined && update.input === undefined && update.rawInput === undefined && update.raw_input === undefined
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
  const updateKind = String(update.sessionUpdate ?? update.session_update ?? '')
  if (updateKind !== 'tool_call_update') return input
  const name = firstString(
    isRecord(update._meta) && isRecord(update._meta.pylon) ? update._meta.pylon.toolName : undefined,
    update.name,
    update.toolName,
  )
  if (!name) return input
  const canonicalName = canonicalHermesToolName(name) ?? name.trim().toLowerCase()
  const resultValue = update.rawOutput ?? update.raw_output ?? update.output ?? update.result
  const existingText = textFromContent(update.content)
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
  const data = isRecord(parsed) ? parsed : undefined
  const input = firstRecord(update.input, update.rawInput, update.raw_input, update.args, update.arguments, update.parameters)
  if (name === 'skill_view' || name === 'skill_manage' || name === 'skills_list') {
    const skillName = firstString(data?.name, input?.name, input?.skill, input?.skill_name, name === 'skills_list' ? data?.category : undefined) ?? name
    const file = firstString(data?.file, data?.path, data?.file_path, input?.file_path) ?? 'SKILL.md'
    const summary = firstString(data?.description, data?.summary, data?.message, existingText)
    return {
      type: 'skill', id: `${skillName}:${file}`, title: skillName, source: 'hermes',
      ...(summary ? { summary: compactSummary(summary) } : {}),
      ...(firstString(data?.status) ? { status: firstString(data?.status) } : {}),
      uri: file,
    }
  }
  if (name === 'search_files' || name === 'session_search' || name === 'web_search' || name === 'web_extract') {
    const rawResults = Array.isArray(data?.results) ? data.results : Array.isArray(data?.matches) ? data.matches : Array.isArray(data?.files) ? data.files : Array.isArray(data?.web) ? data.web : undefined
    const results: Array<Record<string, unknown>> = rawResults?.map((entry, index): Record<string, unknown> | null => {
      if (typeof entry === 'string') return { source: entry, rank: index + 1 }
      if (!isRecord(entry)) return null
      const source = firstString(entry.source, entry.path, entry.file, entry.filename, entry.url, entry.session_id, entry.sessionId, entry.title)
      return source ? {
        source, rank: index + 1,
        ...(firstString(entry.title) ? { title: firstString(entry.title) } : {}),
        ...(firstString(entry.snippet, entry.content, entry.text, entry.description) ? { snippet: compactSummary(firstString(entry.snippet, entry.content, entry.text, entry.description)!) } : {}),
        ...(Number.isInteger(entry.line) ? { location: { path: source, line: Number(entry.line) } } : {}),
      } : null
    }).filter((entry): entry is Record<string, unknown> => entry !== null) ?? []
    if (results.length > 0) {
      const total = data && Number.isInteger(data.total_count) ? data.total_count : results.length
      return { type: 'search_result', query: firstString(data?.query, input?.query, input?.pattern), total, results }
    }
    // The polished formatter is still useful when no JSON survived; recover only
    // explicit bullet lines, never arbitrary prose.
    const textResults = parseBulletResults(existingText)
    if (textResults.length > 0) return { type: 'search_result', query: firstString(input?.query, input?.pattern), total: textResults.length, results: textResults }
  }
  if (name === 'terminal' || name === 'process' || name === 'execute_code') {
    const command = firstString(input?.command, input?.code, data?.command, data?.code, data?.cmd)
    const output = firstString(data?.stdout, data?.output, data?.result, data?.log, existingText)
    const error = firstString(data?.stderr, data?.error)
    if (command || output || error) {
      return {
        type: 'terminal', ...(command ? { command } : {}),
        streams: [
          ...(output ? [{ stream: 'stdout', text: output }] : []),
          ...(error ? [{ stream: 'stderr', text: error }] : []),
        ],
        status: update.status === 'failed' || error ? 'failed' : update.status === 'cancelled' ? 'cancelled' : 'completed',
        ...(data && Number.isInteger(data.exit_code) ? { exitCode: Number(data.exit_code) } : data && Number.isInteger(data.exitCode) ? { exitCode: Number(data.exitCode) } : {}),
      }
    }
  }
  if (name === 'memory') {
    const target = firstString(data?.target, input?.target, data?.id, input?.key) ?? 'memory'
    const summary = firstString(data?.message, data?.summary, data?.content, existingText)
    return { type: 'memory', id: target, title: target, source: 'hermes', ...(summary ? { summary: compactSummary(summary) } : {}), ...(firstString(data?.status) ? { status: firstString(data?.status) } : {}) }
  }
  if (name === 'vision_analyze' || name === 'image_generate' || name === 'text_to_speech') {
    const source = firstString(data?.url, data?.image_url, data?.file_path, data?.path)
    if (source) return { type: name === 'text_to_speech' ? 'audio' : 'image', source, sourceKind: /^https?:/i.test(source) ? 'url' : 'path', alt: firstString(data?.description, data?.message, existingText) }
  }
  return undefined
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord)
}

function parseJsonish(value: unknown): unknown {
  if (isRecord(value) || Array.isArray(value)) return value
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  try { return JSON.parse(text) } catch { /* formatter may append a hint */ }
  const start = Math.min(...[text.indexOf('{'), text.indexOf('[')].filter(index => index >= 0))
  if (!Number.isFinite(start)) return undefined
  try { return JSON.parse(text.slice(start)) } catch { return undefined }
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value.map(item => isRecord(item) && isRecord(item.content) && typeof item.content.text === 'string'
    ? item.content.text : isRecord(item) && typeof item.text === 'string' ? item.text : '').filter(Boolean).join('\n').trim()
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
  const normalized = value.trim().toLowerCase().replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\s-]+/g, '_')
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
  // Hermes integrations/kanban/Yuanbao expose stable snake_case names even when
  // they are not in the built-in catalog.  Retain that machine identity for the
  // generic renderer rather than collapsing the whole update to event.unknown.
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(normalized)
    && (normalized.startsWith('browser_') || normalized.startsWith('kanban_') || normalized.startsWith('yb_')
      || normalized.startsWith('discord') || normalized.startsWith('feishu') || normalized.startsWith('ha_')
      || normalized.startsWith('integration_'))) return normalized
  return undefined
}

function isGroupedReplay(update: Record<string, unknown> | undefined): boolean {
  const meta = update?._meta
  return typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>).hermesReplay === true
}
