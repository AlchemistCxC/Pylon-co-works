/**
 * #448 PR2 inputPredictionSettingsRepository 测试——Tauri 模式（后端权威源）：
 * - hydrate：后端有值 → 缓存镜像；后端无值 + 旧 key 在场 → 一次性迁移（写穿 + 删旧）
 * - 迁移写穿失败 → 旧 key 保留（幂等重试）、缓存先行
 * - 后端不可用 → localStorage 值兜底（等价旧行为）且不抛（不降级启动）
 * - persist：缓存立即更新 + 盲写 user_data_save（expectedRevision=null）
 * - browser 模式：hydrate no-op；persist 写 localStorage
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
vi.mock('../../tauri/env', () => ({ IS_TAURI: true }))
vi.mock('../../app/runtimeError.ts', () => ({
  reportRuntimeError: vi.fn(() => ({})),
  resolveRuntimeErrors: vi.fn(),
}))

import {
  hydrateInputPredictionSettingsFromBackend,
  persistInputPredictionSettings,
} from '../inputPredictionSettingsRepository'
import {
  cachedInputPredictionSettings,
  updateCachedInputPredictionSettings,
} from '../../../domains/inputPrediction/inputPredictionSettingsCache'
import { DEFAULT_INPUT_PREDICTION_SETTINGS, INPUT_PREDICTION_SETTINGS_KEY } from '../../../domains/inputPrediction/inputPredictionSettings'

let fakeInvoke: FakeInvoke

const LEGACY_VALUE = { ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'standalone' as const, enabled: true, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-legacy', model: 'test-model' }

function seedLegacyKey(): void {
  globalThis.localStorage.setItem(INPUT_PREDICTION_SETTINGS_KEY, JSON.stringify(LEGACY_VALUE))
}

beforeEach(() => {
  fakeInvoke = new FakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  updateCachedInputPredictionSettings(null)
  globalThis.localStorage.removeItem(INPUT_PREDICTION_SETTINGS_KEY)
})

describe('Tauri 模式（IS_TAURI=true）', () => {
  it('hydrate：后端有值 → normalize 入缓存（同步读面立即可见）', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1,
      revision: 2,
      payload: { version: 1, mode: 'fork', enabled: true, apiKey: 'sk-backend' },
    }))
    await hydrateInputPredictionSettingsFromBackend()
    expect(cachedInputPredictionSettings().mode).toBe('fork')
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-backend')
  })

  it('hydrate：后端无值 + 旧 key 在场 → 写穿后端并删旧 key（一次性迁移）', async () => {
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    seedLegacyKey()
    await hydrateInputPredictionSettingsFromBackend()
    // 写穿 payload 自带 envelope version
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'user_data_save',
      args: {
        key: 'input-prediction',
        payload: expect.objectContaining({ version: 1, apiKey: 'sk-legacy', mode: 'standalone' }),
        expectedRevision: null,
      },
    })
    expect(globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY)).toBeNull()
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-legacy')
  })

  it('hydrate：后端无值 + 旧 key 缺席 → 默认入缓存，不写后端', async () => {
    fakeInvoke.register('user_data_load', () => null)
    await hydrateInputPredictionSettingsFromBackend()
    expect(cachedInputPredictionSettings()).toEqual(DEFAULT_INPUT_PREDICTION_SETTINGS)
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
  })

  it('hydrate：迁移写穿失败 → 旧 key 保留（下次幂等重试），缓存先行', async () => {
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => { throw new Error('user_data_unavailable') })
    seedLegacyKey()
    await expect(hydrateInputPredictionSettingsFromBackend()).resolves.toBeUndefined()
    expect(globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY)).not.toBeNull()
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-legacy')
  })

  it('hydrate：后端不可用 → localStorage 值兜底入缓存且不抛（启动不降级）', async () => {
    fakeInvoke.register('user_data_load', () => { throw new Error('backend down') })
    seedLegacyKey()
    await expect(hydrateInputPredictionSettingsFromBackend()).resolves.toBeUndefined()
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-legacy')
  })

  it('persist：缓存立即更新 + 盲写 user_data_save（latest-wins）', async () => {
    fakeInvoke.register('user_data_save', () => ({ revision: 3 }))
    const next = { ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'off' as const }
    persistInputPredictionSettings(next)
    // 缓存同步生效（保存路径 fire-and-forget 不阻塞 UI）
    expect(cachedInputPredictionSettings().mode).toBe('off')
    await new Promise(resolve => globalThis.setTimeout(resolve, 0))
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'user_data_save',
      args: { key: 'input-prediction', payload: expect.objectContaining({ version: 1, mode: 'off' }), expectedRevision: null },
    })
    // Tauri 模式不写 localStorage（后端单一权威）
    expect(globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY)).toBeNull()
  })

  it('persist：后端写穿失败 → 缓存不回滚（下一次保存整份重发自愈）', async () => {
    fakeInvoke.register('user_data_save', () => { throw new Error('db busy') })
    persistInputPredictionSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS, apiKey: 'sk-keep' })
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-keep')
    await new Promise(resolve => globalThis.setTimeout(resolve, 0))
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-keep')
  })
})
