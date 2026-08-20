/**
 * importConfigurationTransaction 行为测试（报告阶段 3.6 / 1B.7-1B.8）：
 * 预检不写盘、全量写入后 rehydrate、写失败回滚（恢复旧值/删除新增 key）。
 */
import { describe, expect, it, vi } from 'vitest'
import { importConfigurationTransaction } from '../importConfigurationTransaction'
import { preflightImportPayload } from '../../../configExportImport'
import { MemoryStorage } from '../../../test/memoryStorage'

const PROFILES_KEY = 'pylon-profiles'
const WINDOW_KEY = 'pylon-window-size'

function validPayload(): string {
  return JSON.stringify({
    app: 'pylon',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      [PROFILES_KEY]: JSON.stringify({ version: 1, profiles: [{ id: 'a', name: 'A', persona: 'p', model: 'm' }], activeProfileId: 'a' }),
      [WINDOW_KEY]: '{"width":1200,"height":800}',
    },
  })
}

function createDeps(overrides: Partial<Parameters<typeof importConfigurationTransaction>[1]> = {}) {
  const calls: string[] = []
  const storage = new MemoryStorage({
    initial: { [PROFILES_KEY]: '{"version":1,"profiles":[{"id":"old"}],"activeProfileId":"old"}' },
  })
  const deps = {
    storage,
    preflight: preflightImportPayload,
    rehydrate: () => { calls.push('rehydrate') },
    reportError: vi.fn(),
    ...overrides,
  }
  return { deps, calls, storage }
}

describe('importConfigurationTransaction', () => {
  it('成功：预检 → 全量写 → rehydrate，返回 keys', async () => {
    const { deps, calls, storage } = createDeps()
    const result = await importConfigurationTransaction(validPayload(), deps)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.sort()).toEqual([PROFILES_KEY, WINDOW_KEY])
    expect(calls).toEqual(['rehydrate'])
    expect(JSON.parse(storage.getItem(WINDOW_KEY)!)).toEqual({ width: 1200, height: 800 })
  })

  it('预检失败：validation，不写盘不 rehydrate', async () => {
    const { deps, calls, storage } = createDeps()
    const result = await importConfigurationTransaction('{"app":"evil"}', deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('validation')
    expect(calls).toEqual([])
    expect(storage.getItem(PROFILES_KEY)).toContain('"old"')
  })

  it('超大配置拒绝（报告 8.10 大小限制）', async () => {
    const { deps, calls } = createDeps()
    const huge = '{"app":"pylon","version":1,"data":{"pylon-theme":"' + 'x'.repeat(600 * 1024) + '"}}'
    const result = await importConfigurationTransaction(huge, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('过大')
    expect(calls).toEqual([])
  })

  it('原型污染字段（__proto__/constructor）被白名单拒绝', async () => {
    const { deps, calls } = createDeps()
    const payload = JSON.stringify({
      app: 'pylon',
      version: 1,
      data: {
        'pylon-theme': '{}',
        '__proto__': '{polluted:true}',
        'constructor': 'x',
        'prototype': 'y',
      },
    })
    const result = await importConfigurationTransaction(payload, deps)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(['pylon-theme'])
    expect(calls).toEqual(['rehydrate'])
    expect(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf({}), 'polluted')).toBe(false)
  })

  it('写入失败：回滚恢复旧值、新增 key 删除，transport', async () => {
    const { deps, calls } = createDeps()
    const failing = new MemoryStorage({ initial: { [PROFILES_KEY]: '{"version":1,"profiles":[{"id":"old"}],"activeProfileId":"old"}' } })
    failing.setFailKeys([WINDOW_KEY])
    const result = await importConfigurationTransaction(validPayload(), { ...deps, storage: failing })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('transport')
    expect(calls).toEqual([])
    expect(failing.getItem(PROFILES_KEY)).toContain('"old"')
    expect(failing.getItem(WINDOW_KEY)).toBeNull()
  })

  it('rehydrate 失败：mismatch（配置已写入）', async () => {
    const { deps, storage } = createDeps({
      rehydrate: () => { throw new Error('refresh failed') },
    })
    const result = await importConfigurationTransaction(validPayload(), deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('mismatch')
    expect(storage.getItem(WINDOW_KEY)).not.toBeNull()
  })
})
