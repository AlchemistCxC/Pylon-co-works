import type { RenderKindDefinition } from '../../plugin-runtime/renderers/rendererTypes.ts'
import type { RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { isJsonValue, parseContentPart } from '../workbench/content/contentPartSchema.ts'
import { isActivityStatus } from '../workbench/events/workbenchEventSchema.ts'
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
/** C10：后台任务与工作流家族（background-task 既有 kind；workflow 三兄弟新增）。 */
export type WorkflowActivityFamily = 'workflow' | 'workflow-phase' | 'workflow-agent'

export function isSubagentActivitySnapshotInput(input: unknown): boolean {
  if (!isRecord(input)
    || typeof input.id !== 'string' || !input.id.trim()
    || input.kind !== 'activity'
    || !(input.activityKind === 'subagent' || input.activityKind === 'delegation' || input.activityKind === 'team')
    || input.semanticKind !== `activity.${input.activityKind}`
    || !isActivityStatus(input.status)) return false
  for (const key of [
    'title', 'parentId', 'sourceAgentId', 'description', 'startedAt', 'completedAt',
    'role', 'model', 'provider', 'goal',
  ] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) return false
  }
  if (input.depth !== undefined && (typeof input.depth !== 'number' || !Number.isFinite(input.depth) || input.depth < 0)) return false
  for (const key of ['progress', 'result', 'usage', 'files', 'metadata', 'capabilities'] as const) {
    if (input[key] !== undefined && !isJsonValue(input[key])) return false
  }
  for (const key of ['parts', 'output'] as const) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || !input[key].every(part => parseContentPart(part).ok))) return false
  }
  if (input.metrics !== undefined && !isActivityMetrics(input.metrics)) return false
  if (input.execution !== undefined && (!isRecord(input.execution) || !isJsonValue(input.execution))) return false
  for (const key of ['tools', 'tasks'] as const) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || !input[key].every(isJsonValue))) return false
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
    defaultTokens: SUBAGENT_WORKFLOW_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: SUBAGENT_WORKFLOW_SETTINGS,
    validateInput: isSubagentActivitySnapshotInput,
  } satisfies RenderKindDefinition)
}

/** C10：workflow 家族快照校验——phase/agent 经 parentId relation 挂接，缺失降级不猜。 */
export function isWorkflowActivitySnapshotInput(input: unknown): boolean {
  if (!isRecord(input)
    || typeof input.id !== 'string' || !input.id.trim()
    || input.kind !== 'activity'
    || !(input.activityKind === 'workflow' || input.activityKind === 'workflow-phase' || input.activityKind === 'workflow-agent')
    || typeof input.status !== 'string' || !input.status.trim()) return false
  for (const key of ['semanticKind', 'title', 'parentId', 'role', 'model', 'provider', 'goal'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) return false
  }
  if (input.depth !== undefined && (typeof input.depth !== 'number' || !Number.isFinite(input.depth))) return false
  for (const key of ['progress', 'result', 'usage', 'files', 'metadata', 'capabilities', 'parts'] as const) {
    if (input[key] !== undefined && !isJsonValue(input[key])) return false
  }
  return true
}

function workflowKindDefinition(family: WorkflowActivityFamily): RenderKindDefinition {
  return Object.freeze({
    id: `activity.${family}`,
    category: 'activity',
    fallbackKind: 'content.unknown',
    priority: 1000,
    fixture: {
      id: `fixture-${family}`, kind: 'activity', activityKind: family, semanticKind: `activity.${family}`,
      title: `Fixture ${family}`, status: 'running', parentId: family === 'workflow' ? undefined : 'fixture-workflow',
      role: family === 'workflow-agent' ? 'reviewer' : undefined, parts: [],
    },
    defaultTokens: SUBAGENT_WORKFLOW_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: SUBAGENT_WORKFLOW_SETTINGS,
    validateInput: isWorkflowActivitySnapshotInput,
  } satisfies RenderKindDefinition)
}

