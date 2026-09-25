import { describe, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'
import type { Session } from '../../../domains/identity/identityStore.ts'
import { extractModeConfig, extractModelConfig } from '../../../infrastructure/acp/chatContracts.ts'
import { normalizeSessionMode } from '../../../components/chat/sessionModeState.ts'

const session: Session = {
  id: 'control', source: 'local:control', agentId: 'fixture', profileId: 'profile', name: 'control',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
}
const response = (model: string) => ({ configOptions: [
  { id: 'model-choice', category: 'model', name: 'Model', type: 'select', currentValue: model,
    options: [{ group: 'recommended', name: 'Recommended', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }] },
  { id: 'permission-choice', category: 'mode', name: 'Mode', type: 'select', currentValue: 'plan',
    options: [{ value: 'plan', name: 'Plan' }, { value: 'acceptEdits', name: 'Edit' }] },
] })
async function setup() {
  const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [], subscribe: () => () => {} })
  await service.bind(session)
  service.applySessionResponse(response('a'), session.id)
  return service
}

describe('ACP selector control boundary #304', () => {
  it('preserves opaque mode IDs and prefers configOptions over conflicting legacy state', () => {
    for (const id of ['plan', 'acceptEdits', 'bypassPermissions', 'edit', 'custom-mode']) expect(normalizeSessionMode(id)).toBe(id)
    expect(normalizeSessionMode(' ')).toBeNull()
    expect(extractModeConfig({ ...response('a'), modes: { currentModeId: 'wrong', availableModes: [{ id: 'wrong' }] } }))
      .toEqual({ mode: 'plan', modes: ['plan', 'acceptEdits'] })
    expect(extractModelConfig(response('a').configOptions).models).toEqual(['a', 'b'])
  })
  it('adopts the complete reply, including clamped model and dependent options', async () => {
    const service = await setup()
    await service.runSessionControl(session, { kind: 'model', model: 'requested' }, async () => response('b'))
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.activeModel).toBe('b')
    expect(snapshot.activeMode).toBe('plan')
    expect(snapshot.document?.session.options).toHaveLength(2)
    expect(snapshot.document?.session.options[0]?.schema).toEqual({ options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
    service.destroy()
  })
  it('supports A→B→A, and empty echoes retain confirmed state plus visible pending', async () => {
    const service = await setup()
    for (const model of ['b', 'a']) {
      await service.runSessionControl(session, { kind: 'model', model }, async () => response(model))
      expect(service.runtime.getSnapshot().activeModel).toBe(model)
    }
    await service.runSessionControl(session, { kind: 'model', model: 'b' }, async () => ({ configOptions: [] }))
    expect(service.runtime.getSnapshot().activeModel).toBe('a')
    expect(service.runtime.getSnapshot().document?.session.options).toHaveLength(2)
    expect(service.sessionUi.get(session.id, 'selector-pending', '')).toContain('b（等待')
    service.applySessionResponse(response('b'), session.id)
    expect(service.sessionUi.get(session.id, 'selector-pending', '')).toBe('')
    service.destroy()
  })
  it('drops a late response after rebinding to another owner with the same source', async () => {
    const service = await setup()
    let resolve!: (value: unknown) => void
    const pending = service.runSessionControl(session, { kind: 'model', model: 'b' }, () => new Promise(done => { resolve = done }))
    await service.bind({ ...session, agentId: 'other', id: 'other' })
    resolve(response('b'))
    await pending
    expect(service.runtime.getSnapshot().activeModel).not.toBe('b')
    expect(service.sessionUi.get('other', 'selector-pending', '')).toBe('')
    service.destroy()
  })
  it('a notification during the RPC does not discard dependent options in the response', async () => {
    const service = await setup()
    await service.runSessionControl(session, { kind: 'model', model: 'b' }, async () => {
      service.applyLocalSessionFact({ kind: 'model', model: 'b' }, session.source)
      return { configOptions: [...response('b').configOptions, { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }] }] }
    })
    expect(service.runtime.getSnapshot().document?.session.options).toHaveLength(3)
    service.applySessionResponse(response('a'), session.id)
    expect(service.runtime.getSnapshot().activeModel).toBe('a')
    service.destroy()
  })
  it('rejects concurrent writes and preserves state on RPC failure', async () => {
    const service = await setup()
    let reject!: (error: Error) => void
    const pending = service.runSessionControl(session, { kind: 'model', model: 'b' }, () => new Promise((_, fail) => { reject = fail }))
    await expect(service.runSessionControl(session, { kind: 'mode', mode: 'plan' }, async () => ({}))).rejects.toThrow('selector_request_in_flight')
    reject(new Error('denied'))
    await expect(pending).rejects.toThrow('denied')
    expect(service.runtime.getSnapshot().activeModel).toBe('a')
    service.destroy()
  })
})
