import type { AgentEventNormalizer, AgentWireEnvelope, NormalizeContext, NormalizeResult } from './agentEventNormalizer.ts'
import type { ContentPart } from '../content/contentPartSchema.ts'
import type { WorkbenchEventIdentity, WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'
import { normalizeAcpEvent } from './acpNormalizer.ts'
import {
  extractUpdate,
  identityFromUpdate,
  isRecord,
  makeEnvelope,
} from './normalizerSupport.ts'

export const claudeCodeNormalizer: AgentEventNormalizer = {
  id: 'claude-code',
  canNormalize: (_input, context) => ['claude', 'claude-code'].includes(context.provider.toLowerCase()),
  normalize: normalizeClaudeCodeEvent,
}

/**
 * Claude Code is an ACP producer, not a second event bus. This adapter only
 * repairs wire-shape differences that the bridge actually emits (camel/snake
 * metadata, ToolCallContent wrappers and a few SDK content aliases) before
 * delegating to the shared ACP normalizer. The exact input is always passed to
 * makeEnvelope as raw evidence; the renderer never has to inspect Claude's
 * vendor object.
 */
export function normalizeClaudeCodeEvent(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  const update = extractUpdate(input)
  if (!update) return normalizeAcpEvent(input, context)

  const redacted = redactedReasoningFromUpdate(update)
  if (redacted) {
    const event: WorkbenchSemanticEvent = {
      type: 'reasoning.redacted',
      reason: redacted.reason,
      parts: [{ kind: 'redacted-reasoning', reason: redacted.reason } as ContentPart],
    }
    return {
      events: [makeEnvelope(event, input, context, update, {}, readClaudeIdentity(update))],
      diagnostics: [],
    }
  }

  const canonicalInput = canonicalizeClaudeWire(input, update)
  const canonicalUpdate = extractUpdate(canonicalInput) ?? update
  const result = normalizeAcpEvent(canonicalInput, context)

  // canonicalInput is a renderer-facing copy. Rebuild envelopes with the
  // original input whenever a repair was made so event.raw remains equivalent
  // to the provider wire (subject only to the shared bounded/redacted policy).
  const preserved: NormalizeResult = canonicalInput === input
    ? result
    : {
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

  const parentToolUseId = readParentToolUseId(canonicalUpdate)
  if (!parentToolUseId) return preserved
  return {
    events: preserved.events.map(envelope => ({
      ...envelope,
      source: { ...envelope.source, parentAgentId: parentToolUseId },
      event: withParentToolUseId(envelope.event, parentToolUseId),
    })),
    diagnostics: preserved.diagnostics,
  }
}

interface RedactedReasoning {
  readonly reason: string
}

/**
 * `redacted_thinking` is currently skipped by Claude's bridge, so this branch
 * is an adapter capability rather than a coverage promotion. If a future
 * bridge sends it, the body is never copied into the semantic event; only the
 * provider's redaction reason is exposed.
 */
function redactedReasoningFromUpdate(update: Record<string, unknown>): RedactedReasoning | undefined {
  const sessionUpdate = canonicalUpdateKind(update)
  const direct = sessionUpdate === 'redacted_thinking' || sessionUpdate === 'redacted_reasoning'
  const content = update.content ?? update.parts ?? update.blocks
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content]
  const redactedBlock = blocks.find(block => isRecord(block) && isRedactedBlock(block))
  if (!direct && !redactedBlock) return undefined
  const source = redactedBlock && isRecord(redactedBlock) ? redactedBlock : update
  const reason = firstString(
    source.reason,
    source.redactionReason,
    source.redaction_reason,
    update.reason,
    update.redactionReason,
    update.redaction_reason,
  ) ?? 'provider_redacted'
  return { reason }
}

function isRedactedBlock(value: Record<string, unknown>): boolean {
  const type = canonicalType(value.type ?? value.kind)
  return type === 'redacted_thinking' || type === 'redacted_reasoning' || type === 'redacted-reasoning'
}

/** Canonicalise a Claude envelope while retaining its original nesting. */
function canonicalizeClaudeWire(input: AgentWireEnvelope | unknown, update: Record<string, unknown>): AgentWireEnvelope | unknown {
  if (!isRecord(input)) return input
  const canonicalUpdate = canonicalizeClaudeUpdate(update)
  if (canonicalUpdate === update) return input

  const params = isRecord(input.params) ? input.params : undefined
  if (params?.update === update) return { ...input, params: { ...params, update: canonicalUpdate } }
  if (input.update === update) return { ...input, update: canonicalUpdate }
  if (params && update === params) return { ...input, params: canonicalUpdate }
  // A bare ACP update is the most common unit-test/replay shape.
  return canonicalUpdate
}

function canonicalizeClaudeUpdate(update: Record<string, unknown>): Record<string, unknown> {
  let next: Record<string, unknown> = update
  let changed = false

  const set = (key: string, value: unknown): void => {
    if (value === undefined) return
    const prior = next[key]
    if (prior === value) return
    if (typeof prior === 'string' && typeof value === 'string' && prior.trim() === value) return
    if (!changed) next = { ...update }
    next[key] = value
    changed = true
  }

  const rawMeta = firstRecord(update._meta, update.meta)
  const vendorMeta = firstRecord(
    rawMeta?.claudeCode,
    rawMeta?.claude_code,
    rawMeta?.['claude-code'],
    update.claudeCode,
    update.claude_code,
  )
  const pylonMeta = firstRecord(rawMeta?.pylon)

  // Vendor metadata is authoritative for Claude's stable identity. Top-level
  // name/toolName fields are accepted only when explicitly present; title is
  // intentionally never parsed as identity (ACP-D03).
  const toolName = firstString(
    vendorMeta?.toolName,
    vendorMeta?.tool_name,
    pylonMeta?.toolName,
    pylonMeta?.tool_name,
    update.toolName,
    update.tool_name,
    update.name,
  )
  const parentToolUseId = firstString(
    vendorMeta?.parentToolUseId,
    vendorMeta?.parent_tool_use_id,
    update.parentToolUseId,
    update.parent_tool_use_id,
  )
  const toolCallId = firstString(
    update.toolCallId,
    update.tool_call_id,
    update.toolUseId,
    update.tool_use_id,
    vendorMeta?.toolCallId,
    vendorMeta?.tool_call_id,
  )
  const messageId = firstString(
    update.messageId,
    update.message_id,
    vendorMeta?.messageId,
    vendorMeta?.message_id,
  )

  if (toolName && !firstString(update.name)) set('name', toolName)
  if (toolName && !firstString(update.toolName)) set('toolName', toolName)
  if (toolCallId) set('toolCallId', toolCallId)
  if (messageId) set('messageId', messageId)
  if (parentToolUseId) set('parentToolUseId', parentToolUseId)

  const canonicalMeta = canonicalClaudeMeta(rawMeta, vendorMeta, pylonMeta, {
    toolName,
    parentToolUseId,
    toolCallId,
    messageId,
  })
  if (canonicalMeta) set('_meta', canonicalMeta)

  // A few replay/SDK variants use is_error instead of the ACP status field.
  // Do not override an explicit status/state supplied by the bridge.
  if (!firstString(update.status, update.state)
    && (update.is_error === true || update.isError === true)) set('status', 'failed')

  const contentKey = ['content', 'parts', 'blocks'].find(key => update[key] !== undefined)
  if (contentKey) {
    const canonicalContent = canonicalizeContentValue(update[contentKey])
    if (canonicalContent.changed) set(contentKey, canonicalContent.value)
  }

  // Claude's upstream toolInfo intentionally has no NotebookEdit branch. A
  // typed diff is safe only when all four identifying fields are explicit;
  // otherwise the ordinary generic tool fallback remains in force.
  const notebookDiff = notebookEditDiff(toolName, update)
  if (notebookDiff && (!contentKey || isEmptyContent(update[contentKey]))) set('content', [notebookDiff])

  return changed ? next : update
}

function canonicalClaudeMeta(
  rawMeta: Record<string, unknown> | undefined,
  vendorMeta: Record<string, unknown> | undefined,
  pylonMeta: Record<string, unknown> | undefined,
  fields: { toolName?: string; parentToolUseId?: string; toolCallId?: string; messageId?: string },
): Record<string, unknown> | undefined {
  if (!vendorMeta && !pylonMeta && !fields.toolName && !fields.parentToolUseId && !fields.toolCallId && !fields.messageId) return undefined
  const canonicalVendor: Record<string, unknown> = {
    ...(vendorMeta ?? {}),
    ...(fields.toolName ? { toolName: fields.toolName } : {}),
    ...(fields.parentToolUseId ? { parentToolUseId: fields.parentToolUseId } : {}),
    ...(fields.toolCallId ? { toolCallId: fields.toolCallId } : {}),
    ...(fields.messageId ? { messageId: fields.messageId } : {}),
  }
  return {
    ...(rawMeta ?? {}),
    claudeCode: canonicalVendor,
    ...(fields.toolName ? { pylon: { ...(pylonMeta ?? {}), toolName: fields.toolName } } : {}),
  }
}

interface CanonicalContent {
  readonly value: unknown
  readonly changed: boolean
}

/** Normalize only known Claude/ACP content shapes; arbitrary provider payloads stay raw. */
function canonicalizeContentValue(value: unknown): CanonicalContent {
  if (Array.isArray(value)) {
    let changed = false
    const mapped = value.map(item => {
      const result = canonicalizeContentValue(item)
      changed ||= result.changed
      return result.value
    })
    return { value: changed ? mapped : value, changed }
  }
  if (!isRecord(value)) return { value, changed: false }

  const type = canonicalType(value.type ?? value.kind)
  let next: Record<string, unknown> = value
  let changed = false
  const set = (key: string, child: unknown): void => {
    if (child === undefined || next[key] === child) return
    if (!changed) next = { ...value }
    next[key] = child
    changed = true
  }

  // ACP ToolCallContent wrapper (`{type:'content', content:{...}}`).
  if (type === 'content' || type === 'tool_content') {
    const child = canonicalizeContentValue(value.content)
    if (child.changed) set('content', child.value)
    return { value: changed ? next : value, changed }
  }

  switch (type) {
    case 'image':
    case 'audio':
    case 'video': {
      const source = isRecord(value.source) ? value.source : undefined
      if (!source && typeof value.data === 'string') {
        set('source', { type: 'base64', data: value.data })
        set('sourceKind', 'base64')
      } else if (source) {
        const mime = firstString(source.media_type, source.mime_type, source.mimeType)
        if (mime && source.mimeType !== mime) set('source', { ...source, mimeType: mime })
      }
      if (typeof value.mime_type === 'string' && value.mimeType === undefined) set('mimeType', value.mime_type)
      break
    }
    case 'resource_link':
      if (typeof value.mime_type === 'string' && value.mimeType === undefined) set('mimeType', value.mime_type)
      if (typeof value.url === 'string' && value.uri === undefined) set('uri', value.url)
      break
    case 'resource': {
      const resource = isRecord(value.resource) ? value.resource : undefined
      if (resource) {
        const mime = firstString(resource.mimeType, resource.mime_type)
        if (mime && resource.mimeType !== mime) set('resource', { ...resource, mimeType: mime })
      }
      break
    }
    case 'diff':
      canonicalizeDiffFields(value, set)
      break
    case 'terminal':
      canonicalizeTerminalFields(value, set)
      break
    case 'search_result':
    case 'search_results':
      if (typeof value.paging_token === 'string' && value.pagingToken === undefined) set('pagingToken', value.paging_token)
      if (typeof value.total_count === 'number' && value.total === undefined) set('total', value.total_count)
      break
  }
  return { value: changed ? next : value, changed }
}

function canonicalizeDiffFields(value: Record<string, unknown>, set: (key: string, child: unknown) => void): void {
  const aliases: readonly [string, string][] = [
    ['file_path', 'path'], ['old_path', 'oldPath'], ['old_text', 'oldText'], ['new_text', 'newText'],
    ['raw_patch', 'rawPatch'], ['edit_mode', 'status'],
  ]
  for (const [from, to] of aliases) if (value[to] === undefined && value[from] !== undefined) set(to, value[from])

  // diffSnapshotFromPart can derive lines from two text sides, but Write's ACP
  // diff deliberately uses oldText:null. Add an explicit line list for either
  // one-sided edit so the canonical diff remains renderable without guessing.
  const hasOld = value.oldText !== undefined || value.old_text !== undefined
  const hasNew = value.newText !== undefined || value.new_text !== undefined
  // ACP's Claude bridge uses null to mean "no previous/new file". The shared
  // diff contract represents that side as an empty string; retain the null in
  // envelope.raw but avoid a false malformed-field diagnostic in the canonical
  // renderer copy.
  if (value.oldText === null) set('oldText', '')
  if (value.newText === null) set('newText', '')
  if (!Array.isArray(value.lines) && !Array.isArray(value.hunks) && typeof value.unified !== 'string' && (hasOld || hasNew)) {
    const oldText = typeof (value.oldText ?? value.old_text) === 'string' ? String(value.oldText ?? value.old_text) : ''
    const newText = typeof (value.newText ?? value.new_text) === 'string' ? String(value.newText ?? value.new_text) : ''
    const oldPresent = typeof (value.oldText ?? value.old_text) === 'string'
    const newPresent = typeof (value.newText ?? value.new_text) === 'string'
    const lines = oldPresent && newPresent
      ? pairedDiffLines(oldText, newText)
      : (oldPresent ? oldText : newText).split(/\r?\n/).map(text => ({ kind: oldPresent ? 'removed' : 'added', text }))
    if (lines.length > 0) set('lines', lines)
  }
}

function pairedDiffLines(oldText: string, newText: string): Array<{ kind: 'context' | 'added' | 'removed'; text: string }> {
  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)
  const lines: Array<{ kind: 'context' | 'added' | 'removed'; text: string }> = []
  for (let index = 0; index < Math.max(oldLines.length, newLines.length); index += 1) {
    const oldLine = oldLines[index]
    const newLine = newLines[index]
    if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) lines.push({ kind: 'context', text: oldLine })
    else {
      if (oldLine !== undefined) lines.push({ kind: 'removed', text: oldLine })
      if (newLine !== undefined) lines.push({ kind: 'added', text: newLine })
    }
  }
  return lines
}

