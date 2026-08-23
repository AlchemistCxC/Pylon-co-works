import type { RenderKindDefinition } from '../../plugin-runtime/renderers/rendererTypes.ts'
import type { RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'

const INTERACTION_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'layout', label: '交互布局', layout: 'grid', fields: [
        { key: 'presentation', label: '呈现方式', type: 'choice', presentation: 'segmented', options: [
          { value: 'inline', label: '内联' }, { value: 'modal', label: '模态' },
        ], default: 'inline' },
        { key: 'maxWidth', label: '最大宽度', type: 'number', presentation: 'slider+input', min: 320, max: 1200, step: 20, unit: 'px', default: 720 },
        { key: 'optionDensity', label: '选项密度', type: 'choice', presentation: 'segmented', options: [
          { value: 'compact', label: '紧凑' }, { value: 'comfortable', label: '舒适' },
        ], default: 'comfortable' },
        { key: 'confirmOrder', label: '确认按钮顺序', type: 'choice', presentation: 'segmented', options: [
          { value: 'safe-first', label: '安全项优先' }, { value: 'source', label: '请求顺序' },
        ], default: 'safe-first' },
      ],
    },
    {
      id: 'appearance', label: '交互外观', layout: 'grid', fields: [
        { key: 'dangerColor', label: '危险色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--danger, #e5484d)' },
        { key: 'pendingColor', label: '待处理色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--accent)' },
        { key: 'resolvedColor', label: '已响应色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--tool-ok, var(--accent))' },
        { key: 'expiredColor', label: '已过期色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'descriptionsExpanded', label: '默认展开说明', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showTechnicalMetadata', label: '显示技术元数据', type: 'boolean', presentation: 'toggle', default: false },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const INTERACTION_DEFAULT_TOKENS = Object.freeze({
  presentation: 'inline', maxWidth: 720, optionDensity: 'comfortable', confirmOrder: 'safe-first',
  dangerColor: 'var(--danger, #e5484d)', pendingColor: 'var(--accent)',
  resolvedColor: 'var(--tool-ok, var(--accent))', expiredColor: 'var(--text-dim)',
  descriptionsExpanded: true, showTechnicalMetadata: false,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isInteractionSnapshotInput(input: unknown): boolean {
  if (!isRecord(input) || typeof input.id !== 'string' || typeof input.sequence !== 'number') return false
  if (!['requested', 'resolved', 'expired'].includes(String(input.status))) return false
  if (!isRecord(input.request) || input.request.surface !== 'interaction' || !Array.isArray(input.request.questions)) return false
  if (!isRecord(input.request.identity)) return false
  const identity = input.request.identity
  if (![identity.provider, identity.agentId, identity.requestId, identity.sessionId, identity.toolCallId]
    .every(value => value === null || typeof value === 'string')) return false
  if (identity.clientGeneration !== null && typeof identity.clientGeneration !== 'number') return false
  return input.request.questions.every(question => isRecord(question)
    && typeof question.id === 'string'
    && typeof question.question === 'string'
    && Array.isArray(question.options)
    && question.options.every(option => isRecord(option)
      && typeof option.id === 'string'
      && typeof option.label === 'string'
      && (option.description === undefined || typeof option.description === 'string')
      && (option.danger === undefined || typeof option.danger === 'boolean'))
    && typeof question.allowMultiple === 'boolean'
    && typeof question.allowFreeform === 'boolean')
}

const ids = Object.freeze([
  'interaction.approval', 'interaction.questions', 'interaction.confirm', 'interaction.permission',
] as const)

export const BUILTIN_INTERACTION_RENDER_KINDS: readonly RenderKindDefinition[] = Object.freeze(ids.map(id => Object.freeze({
  id,
  category: 'interaction',
  fallbackKind: 'content.unknown',
  priority: 1000,
  fixture: {
    id: `fixture-${id}`, status: 'requested', sequence: 1,
    request: {
      surface: 'interaction', kind: id.slice('interaction.'.length), state: 'waiting',
      identity: { provider: null, agentId: null, requestId: null, sessionId: null, toolCallId: null, clientGeneration: null },
      questions: [{ id: 'decision', question: `Fixture ${id}`, options: [], allowMultiple: false, allowFreeform: true }],
    },
  },
  defaultTokens: INTERACTION_DEFAULT_TOKENS,
  settingsSchemaVersion: 1,
  settings: INTERACTION_SETTINGS,
  validateInput: isInteractionSnapshotInput,
} satisfies RenderKindDefinition)))
