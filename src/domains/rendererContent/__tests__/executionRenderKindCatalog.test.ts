import { describe, expect, it } from 'vitest'
import { BUILTIN_EXECUTION_RENDER_KINDS, isProcessActivitySnapshotInput } from '../executionRenderKindCatalog.ts'
import { BUILTIN_SOLID_CONTENT_KINDS } from '../../../renderers/solid-workbench/builtinSolidRendererSuite.ts'

describe('C07 execution render kind catalog', () => {
  it('declares activity.process as a strict, configurable, Suite-owned kind', () => {
    const process = BUILTIN_EXECUTION_RENDER_KINDS.find(kind => kind.id === 'activity.process')!
    expect(process).toBeDefined()
    expect(process.category).toBe('activity')
    expect(process.fallbackKind).toBe('content.unknown')
    expect(process.settings?.schemaVersion).toBe(process.settingsSchemaVersion)
    expect(process.defaultTokens).toMatchObject({ showIdentity: true, retainedLines: 2000 })
    expect(BUILTIN_SOLID_CONTENT_KINDS).toContain('activity.process')

    expect(isProcessActivitySnapshotInput({
      id: 'process-1', kind: 'activity', activityKind: 'process', semanticKind: 'activity.process', status: 'running',
      processId: 'pid-1', parts: [{ kind: 'terminal', streams: [{ stream: 'stdout', text: 'ok' }] }],
    })).toBe(true)
    expect(isProcessActivitySnapshotInput({
      id: 'process-1', kind: 'activity', activityKind: 'process', semanticKind: 'activity.process', status: 'running',
      parts: [{ kind: 'terminal', streams: [{ stream: 'stdin', text: 'bad' }] }],
    })).toBe(false)
    expect(isProcessActivitySnapshotInput({ id: 'process-1', semanticKind: 'activity.background-task' })).toBe(false)
  })
})