function canonicalizeTerminalFields(value: Record<string, unknown>, set: (key: string, child: unknown) => void): void {
  const aliases: readonly [string, string][] = [
    ['cmd', 'command'], ['process_id', 'processId'], ['session_id', 'sessionId'],
    ['exit_code', 'exitCode'], ['duration_ms', 'durationMs'], ['terminated_by', 'terminatedBy'],
  ]
  for (const [from, to] of aliases) if (value[to] === undefined && value[from] !== undefined) set(to, value[from])
  if (!Array.isArray(value.streams)) {
    const streams = [
      ...(typeof value.stdout === 'string' ? [{ stream: 'stdout', text: value.stdout }] : []),
      ...(typeof value.stderr === 'string' ? [{ stream: 'stderr', text: value.stderr }] : []),
    ]
    if (streams.length > 0) set('streams', streams)
  }
}

function notebookEditDiff(toolName: string | undefined, update: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!toolName || canonicalType(toolName).replace(/_/g, '') !== 'notebookedit') return undefined
  const input = firstRecord(update.input, update.rawInput, update.raw_input, update.args, update.arguments, update.parameters)
  if (!input) return undefined
  const path = firstString(input.notebook_path, input.notebookPath)
  const newSource = typeof (input.new_source ?? input.newSource) === 'string' ? String(input.new_source ?? input.newSource) : undefined
  const cellId = firstString(input.cell_id, input.cellId)
  const editMode = firstString(input.edit_mode, input.editMode)
  if (!path || newSource === undefined || !cellId || !editMode) return undefined
  const removed = /delete|remove/i.test(editMode)
  return {
    type: 'diff',
    path,
    oldText: '',
    newText: newSource,
    status: editMode,
    lines: newSource.length > 0
      ? newSource.split(/\r?\n/).map(text => ({ kind: removed ? 'removed' : 'added', text }))
      : [{ kind: removed ? 'removed' : 'added', text: '' }],
  }
}

