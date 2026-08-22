import { describe, expect, it } from 'vitest'
import {
  BUILTIN_TOOL_RENDER_KINDS,
  isToolInvocationSnapshotInput,
} from '../toolRenderKindCatalog.ts'

describe('C04 tool render kind catalog', () => {
  it('declares the complete generic lifecycle with tool.generic as the safe base', () => {
    const kinds = new Map(BUILTIN_TOOL_RENDER_KINDS.map(kind => [kind.id, kind]))

    expect([...kinds.keys()]).toEqual([
      'tool.generic',
      'tool.input',
      'tool.progress',
      'tool.output',
      'tool.error',
      'tool.read',
      'tool.search',
      'tool.fetch',
    ])
    expect(kinds.get('tool.generic')?.fallbackKind).toBe('content.unknown')
    for (const id of ['tool.input', 'tool.progress', 'tool.output', 'tool.error', 'tool.read', 'tool.search', 'tool.fetch']) {
      expect(kinds.get(id)?.fallbackKind).toBe('tool.generic')
    }
    expect(kinds.get('tool.generic')?.settings).toBeDefined()
    expect(kinds.get('tool.generic')?.fixture).toEqual(expect.objectContaining({
      id: expect.any(String),
      status: 'running',
      name: expect.any(String),
    }))
    expect(kinds.get('tool.input')?.fixture).toEqual(expect.objectContaining({ input: expect.any(Object) }))
    expect(kinds.get('tool.progress')?.fixture).toEqual(expect.objectContaining({ progress: expect.any(Object) }))
    expect(kinds.get('tool.output')?.fixture).toEqual(expect.objectContaining({
      status: 'completed', result: expect.objectContaining({ parts: expect.any(Array) }),
    }))
    expect(kinds.get('tool.error')?.fixture).toEqual(expect.objectContaining({
      status: 'failed', result: expect.objectContaining({
        error: expect.objectContaining({ userSummary: expect.any(String), recoverability: expect.any(String) }),
      }),
    }))
  })

  it('accepts provider-neutral snapshots and rejects legacy/provider raw objects', () => {
    expect(isToolInvocationSnapshotInput({
      id: 'call-1', name: 'Read', canonicalName: 'read', status: 'running',
      input: { path: '/workspace/a.ts' },
    })).toBe(true)
    expect(isToolInvocationSnapshotInput({ id: 'call-1', status: 'completed', result: { parts: [] } })).toBe(true)
    expect(isToolInvocationSnapshotInput({ id: '', status: 'running' })).toBe(false)
    expect(isToolInvocationSnapshotInput({ toolCallId: 'legacy', raw: { provider: 'acp' } })).toBe(false)
  })
})
