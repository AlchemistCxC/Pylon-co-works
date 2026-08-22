import { describe, expect, it } from 'vitest'
import { BUILTIN_EXECUTION_RENDER_KINDS, isProcessActivitySnapshotInput, isSubagentActivitySnapshotInput, isWorkflowActivitySnapshotInput } from '../executionRenderKindCatalog.ts'
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

  it('registers subagent/delegation/team kinds with valid fixtures and strict validators (C09)', () => {
    for (const family of ['subagent', 'delegation', 'team'] as const) {
      const kind = BUILTIN_EXECUTION_RENDER_KINDS.find(k => k.id === `activity.${family}`)!
      expect(kind).toBeDefined()
      expect(kind.category).toBe('activity')
      expect(kind.fallbackKind).toBe('content.unknown')
      expect(BUILTIN_SOLID_CONTENT_KINDS).toContain(`activity.${family}`)
      // fixture 必须通过自身 validator（C13 教训：fixture 自校验）
      expect(kind.validateInput?.(kind.fixture)).toBe(true)
    }

    // rich 输入通过；层级/身份字段类型错误拒绝；缺 family 拒绝
    expect(isSubagentActivitySnapshotInput({
      id: 's1', kind: 'activity', activityKind: 'subagent', semanticKind: 'activity.subagent', status: 'running',
      parentId: 'tool-1', depth: 2, role: 'explorer', goal: 'explore', capabilities: ['fs'], parts: [],
    })).toBe(true)
    expect(isSubagentActivitySnapshotInput({
      id: 's2', kind: 'activity', activityKind: 'subagent', status: 'running', depth: -1,
    })).toBe(false)
    expect(isSubagentActivitySnapshotInput({ id: 's3', status: 'running' })).toBe(false)
  })

  it('registers workflow/workflow-phase/workflow-agent kinds with valid fixtures (C10)', () => {
    for (const family of ['workflow', 'workflow-phase', 'workflow-agent'] as const) {
      const kind = BUILTIN_EXECUTION_RENDER_KINDS.find(k => k.id === `activity.${family}`)!
      expect(kind).toBeDefined()
      expect(kind.fallbackKind).toBe('content.unknown')
      expect(BUILTIN_SOLID_CONTENT_KINDS).toContain(`activity.${family}`)
      expect(kind.validateInput?.(kind.fixture)).toBe(true)
    }
    // relation 挂接：phase/agent 携带 parentId；workflow 本体无 parentId
    const wf = BUILTIN_EXECUTION_RENDER_KINDS.find(k => k.id === 'activity.workflow')!
    expect((wf.fixture as Record<string, unknown>).parentId).toBeUndefined()
    const phase = BUILTIN_EXECUTION_RENDER_KINDS.find(k => k.id === 'activity.workflow-phase')!
    expect((phase.fixture as Record<string, unknown>).parentId).toBe('fixture-workflow')
    expect(isWorkflowActivitySnapshotInput({
      id: 'w1', kind: 'activity', activityKind: 'workflow-phase', status: 'running', parentId: 'wf-1',
      progress: { completed: 1, total: 3 },
    })).toBe(true)
    expect(isWorkflowActivitySnapshotInput({ id: 'w2', kind: 'activity', activityKind: 'mystery', status: 'running' })).toBe(false)
  })
})
