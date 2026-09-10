// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { readPluginStorageUsage, clearPluginStorageNamespace } from '../pluginStorageUsage.ts'
import { createPluginStorageApi } from '../../storage/pluginStorageApi.ts'
import { PLUGIN_STORAGE_BUDGET_BYTES } from '../../storage/pluginStorageContract.ts'

/**
 * review P1-1/A + P1-3：存储用量投影与清空的 cache 一致性——
 * clear 必须经 pluginStorageApi（同步模块级 cache），否则被清数据会
 * 在下一次 setValue 时"复活"。
 */
describe('plugin storage usage projection (review P1-3)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('projects per-plugin usage with the real budget constant', () => {
    const api = createPluginStorageApi({
      pluginId: 'plugin.a', version: '1', packageInstanceId: 'p', runtimeInstanceId: 'r', instanceId: 'r', key: 'r',
    })
    api.setValue('greeting', 'hello')

    const usage = readPluginStorageUsage()
    expect(usage).toHaveLength(1)
    expect(usage[0]?.pluginId).toBe('plugin.a')
    expect(usage[0]?.keyCount).toBe(1)
    expect(usage[0]?.usedBytes).toBeGreaterThan(0)
    expect(usage[0]?.budgetBytes).toBe(PLUGIN_STORAGE_BUDGET_BYTES)
  })

  it('clear goes through pluginStorageApi so cached values do not resurrect', () => {
    const api = createPluginStorageApi({
      pluginId: 'plugin.b', version: '1', packageInstanceId: 'p', runtimeInstanceId: 'r', instanceId: 'r', key: 'r',
    })
    api.setValue('keep-me', { nested: true })
    expect(api.getValue('keep-me')).toEqual({ nested: true })

    clearPluginStorageNamespace('plugin.b')

    // 清空生效：直读与经 API（模块级 cache）读都为空
    expect(api.getValue('keep-me')).toBeUndefined()
    expect(readPluginStorageUsage().find(entry => entry.pluginId === 'plugin.b')).toBeUndefined()

    // 清空后写入不得以旧 namespace 为基底（"复活"回归锁）
    api.setValue('fresh', 1)
    expect(api.keys()).toEqual(['fresh'])
    expect(api.getValue('keep-me')).toBeUndefined()
  })

  it('only clears the target plugin namespace', () => {
    const a = createPluginStorageApi({
      pluginId: 'plugin.a', version: '1', packageInstanceId: 'p', runtimeInstanceId: 'r', instanceId: 'r', key: 'r',
    })
    const b = createPluginStorageApi({
      pluginId: 'plugin.b', version: '1', packageInstanceId: 'p', runtimeInstanceId: 'r', instanceId: 'r', key: 'r',
    })
    a.setValue('x', 1)
    b.setValue('y', 2)

    clearPluginStorageNamespace('plugin.a')

    expect(a.getValue('x')).toBeUndefined()
    expect(b.getValue('y')).toBe(2)
  })
})
