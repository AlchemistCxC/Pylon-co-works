import type { RenderKindDefinition } from '../../plugin-runtime/renderers/rendererTypes.ts'
import type { RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import type { JsonValue } from '../workbench/events/workbenchEventSchema.ts'
import type { AssistSnapshot, BudgetSnapshot, SessionCommand, SessionConfigOption, UsageSnapshot } from '../workbench/session/sessionSurface.ts'

const USAGE_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{ id: 'usage', label: '用量显示', layout: 'grid', fields: [
    { key: 'units', label: '单位', type: 'choice', presentation: 'segmented', options: [
      { value: 'tokens', label: 'Token' }, { value: 'compact', label: '紧凑' },
    ], default: 'tokens' },
    { key: 'visibleMetrics', label: '显示指标', type: 'multi-choice', presentation: 'checklist', options: [
      { value: 'input', label: '输入' }, { value: 'output', label: '输出' },
      { value: 'reasoning', label: '推理' }, { value: 'cacheRead', label: '缓存读取' },
      { value: 'cacheWrite', label: '缓存写入' }, { value: 'context', label: '上下文' },
      { value: 'cost', label: '费用' },
    ], default: ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'context', 'cost'] },
    { key: 'showCost', label: '显示费用', type: 'boolean', presentation: 'toggle', default: true },
    { key: 'showContext', label: '显示上下文', type: 'boolean', presentation: 'toggle', default: true },
    { key: 'showRaw', label: '显示未知字段', type: 'boolean', presentation: 'toggle', default: false },
  ] }],
} satisfies RendererSettingsSchema)

const BUDGET_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{ id: 'budget', label: '预算显示', layout: 'grid', fields: [
    { key: 'warningPalette', label: '警告色板', type: 'choice', presentation: 'segmented', options: [
      { value: 'semantic', label: '语义色' }, { value: 'mono', label: '单色' },
    ], default: 'semantic' },
    { key: 'warningThreshold', label: '警告阈值', type: 'number', presentation: 'slider+input', min: 0, max: 100, step: 1, unit: '%', default: 80 },
  ] }],
} satisfies RendererSettingsSchema)

const CONFIG_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{ id: 'config', label: '会话配置', layout: 'grid', fields: [
    { key: 'layout', label: '布局', type: 'choice', presentation: 'segmented', options: [
      { value: 'inline', label: '内联' }, { value: 'list', label: '列表' },
    ], default: 'list' },
    { key: 'showUnknown', label: '显示未知值', type: 'boolean', presentation: 'toggle', default: true },
  ] }],
} satisfies RendererSettingsSchema)

const COMMAND_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{ id: 'commands', label: '命令建议', layout: 'grid', fields: [
    { key: 'density', label: '列表密度', type: 'choice', presentation: 'segmented', options: [
      { value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' },
    ], default: 'comfortable' },
  ] }],
} satisfies RendererSettingsSchema)

const ASSIST_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{ id: 'assist', label: '输入辅助', layout: 'grid', fields: [
    { key: 'opacity', label: '建议透明度', type: 'number', presentation: 'slider+input', min: 0, max: 1, step: 0.05, default: 1 },
    { key: 'showFiles', label: '显示文件建议', type: 'boolean', presentation: 'toggle', default: true },
    { key: 'fileSuggestionMaxCount', label: '文件建议上限', type: 'number', presentation: 'slider+input', min: 0, max: 20, step: 1, default: 5 },
    { key: 'acceptKey', label: '接受快捷键', type: 'choice', presentation: 'segmented', options: [
      { value: 'enter', label: 'Enter' }, { value: 'tab', label: 'Tab' }, { value: 'none', label: '关闭' },
    ], default: 'enter' },
  ] }],
} satisfies RendererSettingsSchema)

const DEFAULT_USAGE_TOKENS = Object.freeze({
  units: 'tokens',
  visibleMetrics: ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'context', 'cost'],
  showCost: true, showContext: true, showRaw: false,
})
const DEFAULT_BUDGET_TOKENS = Object.freeze({ warningPalette: 'semantic', warningThreshold: 80 })
const DEFAULT_CONFIG_TOKENS = Object.freeze({ layout: 'list', showUnknown: true })
const DEFAULT_COMMAND_TOKENS = Object.freeze({ density: 'comfortable' })
const DEFAULT_ASSIST_TOKENS = Object.freeze({ opacity: 1, showFiles: true, fileSuggestionMaxCount: 5, acceptKey: 'enter' })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isBudget(value: unknown): value is BudgetSnapshot {
  return isRecord(value)
    && ['used', 'limit', 'remaining', 'percent'].every(key => value[key] === undefined || nonNegative(value[key]))
    && (value.type === undefined || typeof value.type === 'string')
    && (value.resetAt === undefined || typeof value.resetAt === 'string')
    && (value.threshold === undefined || typeof value.threshold === 'string')
    && (value.exhausted === undefined || typeof value.exhausted === 'boolean')
}

