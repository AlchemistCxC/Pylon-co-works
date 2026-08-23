import { describe, expect, it } from 'vitest'
import { BUILTIN_SESSION_RENDER_KINDS } from '../sessionRenderKindCatalog.ts'

const ids = [
  'session.usage', 'session.budget', 'session.config', 'session.commands',
  'assist.prediction', 'assist.file-suggestions',
]

describe('C14 session / assist render kinds', () => {
  it('publishes the six replaceable kinds with settings and an unknown fallback', () => {
    expect(BUILTIN_SESSION_RENDER_KINDS.map(kind => kind.id)).toEqual(ids)
    for (const kind of BUILTIN_SESSION_RENDER_KINDS) {
      expect(kind.fallbackKind).toBe('content.unknown')
      expect(kind.settingsSchemaVersion).toBe(1)
      expect(kind.settings?.groups.length).toBeGreaterThan(0)
      expect(kind.validateInput(kind.fixture), `${kind.id} fixture`).toBe(true)
    }
  })

  it('validates first-class payloads and rejects dirty normalized fields', () => {
    const byId = new Map(BUILTIN_SESSION_RENDER_KINDS.map(kind => [kind.id, kind]))
    expect(byId.get('session.usage')!.validateInput({ inputTokens: 2, contextLimit: 100, currency: 'USD' })).toBe(true)
    expect(byId.get('session.usage')!.validateInput({ inputTokens: -1 })).toBe(false)
    expect(byId.get('session.budget')!.validateInput({ used: 9, limit: 10, exhausted: false })).toBe(true)
    expect(byId.get('session.budget')!.validateInput({ used: '9' })).toBe(false)
    expect(byId.get('session.commands')!.validateInput({ commands: [{ id: 'compact', name: '/compact', availability: true }] })).toBe(true)
    expect(byId.get('session.commands')!.validateInput({ commands: [{ name: '/compact' }] })).toBe(false)
    expect(byId.get('session.config')!.validateInput({ options: [{ id: 'model', label: 'Model', value: 'gpt', version: 2 }] })).toBe(true)
    expect(byId.get('session.config')!.validateInput({ options: [{ id: '', label: 'Model' }] })).toBe(false)
    expect(byId.get('session.config')!.validateInput({ options: [{
      id: 'vendor', label: 'Vendor', value: { mode: 'adaptive' }, valueType: 'provider.custom', editable: true,
    }] })).toBe(false)
    expect(byId.get('assist.prediction')!.validateInput({ files: [], prediction: { placeholder: 'continue', actions: [] } })).toBe(true)
    expect(byId.get('assist.file-suggestions')!.validateInput({ files: ['src/a.ts'] })).toBe(true)
    expect(byId.get('assist.file-suggestions')!.validateInput({ files: [42] })).toBe(false)
  })
})
