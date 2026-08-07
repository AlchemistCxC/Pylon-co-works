/**
 * FE-AUD-002 行为回归（阶段 0，先 RED）：Profile 持久化。
 *
 * 目标行为：addProfile/setActiveProfile/removeProfile 的变更落 `pylon-profiles`
 * versioned envelope；删除 Profile 时 active 原子 fallback；配置导出/导入白名单
 * 包含 profiles。当前实现（2026-08-07）无任何 Profile 写盘 → 本文件应 RED。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useIdentityStore } from '../identityStore'
import { resetStores } from '../test/resetStores'
import { buildExportPayload, applyImportPayload } from '../configExportImport'

const PROFILE_KEY = 'pylon-profiles'

interface PersistedProfiles {
  version: number
  profiles: Array<{ id: string; name: string; persona: string; model: string; avatar?: string }>
  activeProfileId: string
}

function readPersistedProfiles(): PersistedProfiles {
  const raw = localStorage.getItem(PROFILE_KEY)
  expect(raw).not.toBeNull()
  return JSON.parse(raw!) as PersistedProfiles
}

const NEO = { id: 'neo', name: 'Neo', persona: '测试 persona', model: 'deepseek-v4-flash' }

describe('FE-AUD-002 Profile 持久化', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('addProfile 后持久化包含新 profile（当前实现无写盘 → RED）', () => {
    useIdentityStore.getState().addProfile(NEO)
    const persisted = readPersistedProfiles()
    expect(persisted.profiles.some(profile => profile.id === 'neo')).toBe(true)
  })

  it('setActiveProfile 后持久化 activeProfileId（当前实现 → RED）', () => {
    useIdentityStore.getState().addProfile(NEO)
    useIdentityStore.getState().setActiveProfile('neo')
    expect(readPersistedProfiles().activeProfileId).toBe('neo')
  })

  it('removeProfile 后持久化移除并 active fallback（当前实现 → RED）', () => {
    useIdentityStore.getState().addProfile(NEO)
    useIdentityStore.getState().setActiveProfile('neo')
    useIdentityStore.getState().removeProfile('neo')
    const persisted = readPersistedProfiles()
    expect(persisted.profiles.some(profile => profile.id === 'neo')).toBe(false)
    expect(persisted.profiles.length).toBeGreaterThan(0)
    expect(persisted.activeProfileId).not.toBe('neo')
  })

  it('编辑 Profile 字段（name/persona/model）持久化（当前实现 → RED）', () => {
    useIdentityStore.getState().addProfile({ ...NEO, name: 'Neo 改' })
    const persisted = readPersistedProfiles()
    expect(persisted.profiles.find(profile => profile.id === 'neo')?.name).toBe('Neo 改')
  })

  it('配置导出包含 profiles（当前白名单无 → RED）', () => {
    useIdentityStore.getState().addProfile(NEO)
    const envelope = JSON.parse(buildExportPayload(localStorage)) as { data: Record<string, string> }
    expect(envelope.data[PROFILE_KEY]).toBeDefined()
  })

  it('配置导入接受 profiles key（当前白名单拒绝 → RED）', () => {
    const payload = JSON.stringify({
      app: 'pylon',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        [PROFILE_KEY]: JSON.stringify({ version: 1, profiles: [NEO], activeProfileId: 'neo' }),
      },
    })
    const result = applyImportPayload(localStorage, payload)
    expect(result.ok).toBe(true)
    expect(localStorage.getItem(PROFILE_KEY)).not.toBeNull()
  })

  it('旧 pylon-theme 内嵌 profile 一次性迁移落新 key（报告 1B.5）', () => {
    const legacy = { id: 'legacy', name: 'Legacy', persona: 'p', model: 'm' }
    localStorage.setItem('pylon-theme', JSON.stringify({ state: { profiles: [legacy], activeProfileId: 'legacy' } }))
    useIdentityStore.getState().hydrateProfiles({ profiles: [legacy], activeProfileId: 'legacy' })
    const persisted = readPersistedProfiles()
    expect(persisted.profiles.some(profile => profile.id === 'legacy')).toBe(true)
    expect(persisted.activeProfileId).toBe('legacy')
  })

  it('新 key 存在时旧 theme 数据不反向覆盖（报告 1B.5）', () => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ version: 1, profiles: [NEO], activeProfileId: 'neo' }))
    useIdentityStore.getState().hydrateProfiles({ profiles: [{ id: 'legacy', name: 'Legacy', persona: 'p', model: 'm' }], activeProfileId: 'legacy' })
    const state = useIdentityStore.getState()
    expect(state.profiles.some(profile => profile.id === 'neo')).toBe(true)
    expect(state.profiles.some(profile => profile.id === 'legacy')).toBe(false)
  })

  it('Profile roundtrip：addProfile → 模拟重启 hydrate 恢复', () => {
    useIdentityStore.getState().addProfile(NEO)
    useIdentityStore.getState().setActiveProfile('neo')
    resetStores()
    useIdentityStore.getState().hydrateProfiles()
    const state = useIdentityStore.getState()
    expect(state.profiles.some(profile => profile.id === 'neo')).toBe(true)
    expect(state.activeProfileId).toBe('neo')
  })
})
