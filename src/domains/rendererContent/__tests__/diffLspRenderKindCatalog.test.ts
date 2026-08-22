import { describe, expect, it } from 'vitest'
import { settingFieldKey } from '../../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../textRenderKindCatalog.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../toolRenderKindCatalog.ts'
import { BUILTIN_SOLID_CONTENT_KINDS, createBuiltinSolidContentSlot } from '../../../renderers/solid-workbench/builtinSolidRendererSuite.ts'

describe('C06 diff and LSP render-kind catalog', () => {
  it('declares real appearance settings and validates the same normalized contracts as the journal schema', () => {
    const diff = BUILTIN_TEXT_RENDER_KINDS.find(kind => kind.id === 'content.diff')
    const lsp = BUILTIN_TEXT_RENDER_KINDS.find(kind => kind.id === 'diagnostic.lsp')
    const keys = (kind: NonNullable<typeof diff>) => kind.settings?.groups.flatMap(group => group.fields.map(settingFieldKey)) ?? []

    expect(keys(diff!)).toEqual(expect.arrayContaining([
      'view', 'contextLines', 'lineNumbers', 'wordDiff', 'addedColor', 'removedColor',
      'maxHeight', 'wrap', 'defaultExpanded', 'showMetadata', 'showRaw',
    ]))
    expect(keys(lsp!)).toEqual(expect.arrayContaining([
      'severityPalette', 'maxHeight', 'showSource', 'showCode', 'showRelated', 'showMetadata',
    ]))
    expect(diff?.validateInput({ path: '/a.ts', lines: [{ kind: 'added', text: 'new' }] })).toBe(true)
    expect(diff?.validateInput({ path: '/a.ts', lines: [{ kind: 'vendor', text: 'bad' }] })).toBe(false)
    expect(lsp?.validateInput({ message: 'bad call', path: '/a.ts' })).toBe(true)
    expect(lsp?.validateInput({ message: 'missing path' })).toBe(false)
  })

  it('publishes diff and LSP through the built-in Suite base Slot', () => {
    expect(BUILTIN_SOLID_CONTENT_KINDS).toEqual(expect.arrayContaining(['content.diff', 'diagnostic.lsp']))
    const slot = createBuiltinSolidContentSlot()
    expect(slot.targetSuites).toEqual(['builtin.solid'])
    expect(slot.kinds).toEqual(expect.arrayContaining(['content.diff', 'diagnostic.lsp']))
    expect(slot.canRender({ nodeId: 'lsp', kind: 'diagnostic.lsp', revision: 1, payload: {} })).toBe(true)
  })

  it('publishes edit as the semantic kind while preserving write as an action', () => {
    const edit = BUILTIN_TOOL_RENDER_KINDS.find(kind => kind.id === 'tool.edit')

    expect(edit?.fallbackKind).toBe('tool.generic')
    expect(edit?.validateInput({
      id: 'write-1', name: 'Write', canonicalName: 'Write', semanticKind: 'tool.edit',
      kind: 'edit', action: 'write', status: 'completed',
    })).toBe(true)
    expect(BUILTIN_TOOL_RENDER_KINDS.some(kind => kind.id === 'tool.write')).toBe(false)
    expect(createBuiltinSolidContentSlot().kinds).toContain('tool.edit')
  })
})
