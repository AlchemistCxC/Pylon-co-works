import { describe, expect, it } from 'vitest'
import { BUILTIN_TEXT_RENDER_KINDS } from '../textRenderKindCatalog.ts'

describe('C15 render kind contracts', () => {
  const kinds = new Map(BUILTIN_TEXT_RENDER_KINDS.map(kind => [kind.id, kind]))

  it('publishes five strict kinds with C15-specific settings', () => {
    for (const id of ['content.memory', 'content.skill', 'content.mcp-resource', 'content.artifact', 'system.hook']) {
      const kind = kinds.get(id)
      expect(kind, id).toBeDefined()
      expect(kind!.fallbackKind).toBe('content.unknown')
      expect(kind!.validateInput(kind!.fixture)).toBe(true)
      expect(kind!.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toEqual(
        expect.arrayContaining(['categoryPalette', 'icon', 'metadataFields', 'unknownRawCollapsed']),
      )
    }
    expect(kinds.get('content.mcp-resource')!.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toContain('mcpServerBadge')
    expect(kinds.get('content.artifact')!.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toContain('artifactPreviewSize')
    expect(kinds.get('system.hook')!.settings?.groups.flatMap(group => group.fields).map(field => field.key)).toEqual(expect.arrayContaining(['defaultCollapsed', 'showDuration']))
  })

  it('does not admit another valid content family through a kind validator', () => {
    const artifact = { kind: 'artifact', artifactId: 'a', title: 'A', uri: 'artifact://a', version: 1 }
    expect(kinds.get('content.memory')!.validateInput(artifact)).toBe(false)
    expect(kinds.get('content.artifact')!.validateInput(artifact)).toBe(true)
    expect(kinds.get('system.hook')!.validateInput({
      phase: 'turn.completed', owner: { pluginId: 'plugin.audit', handlerId: 'after' },
      status: 'continued', durationMs: 12,
    })).toBe(true)
  })
})
