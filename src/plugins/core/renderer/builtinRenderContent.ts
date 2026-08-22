/** 内置内容渲染器：全部直接注册到 v2 Renderer Registry。 */
import Anser from 'anser'
import { resolveSpinnerFramesBuiltin } from '../../../components/chat/spinnerFrames.ts'
import type {
  AnsiProvider,
  ContentPartProvider,
  FooterProvider,
  PlanProvider,
  SpinnerProvider,
} from '../../../contracts/rendererContentPoints.ts'
import type { BuiltinPluginDefinition } from '../../../plugin-runtime/pluginRuntime.ts'
import type { RenderKindDefinition } from '../../../plugin-runtime/renderers/rendererTypes.ts'
import type { RendererSettingsSchema } from '../../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { isValidPlanContentInput } from '../../../domains/workbench/plan/goalModel.ts'
import {
  isValidLifecycleStateInput,
  isValidNormalizedErrorInput,
  isValidSystemNoticeInput,
} from '../../../domains/workbench/lifecycle/lifecycleModel.ts'

export const CORE_RENDERER_CONTENT_PART_PLUGIN_ID = 'core.renderer.content-part'

const PLAN_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '计划外观', layout: 'grid', fields: [
        { key: 'foreground', label: '主文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'mutedForeground', label: '次要文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'pendingColor', label: '待处理颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'activeColor', label: '进行中颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--accent)' },
        { key: 'completedColor', label: '已完成颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--tool-ok, var(--accent))' },
        { key: 'cancelledColor', label: '已取消颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--danger, #e5484d)' },
        { key: 'blockedColor', label: '已阻塞颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--warning, #d29922)' },
        { key: 'unknownColor', label: '未知状态颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'nodeGlyph', label: '节点标记', type: 'choice', presentation: 'segmented', optionTarget: 'kind.content.plan.nodeGlyph', options: [
          { value: 'status', label: '状态符号' }, { value: 'dot', label: '圆点' }, { value: 'none', label: '无' },
        ], default: 'status' },
        { key: 'connectorStyle', label: '连接线', type: 'choice', presentation: 'segmented', options: [
          { value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'none', label: '无' },
        ], default: 'solid' },
        { key: 'connectorColor', label: '连接线颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'connectorWidth', label: '连接线宽度', type: 'number', presentation: 'slider+input', min: 0, max: 4, step: 0.5, unit: 'px', default: 1 },
        { key: 'indent', label: '层级缩进', type: 'number', presentation: 'slider+input', min: 8, max: 48, step: 2, unit: 'px', default: 20 },
      ],
    },
    {
      id: 'behaviour', label: '计划行为', layout: 'grid', fields: [
        { key: 'defaultExpanded', label: '默认展开计划', type: 'boolean', presentation: 'toggle', default: false },
        { key: 'collapseCompleted', label: '默认收起已完成项', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showPriority', label: '显示优先级', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showBudget', label: '显示目标预算', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'density', label: '密度', type: 'choice', presentation: 'segmented', options: [
          { value: 'compact', label: '紧凑' }, { value: 'comfortable', label: '舒适' },
        ], default: 'comfortable' },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const PLAN_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text)', mutedForeground: 'var(--text-dim)', background: 'transparent', borderColor: 'var(--border)',
  pendingColor: 'var(--text-dim)', activeColor: 'var(--accent)', completedColor: 'var(--tool-ok, var(--accent))',
  cancelledColor: 'var(--danger, #e5484d)', blockedColor: 'var(--warning, #d29922)', unknownColor: 'var(--text-dim)',
  nodeGlyph: 'status', connectorStyle: 'solid', connectorColor: 'var(--border)', connectorWidth: 1, indent: 20,
  defaultExpanded: false, collapseCompleted: true, showPriority: true, showBudget: true, density: 'comfortable',
})

export const BUILTIN_PLAN_RENDER_KIND: RenderKindDefinition = Object.freeze({
  id: 'content.plan', aliases: ['plan'], category: 'content', fallbackKind: 'content.unknown', priority: 1000,
  fixture: { entries: [], goal: undefined }, defaultTokens: PLAN_DEFAULT_TOKENS, settingsSchemaVersion: 1,
  settings: PLAN_SETTINGS,
  validateInput: isValidPlanContentInput,
})

