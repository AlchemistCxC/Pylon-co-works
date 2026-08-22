/**
 * C00：文本族 render kind catalog——message.user/assistant、content.text/markdown/code/ansi。
 *
 * kind 是内容契约（A07 catalog），不等同 renderer 实现；Solid surface 与 React
 * generic fallback 都是这些 kind 的 Slot。ensureBuiltinTextRenderKinds 幂等注册，
 * 供内置 Suite 组装与设置页 schema 生成消费。
 */
import type { RenderKindDefinition } from '../../plugin-runtime/renderers/rendererTypes.ts'
import type { RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import {
  isNonEmptyContentLocation,
  isOptionalNonNegativeFiniteNumber,
  isValidFileSelection,
} from '../workbench/content/fileContentValidation.ts'
import { isValidMediaContentInput } from '../workbench/content/mediaContentValidation.ts'

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

const FILE_CONTENT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '文件与资源外观', layout: 'grid', fields: [
        { key: 'foreground', label: '主文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'mutedForeground', label: '次要文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 28, step: 1, unit: 'px', default: 13 },
        { key: 'iconSize', label: '图标尺寸', type: 'number', presentation: 'slider+input', min: 12, max: 40, step: 1, unit: 'px', default: 18 },
        { key: 'maxWidth', label: '最大宽度', type: 'number', presentation: 'slider+input', min: 240, max: 1600, step: 20, unit: 'px', default: 960 },
        { key: 'fileTypePalette', label: '文件类型色板', type: 'choice', presentation: 'segmented', options: [
          { value: 'auto', label: '自动' }, { value: 'neutral', label: '中性' }, { value: 'accent', label: '强调' },
        ], default: 'auto' },
      ],
    },
    {
      id: 'behaviour', label: '文件与资源行为', layout: 'grid', fields: [
        { key: 'pathCollapse', label: '路径折叠', type: 'choice', presentation: 'select', options: [
          { value: 'full', label: '完整' }, { value: 'middle', label: '中间折叠' }, { value: 'basename', label: '仅文件名' },
        ], default: 'middle' },
        { key: 'previewLines', label: '预览行数', type: 'number', presentation: 'slider+input', min: 1, max: 200, step: 1, default: 12 },
        { key: 'maxHeight', label: '最大高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 360 },
        { key: 'showAbsolutePath', label: '显示完整来源', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showMetadata', label: '显示 metadata', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'groupLayout', label: '卡片布局', type: 'choice', presentation: 'segmented', options: [
          { value: 'stack', label: '纵向' }, { value: 'grid', label: '网格' },
        ], default: 'stack' },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const FILE_CONTENT_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text)',
  mutedForeground: 'var(--text-dim)',
  background: 'transparent',
  borderColor: 'var(--border)',
  fontSize: 13,
  iconSize: 18,
  maxWidth: 960,
  maxHeight: 360,
  pathCollapse: 'middle',
  previewLines: 12,
  showAbsolutePath: true,
  showMetadata: true,
  fileTypePalette: 'auto',
  groupLayout: 'stack',
})

