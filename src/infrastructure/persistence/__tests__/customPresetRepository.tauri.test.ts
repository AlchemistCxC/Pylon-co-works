/**
 * #448 PR5 customPresetRepository 测试——Tauri 后端权威接线：
 * - hydrate：后端有值且异于本地 → 以后端为准 setState（不回写）
 * - hydrate：后端无值 + 本地非空 → 一次性写穿（含旧 pylon-theme 搬家产物）
 * - 写穿桥：hydrate 后本地变更 → 盲写 user_data_save；对账落地不回写（guard）
 * - 后端不可用 → 吞错（不阻断启动）
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
vi.mock('../../../app/runtimeError.ts', () => ({
  reportRuntimeError: vi.fn(() => ({})),
  resolveRuntimeErrors: vi.fn(),
}))

const PRESET_A = { id: 'custom-a', name: 'A', theme: { chatFontSize: 14 }, createdAt: 1, updatedAt: 1 }
const PRESET_B = { id: 'custom-b', name: 'B', theme: { chatFontSize: 18 }, createdAt: 2, updatedAt: 2 }

// vi.resetModules 后 repository 与 store 必须同图取用（静态 import 会停留在
// reset 前的旧实例上，对账 setState 打到旧 store）——每用例动态 import。
async function load() {
  const { hydrateCustomPresetsFromBackend } = await import('../customPresetRepository')
  const { useCustomPresetStore } = await import('../../../domains/theme/customPresetStore.ts')
  return { hydrateCustomPresetsFromBackend, useCustomPresetStore }
}

let fakeInvoke: FakeInvoke

beforeEach(() => {
  vi.resetModules()
  fakeInvoke = new FakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  localStorage.clear()
})

describe('Tauri 模式（IS_TAURI=true）', () => {
  it('hydrate：后端有值且异于本地 → 以后端为准 setState，不回写', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 4, payload: { version: 1, customPresets: [PRESET_B], zonePresetEntries: [] },
    }))
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    await hydrateCustomPresetsFromBackend()
    expect(useCustomPresetStore.getState().customPresets.map(p => p.id)).toEqual(['custom-b'])
    // 对账落地不触发写穿（唯一一次 save 都不应出现）
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
  })

  it('hydrate：后端无值 + 本地非空 → 一次性写穿（envelope 形状带 version）', async () => {
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    await hydrateCustomPresetsFromBackend()
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'user_data_save',
      args: {
        key: 'custom-presets',
        payload: expect.objectContaining({ version: 1, customPresets: [PRESET_A] }),
        expectedRevision: null,
      },
    })
  })

  it('hydrate：后端无值 + 本地空 → 不写后端', async () => {
    fakeInvoke.register('user_data_load', () => null)
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [], zonePresetEntries: [] })
    await hydrateCustomPresetsFromBackend()
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
  })

  it('写穿桥：hydrate 后本地删除 → 盲写最新切片（latest-wins）', async () => {
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    await hydrateCustomPresetsFromBackend()
    // 桥已装：本地变更写穿
    fakeInvoke.calls.length = 0
    useCustomPresetStore.getState().removeCustomPreset('custom-a')
    await new Promise(resolve => globalThis.setTimeout(resolve, 0))
    const saveCalls = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saveCalls.length).toBeGreaterThanOrEqual(1)
    const last = saveCalls.at(-1)!
    expect((last.args as { payload: { customPresets: unknown[] } }).payload.customPresets).toHaveLength(0)
  })

  it('hydrate：后端不可用 → 吞错不抛（启动不降级）', async () => {
    fakeInvoke.register('user_data_load', () => { throw new Error('user_data_unavailable') })
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    await expect(hydrateCustomPresetsFromBackend()).resolves.toBeUndefined()
    expect(useCustomPresetStore.getState().customPresets.map(p => p.id)).toEqual(['custom-a'])
  })
})
