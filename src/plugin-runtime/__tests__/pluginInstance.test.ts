import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../pluginIdentity'
import { deactivatePluginInstance } from '../pluginInstance'
import { activateTestBuiltinPlugin as activateBuiltinPlugin } from '../testing/pluginRuntimeHarness.ts'

describe('PluginInstance 静态内置插件纵向 Harness', () => {
  it('接受迁移期已有的 camelCase plugin id', async () => {
    const identity = createPluginIdentity('core.commandSet.builtin', 'builtin-1')
    const instance = await activateBuiltinPlugin(identity, () => undefined)

    expect(instance.identity.pluginId).toBe('core.commandSet.builtin')
  })

  it('activate 登记多类资源，deactivate 逆序统一回收', async () => {
    const calls: string[] = []
    const identity = createPluginIdentity('builtin.scope-fixture', 'instance-1')
    const instance = await activateBuiltinPlugin(identity, async context => {
      context.scope.add(() => { calls.push('resource:first') })
      context.scope.add(() => { calls.push('resource:second') })
      calls.push('activate')
    })

    const result = await deactivatePluginInstance(instance, async () => {
      calls.push('deactivate')
    })

    expect(calls).toEqual(['activate', 'deactivate', 'resource:second', 'resource:first'])
    expect(result.scope).toMatchObject({ disposed: 2, errors: [] })
    expect(instance.status).toBe('inactive')
  })

  it('activation 中途失败时事务回滚全部已登记资源', async () => {
    const calls: string[] = []
    const identity = createPluginIdentity('builtin.scope-fixture', 'instance-2')

    await expect(activateBuiltinPlugin(identity, context => {
      context.scope.add(() => { calls.push('rollback:first') })
      context.scope.add(() => { calls.push('rollback:second') })
      throw new Error('activate boom')
    })).rejects.toMatchObject({
      identity,
      cause: expect.any(Error),
      rollback: { disposed: 2, errors: [] },
    })

    expect(calls).toEqual(['rollback:second', 'rollback:first'])
  })

  it('deactivate 抛错仍回收 scope 并返回双层结果', async () => {
    const calls: string[] = []
    const identity = createPluginIdentity('builtin.scope-fixture', 'instance-3')
    const instance = await activateBuiltinPlugin(identity, context => {
      context.scope.add(() => { calls.push('resource') })
    })

    const result = await deactivatePluginInstance(instance, () => {
      throw new Error('deactivate boom')
    })

    expect(result).toMatchObject({
      complete: false,
      alreadyInactive: false,
      deactivateError: { resourceId: 'deactivate-hook', message: 'deactivate boom' },
    })
    expect(result.scope.disposed).toBe(1)
    expect(calls).toEqual(['resource'])
    expect(instance.status).toBe('cleanup-failed')
  })

  it('scope cleanup failure stays retryable until the residual succeeds', async () => {
    const identity = createPluginIdentity('builtin.scope-fixture', 'instance-retry')
    let attempts = 0
    const instance = await activateBuiltinPlugin(identity, context => {
      context.scope.add(() => {
        attempts += 1
        if (attempts === 1) throw new Error('resource busy')
      }, { resourceId: 'busy-resource' })
    })

    await expect(deactivatePluginInstance(instance)).resolves.toMatchObject({
      complete: false,
      scope: {
        remaining: 1,
        errors: [{ resourceId: 'busy-resource', message: 'resource busy' }],
      },
    })
    expect(instance.status).toBe('cleanup-failed')

    await expect(deactivatePluginInstance(instance)).resolves.toMatchObject({
      complete: true,
      scope: { disposed: 1, remaining: 0, errors: [] },
    })
    expect(instance.status).toBe('inactive')
  })

  it('同一 instance 不能重复 deactivate', async () => {
    const identity = createPluginIdentity('builtin.scope-fixture', 'instance-4')
    const instance = await activateBuiltinPlugin(identity, () => {})
    await deactivatePluginInstance(instance)
    await expect(deactivatePluginInstance(instance)).resolves.toMatchObject({
      alreadyInactive: true,
      scope: { disposed: 0, errors: [] },
    })
  })
})
