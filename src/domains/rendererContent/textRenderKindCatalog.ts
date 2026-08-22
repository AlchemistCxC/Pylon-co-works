/**
 * C00：文本族 render kind catalog——message.user/assistant、content.text/markdown/code/ansi。
 *
 * kind 是内容契约（A07 catalog），不等同 renderer 实现；Solid surface 与 React
 * generic fallback 都是这些 kind 的 Slot。ensureBuiltinTextRenderKinds 幂等注册，
 * 供内置 Suite 组装与设置页 schema 生成消费。
 */
import type { RenderKindDefinition } from '../../plugin-runtime/renderers/rendererTypes.ts'
import type { RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'

const FONT_OPTIONS = Object.freeze([
  { value: 'inherit', label: '跟随界面' },
  { value: 'sans', label: '无衬线' },
  { value: 'serif', label: '衬线' },
  { value: 'mono', label: '等宽' },
])

const TEXT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{
    id: 'typography', label: '文本排版', layout: 'grid', fields: [
      { key: 'fontFamily', label: '字体', type: 'choice', presentation: 'select', options: FONT_OPTIONS, default: 'inherit' },
      { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 32, step: 1, unit: 'px', default: 14 },
      { key: 'lineHeight', label: '行高', type: 'number', presentation: 'slider+input', min: 1, max: 2.5, step: 0.1, default: 1.6 },
      { key: 'maxWidth', label: '最大宽度', type: 'number', presentation: 'slider+input', min: 240, max: 1600, step: 20, unit: 'px', default: 760 },
    ],
  }],
} satisfies RendererSettingsSchema)

const MARKDOWN_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{
    id: 'typography', label: 'Markdown 排版', layout: 'grid', fields: [
      ...TEXT_SETTINGS.groups[0].fields,
      { key: 'linkStyle', label: '链接样式', type: 'choice', presentation: 'segmented', options: [
        { value: 'underline', label: '下划线' },
        { value: 'plain', label: '简洁' },
      ], default: 'underline' },
    ],
  }],
} satisfies RendererSettingsSchema)

const CODE_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{
    id: 'code', label: '代码块', layout: 'grid', fields: [
      { key: 'fontFamily', label: '字体', type: 'choice', presentation: 'select', options: [
        { value: 'mono', label: '等宽' }, { value: 'inherit', label: '跟随界面' },
      ], default: 'mono' },
      { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 28, step: 1, unit: 'px', default: 13 },
      { key: 'lineHeight', label: '行高', type: 'number', presentation: 'slider+input', min: 1, max: 2.5, step: 0.1, default: 1.5 },
      { key: 'wrap', label: '换行', type: 'choice', presentation: 'segmented', options: [
        { value: 'soft', label: '自动换行' }, { value: 'none', label: '不换行' },
      ], default: 'soft' },
      { key: 'maxLines', label: '折叠行数', type: 'number', presentation: 'slider+input', min: 20, max: 2000, step: 20, unit: '行', default: 400 },
      { key: 'showLanguage', label: '显示语言', type: 'boolean', presentation: 'toggle', default: true },
      { key: 'showCopyButton', label: '显示复制按钮', type: 'boolean', presentation: 'toggle', default: true },
      { key: 'palette', label: '配色', type: 'choice', presentation: 'select', options: [
        { value: 'auto', label: '跟随主题' }, { value: 'dark', label: '深色' }, { value: 'light', label: '浅色' },
      ], optionTarget: 'kind.content.code.palette', default: 'auto' },
    ],
  }],
} satisfies RendererSettingsSchema)