const LIFECYCLE_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '生命周期外观', layout: 'grid', fields: [
        { key: 'foreground', label: '主文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'mutedForeground', label: '次要文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'infoColor', label: '信息颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--accent)' },
        { key: 'warningColor', label: '警告颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--warning, #d29922)' },
        { key: 'errorColor', label: '错误颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--danger, #e5484d)' },
        { key: 'successColor', label: '恢复颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--tool-ok, var(--accent))' },
        { key: 'density', label: '通知密度', type: 'choice', presentation: 'segmented', options: [
          { value: 'compact', label: '紧凑' }, { value: 'comfortable', label: '舒适' },
        ], default: 'comfortable' },
        { key: 'motion', label: '状态动效', type: 'choice', presentation: 'segmented', options: [
          { value: 'none', label: '关闭' }, { value: 'subtle', label: '轻微' },
        ], default: 'none' },
      ],
    },
    {
      id: 'behaviour', label: '生命周期行为', layout: 'grid', fields: [
        { key: 'technicalDetailsExpanded', label: '默认展开技术详情', type: 'boolean', presentation: 'toggle', default: false },
        { key: 'noticePlacements', label: '通知位置', type: 'multi-choice', presentation: 'checklist', options: [
          { value: 'inline', label: '内联' }, { value: 'timeline', label: '时间线' }, { value: 'toast', label: 'Toast' },
        ], minSelected: 1, default: ['inline', 'timeline'] },
        { key: 'retryCountdownStyle', label: '重试倒计时', type: 'choice', presentation: 'segmented', options: [
          { value: 'seconds', label: '秒数' }, { value: 'compact', label: '紧凑' }, { value: 'hidden', label: '隐藏' },
        ], default: 'seconds' },
        { key: 'showProviderIds', label: '显示 Provider/插件标识', type: 'boolean', presentation: 'toggle', default: false },
        { key: 'showEventIds', label: '显示事件标识', type: 'boolean', presentation: 'toggle', default: false },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const LIFECYCLE_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text)', mutedForeground: 'var(--text-dim)', background: 'transparent', borderColor: 'var(--border)',
  infoColor: 'var(--accent)', warningColor: 'var(--warning, #d29922)', errorColor: 'var(--danger, #e5484d)',
  successColor: 'var(--tool-ok, var(--accent))', density: 'comfortable', technicalDetailsExpanded: false,
  noticePlacements: ['inline', 'timeline'], retryCountdownStyle: 'seconds', showProviderIds: false, showEventIds: false, motion: 'none',
})

const LIFECYCLE_KIND_IDS = Object.freeze([
  'lifecycle.retry', 'lifecycle.compact', 'lifecycle.rewind', 'lifecycle.suspended', 'lifecycle.recovered',
  'system.notice', 'system.error',
] as const)

export const BUILTIN_LIFECYCLE_RENDER_KINDS: readonly RenderKindDefinition[] = Object.freeze(
  LIFECYCLE_KIND_IDS.map(id => Object.freeze({
    id, category: id.startsWith('system.') ? 'system' : 'lifecycle', fallbackKind: 'content.unknown', priority: 1000,
    fixture: id === 'system.error'
      ? { userSummary: 'fixture error', recoverability: 'none' }
      : id === 'system.notice'
        ? { code: 'fixture.notice', message: 'fixture notice', eventId: 'fixture-notice', sequence: 0, level: 'info' }
        : { history: [] },
    defaultTokens: LIFECYCLE_DEFAULT_TOKENS, settingsSchemaVersion: 1, settings: LIFECYCLE_SETTINGS,
    validateInput: input => id === 'system.error'
      ? isValidNormalizedErrorInput(input)
      : id === 'system.notice' ? isValidSystemNoticeInput(input) : isValidLifecycleStateInput(input),
  } satisfies RenderKindDefinition)),
)

/** A07/DIC-A07-01: semantic kinds are catalog entries, not event.type values. */
export const BUILTIN_SEMANTIC_RENDER_KINDS = Object.freeze([
  { id: 'tool.read', category: 'tool' },
  { id: 'tool.search', category: 'tool' },
  { id: 'tool.fetch', category: 'tool' },
  { id: 'content.memory', category: 'content' },
  { id: 'activity.subagent', category: 'activity' },
] as const)

