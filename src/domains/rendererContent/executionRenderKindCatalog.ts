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

/** C09：子代理/委派/团队活动快照校验——family 三兄弟共用一套字段契约（缺失降级为 undefined，不猜）。 */
export type SubagentActivityFamily = 'subagent' | 'delegation' | 'team'

export function isSubagentActivitySnapshotInput(input: unknown): boolean {
  if (!isRecord(input)
    || typeof input.id !== 'string' || !input.id.trim()
    || input.kind !== 'activity'
    || !(input.activityKind === 'subagent' || input.activityKind === 'delegation' || input.activityKind === 'team')
    || typeof input.status !== 'string' || !input.status.trim()) return false
  for (const key of ['semanticKind', 'title', 'parentId', 'role', 'model', 'provider', 'goal'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) return false
  }
  if (input.depth !== undefined && (typeof input.depth !== 'number' || !Number.isFinite(input.depth) || input.depth < 0)) return false
  for (const key of ['progress', 'result', 'usage', 'files', 'metadata', 'capabilities', 'parts'] as const) {
    if (input[key] !== undefined && !isJsonValue(input[key])) return false
  }
  return true
}

/** C09：三个 family 各注册一个 kind（fixture 自校验）；缺省 semanticKind 时按 family 直译派生。 */
function subagentKindDefinition(family: SubagentActivityFamily): RenderKindDefinition {
  const label = family === 'subagent' ? 'Fixture subagent' : family === 'delegation' ? 'Fixture delegation' : 'Fixture team'
  return Object.freeze({
    id: `activity.${family}`,
    category: 'activity',
    fallbackKind: 'content.unknown',
    priority: 1000,
    fixture: {
      id: `fixture-${family}`, kind: 'activity', activityKind: family, semanticKind: `activity.${family}`,
      title: label, status: 'running', parentId: 'fixture-parent', depth: 1,
      role: 'explorer', goal: label, parts: [],
    },
    defaultTokens: TERMINAL_LOG_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: TERMINAL_LOG_SETTINGS,
    validateInput: isSubagentActivitySnapshotInput,
  } satisfies RenderKindDefinition)
}

export const BUILTIN_EXECUTION_RENDER_KINDS: readonly RenderKindDefinition[] = Object.freeze([
  ...(['subagent', 'delegation', 'team'] as const).map(subagentKindDefinition),
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