function isUsage(value: unknown): value is UsageSnapshot {
  if (!isRecord(value)) return false
  const numeric = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'contextUsed', 'contextLimit', 'contextPercent', 'calls', 'costUsd']
  return numeric.every(key => value[key] === undefined || nonNegative(value[key]))
    && (value.currency === undefined || typeof value.currency === 'string')
    && (value.budget === undefined || isBudget(value.budget))
}

function isCommand(value: unknown): value is SessionCommand {
  return isRecord(value) && typeof value.id === 'string' && value.id.trim().length > 0
    && typeof value.name === 'string' && value.name.trim().length > 0
    && (value.description === undefined || typeof value.description === 'string')
    && (value.inputHint === undefined || typeof value.inputHint === 'string')
    && (value.availability === undefined || typeof value.availability === 'boolean' || typeof value.availability === 'string')
    && (value.capability === undefined || typeof value.capability === 'string')
}

function isConfig(value: unknown): value is SessionConfigOption {
  if (!(isRecord(value) && typeof value.id === 'string' && value.id.trim().length > 0
    && typeof value.label === 'string' && value.label.trim().length > 0
    && (value.editable === undefined || typeof value.editable === 'boolean')
    && (value.version === undefined || nonNegative(value.version)))) return false
  if (value.value !== undefined && !isJsonValue(value.value)) return false
  if (value.schema !== undefined && !isJsonValue(value.schema)) return false
  if (value.raw !== undefined && (!isRecord(value.raw) || !Object.values(value.raw).every(isJsonValue))) return false
  if (value.editable === true) {
    if (value.valueType === 'boolean') return typeof value.value === 'boolean'
    if (value.valueType !== 'select' || typeof value.value !== 'string' || !isRecord(value.schema)) return false
    return Array.isArray(value.schema.options) && value.schema.options.length > 0
  }
  return true
}

function isAssist(value: unknown): value is AssistSnapshot {
  if (!isRecord(value) || !Array.isArray(value.files) || !value.files.every(file => typeof file === 'string')) return false
  if (value.queuedCommand !== undefined && typeof value.queuedCommand !== 'string') return false
  if (value.prediction !== undefined) {
    if (!isRecord(value.prediction) || !Array.isArray(value.prediction.actions) || !value.prediction.actions.every(isJsonValue)) return false
    if (value.prediction.placeholder !== undefined && typeof value.prediction.placeholder !== 'string') return false
  }
  return true
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function definition(
  id: string,
  fixture: unknown,
  defaultTokens: unknown,
  settings: RendererSettingsSchema,
  validateInput: (value: unknown) => boolean,
): RenderKindDefinition {
  return Object.freeze({
    id,
    category: id.startsWith('assist.') ? 'assist' : 'session',
    fallbackKind: 'content.unknown',
    priority: 1000,
    fixture,
    defaultTokens,
    settingsSchemaVersion: 1,
    settings,
    validateInput,
  })
}

export const BUILTIN_SESSION_RENDER_KINDS: readonly RenderKindDefinition[] = Object.freeze([
  definition('session.usage', {}, DEFAULT_USAGE_TOKENS, USAGE_SETTINGS, isUsage),
  definition('session.budget', {}, DEFAULT_BUDGET_TOKENS, BUDGET_SETTINGS, isBudget),
  definition('session.config', { options: [] }, DEFAULT_CONFIG_TOKENS, CONFIG_SETTINGS,
    value => isRecord(value) && Array.isArray(value.options) && value.options.every(isConfig)),
  definition('session.commands', { commands: [] }, DEFAULT_COMMAND_TOKENS, COMMAND_SETTINGS,
    value => isRecord(value) && Array.isArray(value.commands) && value.commands.every(isCommand)),
  definition('assist.prediction', { files: [], prediction: { actions: [] } }, DEFAULT_ASSIST_TOKENS, ASSIST_SETTINGS, isAssist),
  definition('assist.file-suggestions', { files: [] }, DEFAULT_ASSIST_TOKENS, ASSIST_SETTINGS, isAssist),
])