const definitions: Array<{
  id: string
  kind: 'ansi' | 'spinner' | 'content-part' | 'plan' | 'footer'
  provider: AnsiProvider | SpinnerProvider | ContentPartProvider | PlanProvider | FooterProvider
}> = [
  {
    id: 'core.renderer.ansi',
    kind: 'ansi',
    provider: {
      providerId: 'core.renderer.ansi',
      render: text => new Anser().ansiToHtml(Anser.escapeForHtml(text)),
    } satisfies AnsiProvider,
  },
  {
    id: 'core.renderer.spinner',
    kind: 'spinner',
    provider: {
      providerId: 'core.renderer.spinner',
      resolve: (preset, custom) => resolveSpinnerFramesBuiltin(preset as never, custom),
    } satisfies SpinnerProvider,
  },
  {
    id: CORE_RENDERER_CONTENT_PART_PLUGIN_ID,
    kind: 'content-part',
    provider: {
      providerId: CORE_RENDERER_CONTENT_PART_PLUGIN_ID,
      partId: 'assistant',
      label: 'Assistant Markdown',
    } satisfies ContentPartProvider,
  },
  {
    id: 'core.renderer.plan',
    kind: 'plan',
    provider: {
      providerId: 'core.renderer.plan',
      planKind: 'task-tree',
      label: 'TaskTree',
    } satisfies PlanProvider,
  },
  {
    id: 'core.renderer.footer',
    kind: 'footer',
    provider: {
      providerId: 'core.renderer.footer',
      footerKind: 'generation-footer',
      label: 'GenerationFooter',
    } satisfies FooterProvider,
  },
]

export function createBuiltinRendererContentPluginDefinitions(): BuiltinPluginDefinition[] {
  const content = definitions.map(definition => ({
    id: definition.id,
    activate: ({ renderer }) => {
      if (definition.id === 'core.renderer.ansi') {
        for (const semantic of BUILTIN_SEMANTIC_RENDER_KINDS) {
          // tool.* 的唯一 catalog authority 是 toolRenderKindCatalog；这里仅保留
          // A07/DIC 清单，避免同一 product activation 重复注册低信息占位 kind。
          if (semantic.category === 'tool') continue
          renderer.registerRenderKind({
          ...semantic,
          fallbackKind: semantic.id.startsWith('tool.') ? 'tool.generic' : 'content.unknown',
          priority: 900,
          fixture: { semanticKind: semantic.id },
          defaultTokens: {},
          settingsSchemaVersion: 1,
          validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
            && (input as Record<string, unknown>).semanticKind === semantic.id,
          })
        }
        for (const lifecycleKind of BUILTIN_LIFECYCLE_RENDER_KINDS) renderer.registerRenderKind(lifecycleKind)
      }
      // C00 owns the canonical content.ansi declaration. The provider keeps
      // its legacy `ansi` alias but must not publish a second kind identity.
      if (definition.kind !== 'ansi') {
        renderer.registerRenderKind(definition.kind === 'plan' ? BUILTIN_PLAN_RENDER_KIND : {
          id: `content.${definition.kind}`,
          aliases: [definition.kind],
          category: 'content',
          fallbackKind: 'content.unknown',
          priority: 1000,
          fixture: {},
          defaultTokens: {},
          settingsSchemaVersion: 1,
          validateInput: () => true,
        })
      }
      renderer.registerContentRenderer({
        id: `${definition.id}.provider`,
        kind: definition.kind,
        provider: definition.provider,
        priority: 1000,
        fallback: true,
        canRender: input => input.kind === definition.kind,
        onError: () => 'fallback',
      })
    },
  } satisfies BuiltinPluginDefinition))

  return [
    {
      id: 'core.renderer.code-highlight',
      activate: ({ renderer }) => {
        renderer.registerCodeHighlighter({
          id: 'core.renderer.code-highlight',
          priority: 1000,
          fallback: true,
          canRender: ({ language }) => language.trim().length > 0,
          onError: () => 'fallback',
          highlight: async (language, code) => {
            const { highlightCodeBuiltin } = await import('../../../components/chat/codeHighlight.ts')
            return highlightCodeBuiltin(language, code)
          },
        })
      },
    },
    ...content,
  ]
}
