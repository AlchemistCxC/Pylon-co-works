import { describe, expect, it } from 'vitest'
import {
  resolveDocumentOptionValue,
  resolveModelOptionEntries,
  type WorkbenchOptionEntry,
} from '../workbenchOptionCatalog.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../../domains/workbench/workbenchRuntime.ts'

function emptySnapshot(overrides: Partial<WorkbenchRuntimeSnapshot> = {}): WorkbenchRuntimeSnapshot {
  return {
    revision: 0, sessionId: null, status: 'idle', messages: [], generating: false,
    generationStart: 0, tokenCount: 0, summary: null, tasks: [],
    availableModels: [], activeModel: '', availableModes: [], activeMode: '',
    canAttach: false, promptImage: false, error: null, ...overrides,
  }
}

describe('Workbench option catalog', () => {
  it('reads the provider-selected reasoning value from normalized options', () => {
    expect(resolveDocumentOptionValue([
      {
        id: 'thought_level',
        label: '思考强度',
        value: 'high',
        schema: { options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }] },
      },
    ], 'reasoning')).toBe('high')
  })

  it('model candidates come from advertised surfaces only — no hardcoded fallback (issue #53)', () => {
    const entries = resolveModelOptionEntries(emptySnapshot())
    expect(entries).toEqual([])
    expect(entries.map(item => item.id)).not.toContain('deepseek-v4-flash')
    expect(entries.map(item => item.id)).not.toContain('deepseek-v4-pro')
  })

  it('keeps the selected draft visible when nothing is advertised', () => {
    const entries = resolveModelOptionEntries(emptySnapshot(), 'my-default-model')
    expect(entries.map(item => item.id)).toEqual(['my-default-model'])
  })

  it('unions session snapshot and agent-advertised entries with case-insensitive dedupe', () => {
    const agentAdvertised: readonly WorkbenchOptionEntry[] = [
      { id: 'SESSION-MODEL', label: '重名（首个来源胜出）' },
      { id: 'kimi-k2', label: 'Kimi K2' },
    ]
    const entries = resolveModelOptionEntries(
      emptySnapshot({ availableModels: ['session-model'] }),
      undefined,
      agentAdvertised,
    )
    expect(entries.map(item => item.id)).toEqual(['session-model', 'kimi-k2'])
    expect(entries.find(item => item.id === 'kimi-k2')?.label).toBe('Kimi K2')
    expect(entries.find(item => item.id === 'session-model')?.label).toBe('session-model')
  })

  it('ignores agent-advertised entries only when the caller does not pass them', () => {
    const entries = resolveModelOptionEntries(emptySnapshot({ availableModels: ['session-model'] }))
    expect(entries.map(item => item.id)).toEqual(['session-model'])
  })
})