const ANSI_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{
    id: 'terminal', label: 'ANSI 输出', layout: 'grid', fields: [
      { key: 'fontFamily', label: '字体', type: 'choice', presentation: 'select', options: [
        { value: 'mono', label: '等宽' }, { value: 'inherit', label: '跟随界面' },
      ], default: 'mono' },
      { key: 'wrap', label: '换行', type: 'choice', presentation: 'segmented', options: [
        { value: 'soft', label: '自动换行' }, { value: 'none', label: '不换行' },
      ], default: 'soft' },
      { key: 'maxLines', label: '最大显示行数', type: 'number', presentation: 'slider+input', min: 20, max: 5000, step: 20, unit: '行', default: 800 },
      { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
      { key: 'palette', label: '16 色调色板', type: 'choice', presentation: 'select', options: [
        { value: 'terminal', label: '终端默认' }, { value: 'accessible', label: '高对比度' }, { value: 'dim', label: '柔和' },
      ], optionTarget: 'kind.content.ansi.palette', default: 'terminal' },
    ],
  }],
} satisfies RendererSettingsSchema)

const REASONING_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '推理外观', layout: 'grid', fields: [
        { key: 'foreground', label: '文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'color-mix(in srgb, var(--border) 72%, transparent)' },
        { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 28, step: 1, unit: 'px', default: 13 },
        { key: 'lineHeight', label: '行高', type: 'number', presentation: 'slider+input', min: 1, max: 2.5, step: 0.1, default: 1.6 },
      ],
    },
    {
      id: 'behaviour', label: '推理行为', layout: 'grid', fields: [
        { key: 'defaultCollapsed', label: '完成后默认折叠', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'maxHeight', label: '正文最大高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 320 },
        { key: 'runningAnimation', label: '思考中动效', type: 'choice', presentation: 'segmented', options: [
          { value: 'pulse', label: '呼吸' }, { value: 'shimmer', label: '流光' }, { value: 'none', label: '关闭' },
        ], default: 'pulse' },
        { key: 'showDuration', label: '完成后显示时长', type: 'boolean', presentation: 'toggle', default: true },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const REASONING_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text-dim)',
  background: 'transparent',
  borderColor: 'color-mix(in srgb, var(--border) 72%, transparent)',
  fontSize: 13,
  lineHeight: 1.6,
  defaultCollapsed: true,
  maxHeight: 320,
  runningAnimation: 'pulse',
  showDuration: true,
})

function textPayload(input: unknown): input is { readonly text: string } {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    && typeof (input as Record<string, unknown>).text === 'string'
}

const messageRoleKind = (id: 'message.user' | 'message.assistant'): RenderKindDefinition => ({
  id,
  category: 'message',
  // role framing 失败时降级为通用文本（内容仍可见）；catalog 禁止 fallback 环，
  // 不能与对侧 role 互指。
  fallbackKind: 'content.text',
  priority: 100,
  fixture: { role: id === 'message.user' ? 'user' : 'assistant', parts: [{ kind: 'text', text: `fixture ${id}` }] },
  defaultTokens: {},
  settingsSchemaVersion: 1,
  validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
    && (input as Record<string, unknown>).role === (id === 'message.user' ? 'user' : 'assistant'),
})

