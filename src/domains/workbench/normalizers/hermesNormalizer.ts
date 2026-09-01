import type { AgentEventNormalizer, AgentWireEnvelope, NormalizeContext, NormalizeResult } from './agentEventNormalizer.ts'
import { normalizeAcpEvent } from './acpNormalizer.ts'
import { createDiagnostic, createUnknownEvent, extractUpdate, isRecord, makeEnvelope, wireKind } from './normalizerSupport.ts'
import { resolveToolSemantic } from '../../tool/toolRegistry.ts'
import { splitToolTitle } from '../../tool/toolResolution.ts'

export const hermesNormalizer: AgentEventNormalizer = {
  id: 'hermes',
  canNormalize: (_input, context) => context.provider.toLowerCase() === 'hermes',
  normalize: normalizeHermesEvent,
}

export function normalizeHermesEvent(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  const update = extractUpdate(input)
  const kind = wireKind(update)
  if (kind === 'delegate' || kind === 'delegation' || kind === 'media') {
    const diagnostic = createDiagnostic(context, update, 'hermes.incomplete-extension', 'Hermes extension lacks a complete semantic payload; preserved as unknown', ['payload'], true)
    return {
      events: [makeEnvelope(createUnknownEvent(input, update, kind), input, context, update, { orderConfidence: context.replay ? 'grouped' : 'observed' })],
      diagnostics: [diagnostic],
    }
  }
  // Hermes' progress callback historically serializes commands into `title`
  // (for example `terminal: git status`) and uses `args`/`arguments`/`preview`
  // instead of ACP's `input`.  Canonicalize that vendor shape at the adapter
  // seam so renderers receive a stable machine name + structured input.  The
  // original wire payload remains in the envelope raw field for forensics.
  const canonicalInput = canonicalizeHermesTool(input, update)
  const result = normalizeAcpEvent(canonicalInput, context)
  // Adapter rewrites are renderer-facing only; keep the exact provider wire
  // payload as the envelope raw evidence (including the original title).
  const preservedResult = canonicalInput === input ? result : {
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
  const pylon = isRecord(meta?.pylon) ? meta.pylon : undefined
  const explicitName = firstString(pylon?.toolName, pylon?.tool_name, update.name, update.toolName, update.tool_name, update.tool)
  const title = firstString(update.title)
  const parsedTitle = title ? splitToolTitle(title) : { name: '', summary: '' }
  // Hermes ACP's ToolCallStart intentionally exposes only a human title
  // (the Python adapter has no machine-name field).  Recover the canonical
  // name before handing the event to the generic ACP normalizer; otherwise
  // every title-only call becomes `unknown` even though its wire kind is valid.
  const parsedName = parsedTitle.name ? canonicalHermesToolName(parsedTitle.name) : undefined
  const parsedEntry = parsedName ? resolveToolSemantic('hermes', parsedName) : null
  const name = explicitName || (parsedEntry ? parsedName : undefined)
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
  }
  return aliases[normalized]
}

function isGroupedReplay(update: Record<string, unknown> | undefined): boolean {
  const meta = update?._meta
  return typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>).hermesReplay === true
}
