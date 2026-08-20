import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity'
import { ReactiveRegistryStore } from '../reactiveRegistry'

function identity(pluginId: string, instanceId: string) {
  return createPluginIdentity(pluginId, instanceId)
}

describe('ReactiveRegistryStore', () => {
  it('register/dispose 推进 revision，并保持稳定 snapshot 引用', async () => {
    const registry = new ReactiveRegistryStore<string>()
    const listener = vi.fn()
    registry.subscribe(listener)
    const initial = registry.getSnapshot()

    const handle = registry.register(identity('p.a', 'run-1'), 'A', {
      contributionId: 'a',
      priority: 20,
    })
    const active = registry.getSnapshot()

    expect(active).not.toBe(initial)
    expect(active.revision).toBe(1)
    expect(active.entries.map(entry => entry.value)).toEqual(['A'])
    expect(registry.getSnapshot()).toBe(active)

    await handle.dispose()
    expect(registry.getSnapshot().revision).toBe(2)
    expect(registry.getSnapshot().entries).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('before/after 优先于 layer/priority，并拒绝未知引用与环', () => {
    const registry = new ReactiveRegistryStore<string>()
    registry.register(identity('p.base', 'run-1'), 'base', {
      contributionId: 'base',
      layer: 'platform',
      priority: 100,
    })
    registry.register(identity('p.override', 'run-1'), 'override', {
      contributionId: 'override',
      layer: 'override',
      priority: 0,
      before: ['base'],
    })
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual([
      'override', 'base',
    ])

    expect(() => registry.register(identity('p.bad', 'run-1'), 'bad', {
      contributionId: 'bad',
      after: ['missing'],
    })).toThrow('未知 id')
  })

  it('transaction 原子提交；失败和 rollback 不发布部分状态', () => {
    const registry = new ReactiveRegistryStore<string>()
    const transaction = registry.beginTransaction(identity('p.tx', 'run-1'))
    transaction.register('A', { contributionId: 'a' })
    transaction.register('B', { contributionId: 'b', after: ['a'] })
    expect(registry.getSnapshot().entries).toEqual([])

    const handles = transaction.commit()
    expect(registry.getSnapshot().revision).toBe(1)
    expect(registry.getSnapshot().entries.map(entry => entry.value)).toEqual(['A', 'B'])
    expect(handles).toHaveLength(2)

    const rollback = registry.beginTransaction(identity('p.rollback', 'run-1'))
    rollback.register('C', { contributionId: 'c' })
    rollback.rollback()
    expect(registry.getSnapshot().entries.map(entry => entry.value)).toEqual(['A', 'B'])
  })

  it('shadow transaction 在 commit 前隔离候选，并可精确 revert 到旧 snapshot', async () => {
    const registry = new ReactiveRegistryStore<string>()
    const oldOwner = identity('p.shadow', 'run-old')
    const candidate = identity('p.shadow', 'run-new')
    const oldHandle = registry.register(oldOwner, 'old', { contributionId: 'shared' })
    const transaction = registry.beginShadowTransaction(candidate, oldOwner.key)
    const candidateHandle = transaction.register('new', { contributionId: 'shared' })

    transaction.validate()
    expect(registry.getSnapshot().entries.map(entry => entry.value)).toEqual(['old'])
    transaction.commit()
    expect(registry.getSnapshot().entries.map(entry => entry.value)).toEqual(['new'])

    await oldHandle.dispose()
    expect(registry.getSnapshot().entries.map(entry => entry.value)).toEqual(['new'])
    transaction.revert()
    expect(registry.getSnapshot().entries.map(entry => entry.value)).toEqual(['old'])

    await candidateHandle.dispose()
    expect(registry.getSnapshot().entries.map(entry => entry.value)).toEqual(['old'])
  })
})
