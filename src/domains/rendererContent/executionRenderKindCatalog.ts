import type { RenderKindDefinition } from '../../plugin-runtime/renderers/rendererTypes.ts'
import { isJsonValue, parseContentPart } from '../workbench/content/contentPartSchema.ts'
import { TERMINAL_LOG_DEFAULT_TOKENS, TERMINAL_LOG_SETTINGS } from './textRenderKindCatalog.ts'

export function isProcessActivitySnapshotInput(input: unknown): boolean {
  if (!isRecord(input)
    || typeof input.id !== 'string' || !input.id.trim()
    || input.kind !== 'activity'
    || input.activityKind !== 'process'
    || input.semanticKind !== 'activity.process'
    || typeof input.status !== 'string' || !input.status.trim()) return false
  for (const key of ['title', 'parentId', 'processId', 'sessionId', 'reason'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) return false
  }
  if (input.progress !== undefined && !isJsonValue(input.progress)) return false
  if (input.result !== undefined && !isJsonValue(input.result)) return false
  if (input.parts !== undefined && (!Array.isArray(input.parts) || !input.parts.every(part => parseContentPart(part).ok))) return false
  return true
}

export const BUILTIN_EXECUTION_RENDER_KINDS: readonly RenderKindDefinition[] = Object.freeze([
  Object.freeze({
    id: 'activity.process',
    category: 'activity',
    fallbackKind: 'content.unknown',
    priority: 1000,
    fixture: {
      id: 'fixture-process', kind: 'activity', activityKind: 'process', semanticKind: 'activity.process',
      title: 'Fixture process', status: 'running', processId: 'fixture-pid', parts: [],
    },
    defaultTokens: TERMINAL_LOG_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: TERMINAL_LOG_SETTINGS,
    validateInput: isProcessActivitySnapshotInput,
  } satisfies RenderKindDefinition),
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
