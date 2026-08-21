import { describe, expect, it } from 'vitest'
import { getRendererRegistry } from '../../../plugin-runtime/runtimeServices.ts'

/**
 * C00 RED：六个基础 render kind（message.user/assistant、content.text/markdown/code/ansi）
 * 的语义契约。kind 是内容契约，必须 namespaced、有 fallback、有 fixture 与 validateInput。
 */
const EXPECTED_KINDS = [
  'message.user',
  'message.assistant',
  'content.text',
  'content.markdown',
  'content.code',
  'content.ansi',
] as const

describe('C00 builtin render kind catalog', () => {
  it('registers all six kinds with fixture, fallback and semantic input validation', async () => {
    const { ensureBuiltinTextRenderKinds } = await import('../textRenderKindCatalog.ts')
    await ensureBuiltinTextRenderKinds()

    const registry = getRendererRegistry()
    expect(registry.snapshot().renderKinds.map(entry => entry.value.id)).toEqual(
      expect.arrayContaining([...EXPECTED_KINDS, 'content.unknown']),
    )
    for (const id of EXPECTED_KINDS) {
      const kind = registry.snapshot().renderKinds.find(entry => entry.value.id === id)?.value
      expect(kind, id).toBeDefined()
      expect(kind!.fixture).not.toBeNull()
      expect(typeof kind!.validateInput).toBe('function')
      if (id === 'message.user' || id === 'message.assistant') {
        // role framing 失败降级为通用文本（catalog 禁环，不与对侧互指）
        expect(kind!.fallbackKind, id).toBe('content.text')
      } else {
        expect(kind!.fallbackKind, id).toBe('content.unknown')
      }
    }
  })

  it('validates semantic input per kind: markdown/code require text payload, ansi requires string', async () => {
    const { ensureBuiltinTextRenderKinds } = await import('../textRenderKindCatalog.ts')
    await ensureBuiltinTextRenderKinds()
    const registry = getRendererRegistry()
    const kinds = new Map(registry.snapshot().renderKinds.map(entry => [entry.value.id, entry.value]))

    // markdown/code：payload 必须含非空 text
    expect(kinds.get('content.markdown')!.validateInput({ text: '# hi' })).toBe(true)
    expect(kinds.get('content.markdown')!.validateInput({ text: '' })).toBe(false)
    expect(kinds.get('content.markdown')!.validateInput({})).toBe(false)
    expect(kinds.get('content.code')!.validateInput({ text: 'x', language: 'ts' })).toBe(true)
    expect(kinds.get('content.code')!.validateInput({ text: 'x' })).toBe(true)
    expect(kinds.get('content.code')!.validateInput({ language: 'ts' })).toBe(false)
    // ansi：任意字符串（含空）都可渲染为空终端
    expect(kinds.get('content.ansi')!.validateInput({ text: '\u001b[31mred' })).toBe(true)
    expect(kinds.get('content.ansi')!.validateInput(42)).toBe(false)
    // message kinds：role framing
    expect(kinds.get('message.user')!.validateInput({ role: 'user', parts: [] })).toBe(true)
    expect(kinds.get('message.user')!.validateInput({ role: 'assistant' })).toBe(false)
  })
})