/** C09/C10：子代理与工作流卡的声明设置（K11 token；控件由 A10 设置页生成）。 */
const SUBAGENT_WORKFLOW_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '子代理外观', layout: 'grid', fields: [
        { key: 'density', label: '密度', type: 'choice', presentation: 'segmented', options: [
          { value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' }
        ], default: 'comfortable' },
        { key: 'showIdentity', label: '显示身份元数据', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'identityMarker', label: '身份标记', type: 'choice', presentation: 'segmented', options: [
          { value: 'glyph', label: '图标' }, { value: 'avatar', label: '头像' }, { value: 'none', label: '隐藏' },
        ], default: 'glyph' },
        { key: 'cardWidth', label: '卡片宽度', type: 'number', presentation: 'slider+input', min: 240, max: 1600, step: 20, unit: 'px', default: 960 },
        { key: 'viewMode', label: '布局', type: 'choice', presentation: 'segmented', options: [
          { value: 'tree', label: '树' }, { value: 'cards', label: '卡片' },
        ], default: 'tree' },
        { key: 'treeLineStyle', label: '树线样式', type: 'choice', presentation: 'segmented', options: [
          { value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'none', label: '隐藏' },
        ], default: 'solid' },
        { key: 'treeLineColor', label: '树线颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--accent)' },
        { key: 'indent', label: '层级缩进', type: 'number', presentation: 'slider+input', min: 0, max: 80, step: 2, unit: 'px', default: 24 },
      ],
    },
    {
      id: 'behaviour', label: '子代理行为', layout: 'grid', fields: [
        { key: 'stats', label: '统计列', type: 'multi-choice', presentation: 'checklist', options: [
          { value: 'usage', label: '用量' }, { value: 'files', label: '文件数' }, { value: 'progress', label: '进度' },
          { value: 'metrics', label: '工具/任务/耗时' },
        ], default: ['usage', 'files', 'progress', 'metrics'] },
        { key: 'statusPalette', label: '状态配色', type: 'choice', presentation: 'select', options: [
          { value: 'semantic', label: '语义色' }, { value: 'mono', label: '单色' }
        ], default: 'semantic' },
        { key: 'defaultExpandedDepth', label: '默认展开深度', type: 'number', presentation: 'slider+input', min: 0, max: 12, step: 1, default: 2 },
        { key: 'showAggregate', label: '显示聚合统计', type: 'boolean', presentation: 'toggle', default: true },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const SUBAGENT_WORKFLOW_DEFAULT_TOKENS = Object.freeze({
  density: 'comfortable', showIdentity: true, retainedLines: 2000,
  identityMarker: 'glyph', cardWidth: 960, viewMode: 'tree', treeLineStyle: 'solid', treeLineColor: 'var(--accent)', indent: 24,
  stats: ['usage', 'files', 'progress', 'metrics'], statusPalette: 'semantic', defaultExpandedDepth: 2, showAggregate: true,
})

export const BUILTIN_EXECUTION_RENDER_KINDS: readonly RenderKindDefinition[] = Object.freeze([
  ...(['subagent', 'delegation', 'team'] as const).map(subagentKindDefinition),
  ...(['workflow', 'workflow-phase', 'workflow-agent'] as const).map(workflowKindDefinition),
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
  Object.freeze({
    id: 'activity.background-task',
    category: 'activity',
    fallbackKind: 'content.unknown',
    priority: 1000,
    fixture: {
      id: 'fixture-background-task', kind: 'activity', activityKind: 'background-task', semanticKind: 'activity.background-task',
      title: 'Fixture background task', status: 'running', parts: [],
    },
    defaultTokens: SUBAGENT_WORKFLOW_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: SUBAGENT_WORKFLOW_SETTINGS,
    validateInput: isBackgroundTaskActivitySnapshotInput,
  } satisfies RenderKindDefinition),
])

/** C16 审计补齐：background-task 快照校验——与 process 同构但 identity 独立。 */
export function isBackgroundTaskActivitySnapshotInput(input: unknown): boolean {
  if (!isRecord(input)
    || typeof input.id !== 'string' || !input.id.trim()
    || input.kind !== 'activity'
    || input.activityKind !== 'background-task'
    || input.semanticKind !== 'activity.background-task'
    || typeof input.status !== 'string' || !input.status.trim()) return false
  for (const key of ['title', 'parentId', 'sessionId', 'reason'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ACTIVITY_METRIC_KEYS: ReadonlySet<string> = new Set(['toolCount', 'taskCount', 'durationMs', 'costUsd'])

function isActivityMetrics(value: unknown): boolean {
  if (!isRecord(value) || !Object.keys(value).every(key => ACTIVITY_METRIC_KEYS.has(key))) return false
  for (const key of ['toolCount', 'taskCount'] as const) {
    const metric = value[key]
    if (metric !== undefined && (typeof metric !== 'number' || !Number.isInteger(metric) || metric < 0)) return false
  }
  for (const key of ['durationMs', 'costUsd'] as const) {
    const metric = value[key]
    if (metric !== undefined && (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0)) return false
  }
  return true
}
