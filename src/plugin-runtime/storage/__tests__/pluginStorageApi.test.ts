// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPluginStorageApi, PLUGIN_STORAGE_BUDGET_BYTES, PluginStorageError } from '../pluginStorageApi.ts'
import type { PluginIdentity } from '../../pluginIdentity.ts'

const identity = (pluginId: string): PluginIdentity => ({
  pluginId,
  version: '1.0.0',
  packageInstanceId: `${pluginId}#pkg`,
  runtimeInstanceId: `${pluginId}#rt`,
  instanceId: `${pluginId}#${pluginId}#rt`,
  key: `${pluginId}#${pluginId}#rt`,
})

describe('createPluginStorageApi', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('按插件命名空间隔离', () => {
    const a = createPluginStorageApi(identity('plugin.a'))
    const b = createPluginStorageApi(identity('plugin.b'))
    a.setValue('theme', { density: 'compact' })
    expect(a.getValue<{ density: string }>('theme')).toEqual({ density: 'compact' })
    expect(b.getValue('theme')).toBeUndefined()
    expect(b.keys()).toEqual([])
    a.clear()
    expect(a.keys()).toEqual([])
  })

  it('值经 structuredClone 深拷贝，写入后不被外部引用突变污染', () => {
    const api = createPluginStorageApi(identity('plugin.clone'))
    const value = { nested: ['x'] }
    api.setValue('cfg', value)
    value.nested.push('y')
    expect(api.getValue<{ nested: string[] }>('cfg')?.nested).toEqual(['x'])
  })

  it('读回值隔离，并拒绝危险或空白 key', () => {
    const api = createPluginStorageApi(identity('plugin.read-clone'))
    api.setValue('cfg', { nested: ['x'] })
    const read = api.getValue<{ nested: string[] }>('cfg')!
    read.nested.push('mutated')
    expect(api.getValue<{ nested: string[] }>('cfg')?.nested).toEqual(['x'])
    expect(() => api.getValue('__proto__')).toThrow(/key 非法/)
    expect(() => api.setValue(' bad ', true)).toThrow(/key 非法/)
    expect(() => api.removeValue('')).toThrow(/key 非法/)
  })

  it('remove/clear 持久化失败时保留原 cache', () => {
    const api = createPluginStorageApi(identity('plugin.atomic'))
    api.setValue('keep', { value: 1 })
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('disk unavailable')
    })
    expect(() => api.removeValue('keep')).toThrow(PluginStorageError)
    expect(api.getValue<{ value: number }>('keep')).toEqual({ value: 1 })
    setItem.mockRestore()

    const clearSetItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('disk unavailable')
    })
    expect(() => api.clear()).toThrow(PluginStorageError)
    expect(api.getValue<{ value: number }>('keep')).toEqual({ value: 1 })
    clearSetItem.mockRestore()
  })

  it('超软配额抛 PluginStorageError 且不写入', () => {
    const api = createPluginStorageApi(identity('plugin.quota'))
    expect(() => api.setValue('huge', 'x'.repeat(PLUGIN_STORAGE_BUDGET_BYTES + 10))).toThrow(PluginStorageError)
    expect(api.keys()).toEqual([])
  })

  it('配额按 UTF-8 字节计数', () => {
    const api = createPluginStorageApi(identity('plugin.unicode-quota'))
    expect(() => api.setValue('emoji', '😀'.repeat(PLUGIN_STORAGE_BUDGET_BYTES))).toThrow(PluginStorageError)
  })

  it('subscribe 在写删时触发并可退订', () => {
    const api = createPluginStorageApi(identity('plugin.sub'))
    let hits = 0
    const off = api.subscribe(() => { hits += 1 })
    api.setValue('k', 1)
    api.removeValue('k')
    off()
    api.setValue('k', 2)
    expect(hits).toBe(2)
  })
})
