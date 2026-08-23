import { describe, expect, it } from 'vitest'
import { BUILTIN_EXECUTION_RENDER_KINDS, isBackgroundTaskActivitySnapshotInput, isProcessActivitySnapshotInput, isSubagentActivitySnapshotInput, isWorkflowActivitySnapshotInput } from '../executionRenderKindCatalog.ts'
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
      const settingKeys = kind.settings?.groups.flatMap(group => group.fields.map(field => field.key)) ?? []
      expect(settingKeys).toEqual(expect.arrayContaining([
        'identityMarker', 'cardWidth', 'viewMode', 'treeLineStyle', 'treeLineColor', 'indent',
        'defaultExpandedDepth', 'showAggregate',
      ]))
      expect(kind.defaultTokens).toMatchObject({
        identityMarker: 'glyph', cardWidth: 960, viewMode: 'tree', treeLineStyle: 'solid',
        indent: 24, defaultExpandedDepth: 2, showAggregate: true,
      })
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
    expect(isSubagentActivitySnapshotInput({
      id: 's4', kind: 'activity', activityKind: 'subagent', semanticKind: 'activity.team', status: 'running',
    })).toBe(false)
    expect(isSubagentActivitySnapshotInput({
      id: 's5', kind: 'activity', activityKind: 'team', semanticKind: 'activity.team', status: 'teleporting',
    })).toBe(false)
    expect(isSubagentActivitySnapshotInput({
      id: 's6', kind: 'activity', activityKind: 'delegation', semanticKind: 'activity.delegation', status: 'running',
      parts: [{ kind: 'terminal', streams: [{ stream: 'stdin', text: 'not renderer-safe' }] }],
    })).toBe(false)
    expect(isSubagentActivitySnapshotInput({
      id: 's7', kind: 'activity', activityKind: 'subagent', semanticKind: 'activity.subagent', status: 'running',
      metrics: { toolCount: -1, durationMs: 'fast' },
    })).toBe(false)
    const richBase = {
      id: 's8', kind: 'activity', activityKind: 'subagent', semanticKind: 'activity.subagent', status: 'running',
      sourceAgentId: 'agent-parent', description: 'Inspect registry', startedAt: '2026-08-23T06:00:00.000Z',
      execution: { mode: 'remote', background: true }, tools: [], tasks: [],
    }
    expect(isSubagentActivitySnapshotInput(richBase)).toBe(true)
    for (const malformed of [
      { sourceAgentId: ' ' }, { startedAt: 42 }, { execution: ['remote'] }, { tools: {} }, { tasks: 'one' },
    ]) {
      expect(isSubagentActivitySnapshotInput({ ...richBase, ...malformed })).toBe(false)
    }
  })

  it('registers workflow/workflow-phase/workflow-agent kinds with valid fixtures (C10)', () => {
    for (const family of ['workflow', 'workflow-phase', 'workflow-agent'] as const) {
      const kind = BUILTIN_EXECUTION_RENDER_KINDS.find(k => k.id === `activity.${family}`)!
      expect(kind).toBeDefined()
      expect(kind.fallbackKind).toBe('content.unknown')
      expect(BUILTIN_SOLID_CONTENT_KINDS).toContain(`activity.${family}`)
      expect(kind.validateInput?.(kind.fixture)).toBe(true)
      const settingKeys = kind.settings?.groups.flatMap(group => group.fields.map(field => field.key)) ?? []
      expect(settingKeys).toEqual(expect.arrayContaining([
        'density', 'statusPalette', 'workflowLayout', 'workflowConnector', 'indent', 'collapseCompleted', 'stats', 'animateProgress',
      ]))
      expect(kind.defaultTokens).toMatchObject({
        density: 'comfortable', statusPalette: 'semantic', workflowLayout: 'timeline', workflowConnector: true, indent: 24,
        collapseCompleted: true, animateProgress: true,
      })
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
    expect(isWorkflowActivitySnapshotInput({
      id: 'w3', kind: 'activity', activityKind: 'workflow-phase', semanticKind: 'activity.workflow-agent', status: 'running',
    })).toBe(false)
    expect(isWorkflowActivitySnapshotInput({
      id: 'w4', kind: 'activity', activityKind: 'workflow', semanticKind: 'activity.workflow', status: 'teleporting',
    })).toBe(false)
    expect(isWorkflowActivitySnapshotInput({
      id: 'w5', kind: 'activity', activityKind: 'workflow-phase', semanticKind: 'activity.workflow-phase', status: 'running',
      output: [{ kind: 'terminal', streams: [{ stream: 'stdin', text: 'unsafe' }] }],
    })).toBe(false)
    expect(isWorkflowActivitySnapshotInput({
      id: 'w6', kind: 'activity', activityKind: 'workflow-agent', semanticKind: 'activity.workflow-agent', status: 'running',
      killed: 'yes', timeout: 1,
    })).toBe(false)
    expect(isWorkflowActivitySnapshotInput({
      id: 'w7', kind: 'activity', activityKind: 'workflow-phase', semanticKind: 'activity.workflow-phase', status: 'running',
      depth: -1,
    })).toBe(false)
    expect(isWorkflowActivitySnapshotInput({
      id: 'w8', kind: 'activity', activityKind: 'workflow', semanticKind: 'activity.workflow', status: 'running',
      metrics: { toolCount: -1, durationMs: 'fast' },
    })).toBe(false)
    const richWorkflow = {
      id: 'w9', kind: 'activity', activityKind: 'workflow-agent', semanticKind: 'activity.workflow-agent', status: 'running',
      sourceAgentId: 'agent-parent', description: 'review release', startedAt: '2026-08-24T00:00:00.000Z',
      execution: { mode: 'remote', background: true }, tools: [], tasks: [],
    }
    expect(isWorkflowActivitySnapshotInput(richWorkflow)).toBe(true)
    for (const malformed of [
      { sourceAgentId: 42 }, { completedAt: [] }, { execution: ['remote'] }, { tools: {} }, { tasks: 'one' },
    ]) expect(isWorkflowActivitySnapshotInput({ ...richWorkflow, ...malformed })).toBe(false)
  })

  it('strictly validates background-task lifecycle and rich fields (C10)', () => {
    expect(isBackgroundTaskActivitySnapshotInput({
      id: 'bg-invalid-status', kind: 'activity', activityKind: 'background-task',
      semanticKind: 'activity.background-task', status: 'teleporting',
    })).toBe(false)
    expect(isBackgroundTaskActivitySnapshotInput({
      id: 'bg-invalid-output', kind: 'activity', activityKind: 'background-task',
      semanticKind: 'activity.background-task', status: 'running',
      output: [{ kind: 'terminal', streams: [{ stream: 'stdin', text: 'unsafe' }] }],
    })).toBe(false)
    const background = {
      id: 'bg-rich', kind: 'activity', activityKind: 'background-task',
      semanticKind: 'activity.background-task', status: 'running',
    }
    for (const malformed of [
      { progress: () => undefined },
      { metrics: { toolCount: -1 } },
      { killed: 'yes' },
      { timeout: 1 },
    ]) expect(isBackgroundTaskActivitySnapshotInput({ ...background, ...malformed })).toBe(false)
  })
})
