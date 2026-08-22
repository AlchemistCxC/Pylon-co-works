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
  'content.reasoning',
  'content.redacted-reasoning',
  'content.file-reference',
  'content.file-selection',
  'content.resource',
  'content.image',
  'content.audio',
  'content.video',
  'content.search-result',
  'content.link',
  'content.diff',
  'diagnostic.lsp',
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

  it('publishes concrete C00 settings schemas instead of version-only placeholders', async () => {
    const { ensureBuiltinTextRenderKinds } = await import('../textRenderKindCatalog.ts')
    await ensureBuiltinTextRenderKinds()
    const kinds = new Map(getRendererRegistry().snapshot().renderKinds.map(entry => [entry.value.id, entry.value]))

    const markdown = kinds.get('content.markdown')!
    expect(markdown.settings?.schemaVersion).toBe(markdown.settingsSchemaVersion)
    expect(markdown.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toEqual(
      expect.arrayContaining(['fontFamily', 'fontSize', 'lineHeight', 'maxWidth', 'linkStyle']),
    )

    const code = kinds.get('content.code')!
    expect(code.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toEqual(
      expect.arrayContaining(['wrap', 'maxLines', 'showLanguage', 'showCopyButton', 'palette']),
    )
    expect(code.defaultTokens).toMatchObject({ wrap: 'soft', maxLines: 400, showLanguage: true, showCopyButton: true })

    const ansi = kinds.get('content.ansi')!
    expect(ansi.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toEqual(
      expect.arrayContaining(['wrap', 'maxLines', 'background', 'palette']),
    )
  })

  it('publishes concrete C01 reasoning appearance and behaviour settings', async () => {
    const { ensureBuiltinTextRenderKinds } = await import('../textRenderKindCatalog.ts')
    await ensureBuiltinTextRenderKinds()
    const kinds = new Map(getRendererRegistry().snapshot().renderKinds.map(entry => [entry.value.id, entry.value]))

    for (const id of ['content.reasoning', 'content.redacted-reasoning'] as const) {
      const kind = kinds.get(id)!
      expect(kind.settings?.schemaVersion).toBe(kind.settingsSchemaVersion)
      expect(kind.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toEqual(
        expect.arrayContaining([
          'foreground', 'background', 'borderColor', 'fontSize', 'lineHeight',
          'defaultCollapsed', 'maxHeight', 'runningAnimation', 'showDuration',
        ]),
      )
      expect(kind.defaultTokens).toMatchObject({
        defaultCollapsed: true,
        maxHeight: 320,
        runningAnimation: 'pulse',
        showDuration: true,
      })
    }
  })

  it('validates C01 reasoning state and rejects redacted payloads that carry raw text', async () => {
    const { ensureBuiltinTextRenderKinds } = await import('../textRenderKindCatalog.ts')
    await ensureBuiltinTextRenderKinds()
    const kinds = new Map(getRendererRegistry().snapshot().renderKinds.map(entry => [entry.value.id, entry.value]))
    const reasoning = kinds.get('content.reasoning')!
    const redacted = kinds.get('content.redacted-reasoning')!

    expect(reasoning.validateInput({ text: 'delta', state: 'running' })).toBe(true)
    expect(reasoning.validateInput({ text: 'done', state: 'complete', durationMs: 100 })).toBe(true)
    expect(reasoning.validateInput({ text: 'bad duration', state: 'complete', durationMs: Number.NaN })).toBe(false)
    expect(reasoning.validateInput({ text: 'bad duration', state: 'complete', durationMs: -1 })).toBe(false)
    expect(reasoning.validateInput({ text: 'bad duration', state: 'complete', durationMs: '100' })).toBe(false)
    expect(reasoning.validateInput({ text: '', state: 'missing' })).toBe(true)
    expect(reasoning.validateInput({ text: 'bad', state: 'redacted' })).toBe(false)
    expect(reasoning.validateInput({ text: 'bad', state: 'unknown' })).toBe(false)
    expect(redacted.validateInput({ reason: 'provider_policy' })).toBe(true)
    expect(redacted.validateInput({ reason: 'provider_policy', text: 'private' })).toBe(false)
  })

  it('publishes the complete C02 file family with concrete appearance and behaviour settings', async () => {
    const { ensureBuiltinTextRenderKinds } = await import('../textRenderKindCatalog.ts')
    await ensureBuiltinTextRenderKinds()
    const kinds = new Map(getRendererRegistry().snapshot().renderKinds.map(entry => [entry.value.id, entry.value]))

    for (const id of [
      'content.file-reference', 'content.file-selection', 'content.document', 'content.resource',
    ] as const) {
      const kind = kinds.get(id)!
      expect(kind.settings?.schemaVersion).toBe(kind.settingsSchemaVersion)
      expect(kind.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toEqual(
        expect.arrayContaining([
          'foreground', 'mutedForeground', 'background', 'borderColor', 'fontSize', 'iconSize',
          'maxWidth', 'maxHeight', 'pathCollapse', 'previewLines', 'showAbsolutePath',
          'showMetadata', 'fileTypePalette', 'groupLayout',
        ]),
      )
      expect(kind.defaultTokens).toMatchObject({
        pathCollapse: 'middle',
        previewLines: 12,
        showAbsolutePath: true,
        showMetadata: true,
        groupLayout: 'stack',
      })
    }
  })

  it('validates C02 canonical boundaries without admitting raw binary payloads', async () => {
    const { ensureBuiltinTextRenderKinds } = await import('../textRenderKindCatalog.ts')
    await ensureBuiltinTextRenderKinds()
    const kinds = new Map(getRendererRegistry().snapshot().renderKinds.map(entry => [entry.value.id, entry.value]))

    expect(kinds.get('content.file-reference')!.validateInput({ path: 'C:\\work\\a.ts', size: 42 })).toBe(true)
    expect(kinds.get('content.file-reference')!.validateInput({ path: '   ' })).toBe(false)
    expect(kinds.get('content.file-reference')!.validateInput({ path: '/a', size: Number.NaN })).toBe(false)
    expect(kinds.get('content.file-selection')!.validateInput({ path: '/a', selection: {} })).toBe(false)
    expect(kinds.get('content.file-selection')!.validateInput({ path: '/a', selection: { start: { line: 2 }, end: { line: 1 } } })).toBe(false)
    expect(kinds.get('content.document')!.validateInput({ title: 'spec', text: 'safe' })).toBe(true)
    expect(kinds.get('content.document')!.validateInput({ title: 'spec', text: '' })).toBe(false)
    expect(kinds.get('content.document')!.validateInput({ title: 'spec', blob: 'private' })).toBe(false)
    expect(kinds.get('content.resource')!.validateInput({ uri: '   ' })).toBe(false)
    expect(kinds.get('content.resource')!.validateInput({ uri: 'mcp://safe', blob: 'private' })).toBe(false)
  })

  it('publishes concrete C03 media settings with safe playback defaults', async () => {
    const { ensureBuiltinTextRenderKinds } = await import('../textRenderKindCatalog.ts')
    await ensureBuiltinTextRenderKinds()
    const kinds = new Map(getRendererRegistry().snapshot().renderKinds.map(entry => [entry.value.id, entry.value]))

    for (const id of ['content.image', 'content.audio', 'content.video'] as const) {
      const kind = kinds.get(id)!
      expect(kind.settings?.schemaVersion).toBe(kind.settingsSchemaVersion)
      expect(kind.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toEqual(
        expect.arrayContaining([
          'foreground', 'mutedForeground', 'background', 'borderColor', 'maxWidth', 'maxHeight',
          'fit', 'radius', 'defaultExpanded', 'showCaption', 'showDownload', 'autoplay',
          'controls', 'transcriptStyle', 'showMetadata',
        ]),
      )
      expect(kind.defaultTokens).toMatchObject({
        fit: 'contain',
        defaultExpanded: true,
        showCaption: true,
        showDownload: true,
        autoplay: false,
        controls: true,
        transcriptStyle: 'panel',
        showMetadata: true,
      })
    }
  })

  it('validates the C03 canonical source contract instead of private renderer fields', async () => {
    const { ensureBuiltinTextRenderKinds } = await import('../textRenderKindCatalog.ts')
    await ensureBuiltinTextRenderKinds()
    const kinds = new Map(getRendererRegistry().snapshot().renderKinds.map(entry => [entry.value.id, entry.value]))

    expect(kinds.get('content.image')!.validateInput({
      source: 'iVBORw0KGgo=', sourceKind: 'base64', mimeType: 'image/png', width: 640, height: 480,
    })).toBe(true)
    expect(kinds.get('content.audio')!.validateInput({
      source: '/media/voice.wav', sourceKind: 'path', mimeType: 'audio/wav', durationMs: 1_200,
    })).toBe(true)
    expect(kinds.get('content.video')!.validateInput({
      source: 'blob:https://app.test/video-1', sourceKind: 'blob', mimeType: 'video/mp4',
    })).toBe(true)
    expect(kinds.get('content.image')!.validateInput({ base64: 'private-renderer-field', mimeType: 'image/png' })).toBe(false)
    expect(kinds.get('content.audio')!.validateInput({ source: 'https://safe.test/image.png', mimeType: 'image/png' })).toBe(false)
    expect(kinds.get('content.video')!.validateInput({ source: 'javascript:alert(1)', sourceKind: 'url' })).toBe(false)
  })
})
