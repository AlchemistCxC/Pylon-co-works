import { describe, expect, it, vi } from 'vitest'
import { createSessionUiStore } from '../../../domains/workbench/sessionUiStore.ts'
import { createPreviewWorkbenchRuntime } from '../../../domains/workbench/workbenchRuntime.ts'
import { createFakeWorkbenchCommandFacade } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { createStaticWorkbenchAppearanceStore } from '../../../domains/workbench/workbenchAppearanceStore.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { createWorkbenchHostPort } from '../workbenchHostPort.ts'
import type { WorkbenchMessage } from '../../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench } from '../../../domains/workbench/workbenchProjector.ts'
import { createSolidWorkbenchServicesFromHostPort } from '../hostPortSolidServices.ts'

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

  it('stable HostPort follows the active Suite/owner binding without replacing the port', () => {
    const store = createSessionUiStore()
    const binding = { suiteId: 'suite.a', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1' as string | null }
    const host = createWorkbenchHostPort({
      runtime: runtime(), appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)),
      sessionUi: store, commands: createFakeWorkbenchCommandFacade(), ...binding,
      binding: () => binding,
    })
    host.sessionUi.set('draft', 'owner-a draft')

    binding.suiteId = 'suite.b'
    binding.sessionOwnerKey = 'owner-b'

    expect(host.sessionUi.get('draft', 'missing')).toBe('missing')
    host.sessionUi.set('draft', 'owner-b draft')
    binding.suiteId = 'suite.a'
    binding.sessionOwnerKey = 'owner-a'
    expect(host.sessionUi.get('draft', 'missing')).toBe('owner-a draft')
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

  it('treats undeclared command capabilities as denied and does not alias session creation to prompt', async () => {
    const host = createWorkbenchHostPort({
      runtime: runtime(), appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)),
      sessionUi: createSessionUiStore(), commands: createFakeWorkbenchCommandFacade(),
      suiteId: 'suite.test', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
      capabilities: { prompt: true },
    })

    expect(host.capabilities.has('retry')).toBe(false)
    await expect(host.commands.retry('s1')).resolves.toMatchObject({ ok: false, error: { code: 'command_capability_denied' } })
    await expect(host.commands.createSession()).resolves.toMatchObject({ ok: false, error: { code: 'command_capability_denied' } })
  })

  it('gates appearance mutation behind the explicit appearanceEdit capability', () => {
    const authorizedAppearance = createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS))
    const authorized = createWorkbenchHostPort({
      runtime: runtime(), appearance: authorizedAppearance,
      sessionUi: createSessionUiStore(), commands: createFakeWorkbenchCommandFacade(),
      suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
      capabilities: { appearanceEdit: true },
    })
    const deniedAppearance = createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS))
    const denied = createWorkbenchHostPort({
      runtime: runtime(), appearance: deniedAppearance,
      sessionUi: createSessionUiStore(), commands: createFakeWorkbenchCommandFacade(),
      suiteId: 'suite.third-party', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
    })

    expect(authorized.appearance.dispatch?.({ type: 'set-cc-property', key: 'modelVariant', value: 'minimal' })).toBe(true)
    expect(authorizedAppearance.getSnapshot().modelVariant).toBe('minimal')
    expect(denied.appearance.dispatch?.({ type: 'set-cc-property', key: 'modelVariant', value: 'minimal' })).toBe(false)
    expect(deniedAppearance.getSnapshot().modelVariant).toBe(DEFAULTS.modelVariant)
  })

  it('production Solid appearance adapter writes through HostPort or reports a denied diagnostic', () => {
    const authorizedAppearance = createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS))
    const authorized = createWorkbenchHostPort({
      runtime: runtime(), appearance: authorizedAppearance,
      sessionUi: createSessionUiStore(), commands: createFakeWorkbenchCommandFacade(),
      suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
      capabilities: { appearanceEdit: true },
    })
    const diagnostics = vi.fn()
    const deniedAppearance = createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS))
    const denied = createWorkbenchHostPort({
      runtime: runtime(), appearance: deniedAppearance,
      sessionUi: createSessionUiStore(), commands: createFakeWorkbenchCommandFacade(),
      suiteId: 'suite.third-party', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
      diagnostics,
    })

    createSolidWorkbenchServicesFromHostPort(authorized).appearance.dispatch({
      type: 'set-cc-property', key: 'modelVariant', value: 'minimal',
    })
    createSolidWorkbenchServicesFromHostPort(denied).appearance.dispatch({
      type: 'set-cc-property', key: 'modelVariant', value: 'minimal',
    })

    expect(authorizedAppearance.getSnapshot().modelVariant).toBe('minimal')
    expect(deniedAppearance.getSnapshot().modelVariant).toBe(DEFAULTS.modelVariant)
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      code: 'renderer.appearance.command.denied', phase: 'action', recoverability: 'none',
      suiteId: 'suite.third-party',
    }))
  })

  it('production Solid adapter exposes canonical plan entries without dropping blocked metadata', () => {
    const source = runtime()
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 's1', sequence: 1, recordedAt: '2026-08-22T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'plan-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'plan.replaced', entries: [{ id: 'task-1', content: '等待用户', status: 'blocked', blockedReason: '需要确认', priority: 'high' }] },
    })]).document
    source.replaceDocument(document, { ownerKey: 'owner-a', generation: 1 })
    const host = createWorkbenchHostPort({
      runtime: source, appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)),
      sessionUi: createSessionUiStore(), commands: createFakeWorkbenchCommandFacade(),
      suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
    })

    expect(createSolidWorkbenchServicesFromHostPort(host).runtime.getSnapshot().tasks).toEqual([
      expect.objectContaining({ id: 'task-1', status: 'blocked', blockedReason: '需要确认', priority: 'high' }),
    ])
    expect(Object.isFrozen(host.document.getSnapshot()?.plan)).toBe(true)
    expect(Object.isFrozen(host.document.getSnapshot()?.plan.entries)).toBe(true)
    expect(Object.isFrozen(host.document.getSnapshot()?.plan.entries[0])).toBe(true)
  })

  it('production Solid adapter keeps rejected interaction structured and diagnostic instead of throwing', async () => {
    const diagnostics = vi.fn()
    const commands = createFakeWorkbenchCommandFacade({
      respondInteraction: async () => ({ ok: false, error: 'interaction_expired' }),
    })
    const host = createWorkbenchHostPort({
      runtime: runtime(), appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)),
      sessionUi: createSessionUiStore(), commands,
      suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
      capabilities: { interactionResponse: true }, diagnostics,
    })

    await expect(createSolidWorkbenchServicesFromHostPort(host).commands.respondInteraction('s1', 'interaction-a', { optionId: 'allow' }))
      .resolves.toEqual({ ok: false, error: 'interaction_expired' })
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      code: 'command_rejected', phase: 'action', command: 'respondInteraction',
    }))
  })

  it('production Solid adapter preserves interaction expectedRevision through the Host port', async () => {
    const commands = createFakeWorkbenchCommandFacade()
    const host = createWorkbenchHostPort({
      runtime: runtime(), appearance: createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS)),
      sessionUi: createSessionUiStore(), commands,
      suiteId: 'builtin.solid', sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 's1',
      capabilities: { interactionResponse: true },
    })

    await createSolidWorkbenchServicesFromHostPort(host).commands.respondInteraction(
      's1', 'interaction-a', { optionId: 'allow' }, { expectedRevision: 13 },
    )
    expect(commands.calls.at(-1)).toEqual({
      command: 'respondInteraction',
      args: ['s1', 'interaction-a', { optionId: 'allow' }, { expectedRevision: 13 }],
    })
  })
})
