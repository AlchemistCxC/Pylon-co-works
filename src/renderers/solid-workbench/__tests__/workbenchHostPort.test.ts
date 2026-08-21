import { describe, expect, it, vi } from 'vitest'
import { createSessionUiStore } from '../../../domains/workbench/sessionUiStore.ts'
import { createPreviewWorkbenchRuntime } from '../../../domains/workbench/workbenchRuntime.ts'
import { createFakeWorkbenchCommandFacade } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { createStaticWorkbenchAppearanceStore } from '../../../domains/workbench/workbenchAppearanceStore.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { createWorkbenchHostPort } from '../workbenchHostPort.ts'
import type { WorkbenchMessage } from '../../../domains/workbench/workbenchProjector.ts'

function runtime() {
  return createPreviewWorkbenchRuntime({
    sessionId: 's1', status: 'ready', messages: [], streamingText: '', streamingThinking: '', generating: false,
    generationStart: 0, tokenCount: 0, summary: null, tasks: [], availableModels: [], activeModel: '',
    availableModes: [], activeMode: '', canAttach: true, promptImage: false, error: null,
  })
}

describe('WorkbenchHostPort', () => {
  it('exposes an immutable document reader and slice subscriptions', () => {
    const source = runtime()
    const host = createWorkbenchHostPort({
      runtime: source,
      appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)),
      sessionUi: createSessionUiStore(),
      commands: createFakeWorkbenchCommandFacade(),
      suiteId: 'suite.test', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
    })
    const before = host.document.getSnapshot()
    expect(before).toBe(source.getSnapshot().document)
    expect(Object.isFrozen(before)).toBe(true)
    const changed = vi.fn()
    const unsubscribe = host.document.subscribeSlice('messages', changed)
    source.update({ streamingText: 'unrelated' })
    expect(changed).not.toHaveBeenCalled()
    const message: WorkbenchMessage = {
      id: 'new', role: 'assistant', content: 'hello', parts: [], identity: {},
      source: { provider: 'test', sourceId: 'test' }, sequence: 1, running: false, time: '2026-01-01T00:00:00.000Z',
    }
    source.replaceDocument({ ...before!, messages: [message] }, { ownerKey: 'owner-a', generation: 1 })
    expect(changed).toHaveBeenCalledTimes(1)
    unsubscribe()
    source.destroy()
  })

  it('namespaces session UI by suite, sheet and session owner', () => {
    const store = createSessionUiStore()
    const base = { runtime: runtime(), appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)), sessionUi: store, commands: createFakeWorkbenchCommandFacade(), sessionId: 's1' }
    const first = createWorkbenchHostPort({ ...base, suiteId: 'suite.a', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a' })
    const second = createWorkbenchHostPort({ ...base, suiteId: 'suite.b', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a' })
    first.sessionUi.set('draft', 'first')
    expect(second.sessionUi.get('draft', 'missing')).toBe('missing')
  })

  it('returns structured capability-denied command errors and contextual diagnostics', async () => {
    const diagnostics = vi.fn()
    const host = createWorkbenchHostPort({
      runtime: runtime(), appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)),
      sessionUi: createSessionUiStore(), commands: createFakeWorkbenchCommandFacade(),
      suiteId: 'suite.test', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
      capabilities: { prompt: false }, diagnostics,
    })
    const result = await host.commands.prompt('s1', { text: 'hello' })
    expect(result).toMatchObject({ ok: false, error: { code: 'command_capability_denied', recoverability: 'none' } })
    host.diagnostics.report({ code: 'render.failed', phase: 'mount', message: 'failed' })
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ suiteId: 'suite.test', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', code: 'render.failed' }))
  })
})
