// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clampLeftRailWidth } from '../layoutRailsStore.ts'

/**
 * A-V12：showPet 并入 layoutRailsStore（envelope v3→v4）。
 * 持久化键名不变（ADR-0009）；v3 envelope（无 showPet）经 migrate 从旧独立 key
 * `pylon-workspace-show-pet` 一次性搬家并删除；migrate 内 clamp 复用单一实现。
 */

const LAYOUT_KEY = 'pylon-workspace-layout-v3'
const LEGACY_PET_KEY = 'pylon-workspace-show-pet'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

async function importFreshStore() {
  return await import('../layoutRailsStore.ts')
}

describe('layoutRailsStore v3→v4（A-V12 showPet 并入 + migrate clamp 复用）', () => {
  it('v3 envelope 迁移：showPet 从旧独立 key 搬家、旧 key 删除、envelope 回写为 v4', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      state: { leftRailWidth: 250, leftRailCollapsed: false, collapsed: false, width: 320 },
      version: 3,
    }))
    localStorage.setItem(LEGACY_PET_KEY, 'false')
    const { useRightRailStore } = await importFreshStore()

    expect(useRightRailStore.getState().showPet).toBe(false)
    expect(localStorage.getItem(LEGACY_PET_KEY)).toBeNull()
    const envelope = JSON.parse(localStorage.getItem(LAYOUT_KEY)!) as { state: { showPet: boolean }; version: number }
    expect(envelope.version).toBe(4)
    expect(envelope.state.showPet).toBe(false)
  })

  it('v3 envelope + 无旧 key：showPet 缺省 true', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ state: { width: 320 }, version: 3 }))
    const { useRightRailStore } = await importFreshStore()
    expect(useRightRailStore.getState().showPet).toBe(true)
  })

  it('v4 envelope 原样读回；setShowPet 写穿', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      state: { showPet: false, width: 320 },
      version: 4,
    }))
    const { useRightRailStore } = await importFreshStore()
    expect(useRightRailStore.getState().showPet).toBe(false)
    useRightRailStore.getState().setShowPet(true)
    const envelope = JSON.parse(localStorage.getItem(LAYOUT_KEY)!) as { state: { showPet: boolean } }
    expect(envelope.state.showPet).toBe(true)
  })

  it('migrate 的左栏宽度走单一 clamp（NaN 等非有限值回落默认，不再产出 NaN）', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ state: { leftRailWidth: Number.NaN }, version: 3 }))
    const { useRightRailStore, LEFT_RAIL_DEFAULT_WIDTH } = await importFreshStore()
    expect(useRightRailStore.getState().leftRailWidth).toBe(LEFT_RAIL_DEFAULT_WIDTH)
    expect(clampLeftRailWidth(Number.NaN)).toBe(LEFT_RAIL_DEFAULT_WIDTH)
  })
})