function isEmptyContent(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.length === 0
}

function withParentToolUseId(event: WorkbenchSemanticEvent, parentToolUseId: string): WorkbenchSemanticEvent {
  if (!('tool' in event) || !isRecord(event.tool)) return event
  return { ...event, tool: { ...event.tool, parentToolUseId } }
}

function readClaudeIdentity(update: Record<string, unknown>): WorkbenchEventIdentity {
  const base = identityFromUpdate(update)
  const meta = firstRecord(update._meta, update.meta)
  const vendor = firstRecord(meta?.claudeCode, meta?.claude_code, meta?.['claude-code'])
  const toolCallId = firstString(update.toolCallId, update.tool_call_id, update.toolUseId, update.tool_use_id, vendor?.toolCallId, vendor?.tool_call_id)
  const messageId = firstString(update.messageId, update.message_id, vendor?.messageId, vendor?.message_id)
  return {
    ...base,
    ...(toolCallId ? { toolCallId } : {}),
    ...(messageId ? { messageId } : {}),
  }
}

function readParentToolUseId(update: Record<string, unknown> | undefined): string | undefined {
  if (!update) return undefined
  const meta = firstRecord(update._meta, update.meta)
  const claude = firstRecord(meta?.claudeCode, meta?.claude_code, meta?.['claude-code'])
  return firstString(
    update.parentToolUseId,
    update.parent_tool_use_id,
    claude?.parentToolUseId,
    claude?.parent_tool_use_id,
  )
}

function canonicalUpdateKind(update: Record<string, unknown>): string | undefined {
  const raw = update.sessionUpdate
    ?? update.session_update
    ?? update.updateType
    ?? update.update_type
    ?? update.eventType
    ?? update.event_type
    ?? update.type
  return typeof raw === 'string' ? canonicalType(raw) : undefined
}

function canonicalType(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase()
    : ''
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord)
}

function firstString(...values: unknown[]): string | undefined {
  const value = values.find(item => typeof item === 'string' && item.trim().length > 0)
  return typeof value === 'string' ? value.trim() : undefined
}
