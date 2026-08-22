/**
 * C00：文本族 render kind catalog——message.user/assistant、content.text/markdown/code/ansi。
 *
 * kind 是内容契约（A07 catalog），不等同 renderer 实现；Solid surface 与 React
 * generic fallback 都是这些 kind 的 Slot。ensureBuiltinTextRenderKinds 幂等注册，
 * 供内置 Suite 组装与设置页 schema 生成消费。
 */
import type { RenderKindDefinition } from '../../plugin-runtime/renderers/rendererTypes.ts'

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
    defaultTokens: {},
    settingsSchemaVersion: 1,
    validateInput: input => textPayload(input) && input.text.length > 0,
  },
  {
    id: 'content.markdown',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: '# fixture markdown\n\n- item **bold**' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    // 非空 text；流式起点的空串由组件层处理，不进入 kind 校验
    validateInput: input => textPayload(input) && input.text.length > 0,
  },
  {
    id: 'content.reasoning',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: 'fixture reasoning delta', state: 'running' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    // C01：state ∈ running|complete|missing；redacted 走独立 kind
    validateInput: input => textPayload(input)
      && ['running', 'complete', 'missing'].includes(String((input as Record<string, unknown>).state)),
  },
  {
    id: 'content.redacted-reasoning',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { reason: 'provider_redacted' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
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
  {
    id: 'content.code',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: 'const answer = 42\n', language: 'ts' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
    validateInput: input => textPayload(input) && input.text.length > 0,
  },
  {
    id: 'content.ansi',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: '\u001b[32mok\u001b[0m' },
    defaultTokens: {},
    settingsSchemaVersion: 1,
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