const MEDIA_CONTENT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '媒体外观', layout: 'grid', fields: [
        { key: 'foreground', label: '主文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'mutedForeground', label: '次要文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'maxWidth', label: '最大内联宽度', type: 'number', presentation: 'slider+input', min: 160, max: 1600, step: 20, unit: 'px', default: 960 },
        { key: 'maxHeight', label: '最大内联高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 640 },
        { key: 'fit', label: '适配方式', type: 'choice', presentation: 'segmented', options: [
          { value: 'contain', label: '完整显示' }, { value: 'cover', label: '填满裁切' }, { value: 'original', label: '原始尺寸' },
        ], default: 'contain' },
        { key: 'radius', label: '圆角', type: 'number', presentation: 'slider+input', min: 0, max: 32, step: 1, unit: 'px', default: 8 },
        { key: 'transcriptStyle', label: '转写样式', type: 'choice', presentation: 'select', options: [
          { value: 'panel', label: '独立面板' }, { value: 'plain', label: '纯文本' }, { value: 'compact', label: '紧凑' },
        ], default: 'panel' },
      ],
    },
    {
      id: 'behaviour', label: '媒体行为', layout: 'grid', fields: [
        { key: 'defaultExpanded', label: '默认展开', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showCaption', label: '显示说明', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showDownload', label: '显示下载动作', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'autoplay', label: '自动播放', description: '默认关闭，避免未经用户操作播放媒体。', type: 'boolean', presentation: 'toggle', default: false },
        { key: 'controls', label: '显示播放控件', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showMetadata', label: '显示 metadata', type: 'boolean', presentation: 'toggle', default: true },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const MEDIA_CONTENT_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text)',
  mutedForeground: 'var(--text-dim)',
  background: 'transparent',
  borderColor: 'var(--border)',
  maxWidth: 960,
  maxHeight: 640,
  fit: 'contain',
  radius: 8,
  defaultExpanded: true,
  showCaption: true,
  showDownload: true,
  autoplay: false,
  controls: true,
  transcriptStyle: 'panel',
  showMetadata: true,
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
    defaultTokens: FILE_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: FILE_CONTENT_SETTINGS,
    // C02：path 必须非空；Windows/URI 形态不在此层互转
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && isNonEmptyContentLocation((input as Record<string, unknown>).path)
      && isOptionalNonNegativeFiniteNumber((input as Record<string, unknown>).size),
  },
  {
    id: 'content.file-selection',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { path: '/fixture/main.ts', selection: { start: { line: 1 }, end: { line: 4 } }, language: 'ts' },
    defaultTokens: FILE_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: FILE_CONTENT_SETTINGS,
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && isNonEmptyContentLocation((input as Record<string, unknown>).path)
      && isValidFileSelection((input as Record<string, unknown>).selection),
  },
  {
    id: 'content.document',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { title: 'fixture-spec.md', mimeType: 'text/markdown', text: '# Fixture document' },
    defaultTokens: FILE_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: FILE_CONTENT_SETTINGS,
    // C02：document 是 renderer semantic kind；当前 provider SOURCE-ONLY 附件不在此层补造。
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && ['path', 'uri', 'text'].some(key => isNonEmptyContentLocation((input as Record<string, unknown>)[key]))
      && typeof (input as Record<string, unknown>).blob === 'undefined',
  },
  {
    id: 'content.resource',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { uri: 'file:///fixture/spec.pdf', mimeType: 'application/pdf', hasBlob: true },
    defaultTokens: FILE_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: FILE_CONTENT_SETTINGS,
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && isNonEmptyContentLocation((input as Record<string, unknown>).uri)
      && typeof (input as Record<string, unknown>).blob === 'undefined',
  },
  {
    id: 'content.diff',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { path: '/fixture/a.ts', status: 'modified', oldText: 'a\n', newText: 'b\n' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    // C06：结构化 diff 可重建；unified/rawPatch 只作审计
    validateInput: (input: unknown) => typeof input === 'object' && input !== null && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).path === 'string',
  },
  {
    id: 'diagnostic.lsp',
    category: 'diagnostic',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { severity: 'error', code: 'TS1', source: 'typescript', message: 'fixture lsp diagnostic', path: '/fixture/a.ts' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    validateInput: (input: unknown) => typeof input === 'object' && input !== null && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).message === 'string'
      && typeof (input as Record<string, unknown>).path === 'string',
  },
  {
    id: 'content.search-result',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { query: 'fixture query', total: 1, results: [{ source: '/fixture/a.ts', rank: 1, snippet: 'fixture snippet' }] },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    // C05：results 必须是非空数组；highlights 是纯文本数字 range
    validateInput: (input: unknown) => typeof input === 'object' && input !== null && !Array.isArray(input)
      && Array.isArray((input as Record<string, unknown>).results),
  },
  {
    id: 'content.link',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { url: 'https://fixture.example.com/guide', title: 'fixture link' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    validateInput: (input: unknown) => typeof input === 'object' && input !== null && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).url === 'string',
  },
  ...(['image', 'audio', 'video'] as const).map(kind => ({
    id: `content.${kind}`,
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: kind === 'image'
      ? { source: 'https://fixture.example.com/pic.png', mimeType: 'image/png', alt: 'fixture image' }
      : { source: `https://fixture.example.com/clip.${kind === 'audio' ? 'wav' : 'mp4'}`, mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}` },
    defaultTokens: MEDIA_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: MEDIA_CONTENT_SETTINGS,
    // C03：单一 canonical source；path/base64/blob 必须显式 sourceKind。
    validateInput: (input: unknown) => isValidMediaContentInput(input, kind),
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