export const BUILTIN_TEXT_RENDER_KINDS: readonly RenderKindDefinition[] = [
  messageRoleKind('message.user'),
  messageRoleKind('message.assistant'),
  {
    id: 'content.text',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: 'fixture content.text' },
    defaultTokens: { fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6, maxWidth: 760 },
    settingsSchemaVersion: 1,
    settings: TEXT_SETTINGS,
    validateInput: input => textPayload(input) && input.text.length > 0,
  },
  {
    id: 'content.markdown',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: '# fixture markdown\n\n- item **bold**' },
    defaultTokens: { fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6, maxWidth: 760, linkStyle: 'underline' },
    settingsSchemaVersion: 1,
    settings: MARKDOWN_SETTINGS,
    // 非空 text；流式起点的空串由组件层处理，不进入 kind 校验
    validateInput: input => textPayload(input) && input.text.length > 0,
  },
  {
    id: 'content.reasoning',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: 'fixture reasoning delta', state: 'running' },
    defaultTokens: REASONING_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: REASONING_SETTINGS,
    // C01：state ∈ running|complete|missing；redacted 走独立 kind
    validateInput: input => textPayload(input)
      && ['running', 'complete', 'missing'].includes(String((input as Record<string, unknown>).state))
      && ((input as Record<string, unknown>).durationMs === undefined
        || (typeof (input as Record<string, unknown>).durationMs === 'number'
          && Number.isFinite((input as Record<string, unknown>).durationMs)
          && Number((input as Record<string, unknown>).durationMs) >= 0)),
  },
  {
    id: 'content.redacted-reasoning',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { reason: 'provider_redacted' },
    defaultTokens: REASONING_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: REASONING_SETTINGS,
    // C01：redacted 只携带原因，不携带内容——validateInput 拒绝带正文的输入
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).reason === 'string'
      && typeof (input as Record<string, unknown>).text === 'undefined',
  },
  {
    id: 'content.file-reference',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { path: '/fixture/report.md', displayName: 'report.md' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    // C02：path 必须非空；Windows/URI 形态不在此层互转
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).path === 'string'
      && ((input as Record<string, unknown>).path as string).length > 0,
  },
  {
    id: 'content.file-selection',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { path: '/fixture/main.ts', selection: { start: { line: 1 }, end: { line: 4 } }, language: 'ts' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).path === 'string'
      && typeof (input as Record<string, unknown>).selection === 'object',
  },
  {
    id: 'content.resource',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { uri: 'file:///fixture/spec.pdf', mimeType: 'application/pdf', hasBlob: true },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).uri === 'string',
  },
  ...(['image', 'audio', 'video'] as const).map(kind => ({
    id: `content.${kind}`,
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: kind === 'image'
      ? { source: 'https://fixture.example.com/pic.png', mimeType: 'image/png', alt: 'fixture image' }
      : { source: `https://fixture.example.com/clip.${kind === 'audio' ? 'wav' : 'mp4'}`, mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}` },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    // C03：source/url/localPath/base64 至少一个来源字段；validateInput 不解析内容只验形态
    validateInput: (input: unknown) => typeof input === 'object' && input !== null && !Array.isArray(input)
      && ['source', 'url', 'localPath', 'base64'].some(key =>
        typeof (input as Record<string, unknown>)[key] === 'string'),
  })),
  {
    id: 'content.code',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: 'const answer = 42\n', language: 'ts' },
    defaultTokens: { fontFamily: 'mono', fontSize: 13, lineHeight: 1.5, wrap: 'soft', maxLines: 400, showLanguage: true, showCopyButton: true, palette: 'auto' },
    settingsSchemaVersion: 1,
    settings: CODE_SETTINGS,
    validateInput: input => textPayload(input) && input.text.length > 0,
  },
  {
    id: 'content.ansi',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: '\u001b[32mok\u001b[0m' },
    defaultTokens: { fontFamily: 'mono', wrap: 'soft', maxLines: 800, background: 'transparent', palette: 'terminal' },
    settingsSchemaVersion: 1,
    settings: ANSI_SETTINGS,
    validateInput: input => textPayload(input),
  },
]

let ensured = false

/**
 * 幂等把六个 kind 注册进当前 RendererRegistry 单例的 catalog。
 * 独立于任何 renderer/suite 注册——kind 先于实现存在，Slot 后挂。
 * message.user/assistant 互为 fallback，经 shadow transaction 原子提交，
 * 不出现"前者已注册、后备未注册"的中间态。
 */
export async function ensureBuiltinTextRenderKinds(): Promise<void> {
  if (ensured) return
  const { getRendererRegistry } = await import('../../plugin-runtime/runtimeServices.ts')
  const registry = getRendererRegistry()
  const owner = (await import('../../plugin-runtime/pluginIdentity.ts')).createPluginIdentity('core.renderer.text-kinds', 'builtin')
  const existing = new Set(registry.snapshot().renderKinds.map(entry => entry.value.id))
  const pending = BUILTIN_TEXT_RENDER_KINDS.filter(definition => !existing.has(definition.id))
  if (pending.length > 0) {
    const transaction = registry.beginShadowTransaction(owner, owner.key)
    try {
      for (const definition of pending) transaction.registerRenderKind(definition)
      transaction.validate()
      transaction.commit()
    } catch (error) {
      transaction.rollback()
      throw error
    }
  }
  ensured = true
}
