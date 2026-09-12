import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { HookRegistry } from '../hookRegistry.ts'
import type { HookDefinition } from '../hookTypes.ts'

describe('HookRegistry normalization contract', () => {
  it.each([false, true])('keeps live and shadow normalization equivalent (explicit=%s)', (explicit) => {
    const registry = new HookRegistry()
    const old = createPluginIdentity('test.hooks', 'old')
    const next = createPluginIdentity('test.hooks', 'next')
    const options = explicit
      ? { priority: 0, execution: 'background' as const, timeoutMs: 0, failurePolicy: 'abort' as const }
      : {}
    const definition: HookDefinition = { id: 'audit', mode: 'notification', handler: () => undefined, ...options }
    registry.register(old, 'session.created', definition)
    const before = registry.getSnapshot()
    const expected = { ...definition, hookName: 'session.created', priority: 1000,
      execution: 'blocking', timeoutMs: 3000, failurePolicy: 'continue', ...options }
    expect(before.entries[0].value).toEqual(expected)
    expect(before.entries[0].value).not.toBe(definition)
    expect(Object.isFrozen(before.entries[0].value)).toBe(true)
    const transaction = registry.beginShadowTransaction(next, old.key)
    transaction.register('session.created', definition)
    transaction.validate()
    expect(registry.getSnapshot()).toBe(before)
    transaction.commit()
    expect(registry.getSnapshot().entries[0]).toMatchObject({
      contributionId: `${next.key}:session.created:audit`, priority: expected.priority,
      ownerRuntimeInstanceId: next.key, value: expected,
    })
    expect(Object.isFrozen(registry.getSnapshot().entries[0].value)).toBe(true)
    transaction.revert()
    expect(registry.getSnapshot().entries).toEqual(before.entries)
  })

  it('rejects missing ids in both registration paths without publishing', () => {
    const registry = new HookRegistry()
    const owner = createPluginIdentity('test.hooks', 'one')
    const definition: HookDefinition = { id: '', mode: 'notification', handler: () => undefined }
    const before = registry.getSnapshot()
    expect(() => registry.register(owner, 'session.created', definition)).toThrow('Hook id 不能为空')
    const transaction = registry.beginShadowTransaction(owner, 'old')
    expect(() => transaction.register('session.created', definition)).toThrow('Hook id 不能为空')
    transaction.rollback()
    expect(registry.getSnapshot()).toBe(before)
  })
})
