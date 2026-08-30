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
  if (!update || !['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || !isRecord(input)) return input

  const meta = isRecord(update._meta) ? update._meta : undefined
  const pylon = isRecord(meta?.pylon) ? meta.pylon : undefined
  const explicitName = firstString(pylon?.toolName, update.name, update.toolName, update.tool_name)
  const title = firstString(update.title)
  const parsedTitle = title ? splitToolTitle(title) : { name: '', summary: '' }
  const parsedEntry = parsedTitle.name ? resolveToolSemantic('hermes', parsedTitle.name) : null
  const name = explicitName || (parsedEntry ? parsedTitle.name : undefined)
  if (!name) return input

  const nameEntry = resolveToolSemantic('hermes', name)
  const titlePrefixMatches = parsedTitle.summary.length > 0
    && parsedTitle.name.trim().toLowerCase() === name.trim().toLowerCase()
  const embeddedSummary = titlePrefixMatches ? parsedTitle.summary : ''
  const wireInput = update.input ?? update.rawInput ?? update.args ?? update.arguments ?? update.preview
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
    ...(inputValue !== undefined && update.input === undefined && update.rawInput === undefined
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
  return values.find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined
}

function isGroupedReplay(update: Record<string, unknown> | undefined): boolean {
  const meta = update?._meta
  return typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>).hermesReplay === true
}
