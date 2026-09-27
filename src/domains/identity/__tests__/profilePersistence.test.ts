// 迁移自 scripts/test-profile-persistence.mts（P91 A1）。
// normalize 回退契约：PROFILE_SCHEMA_VERSION 元数据 + normalizeProfileState 的
// activeProfileId 保留/悬空回退/空集合恢复默认。逐断言平移；夹具保持部分字段对象
// （锁「宽容列表原样保留、不做单条 normalize」的既有语义）。
import { describe, expect, it } from 'vitest'
import { normalizeProfileState, PROFILE_SCHEMA_VERSION, type PersistedProfile } from '../profilePersistence.ts'

const defaults = [
  { id: 'profile-a' },
  { id: 'profile-b' },
] as PersistedProfile[]

describe('profilePersistence normalize 回退（原 test-profile-persistence.mts）', () => {
  it('PROFILE_SCHEMA_VERSION 应为正整数', () => {
    expect(typeof PROFILE_SCHEMA_VERSION).toBe('number')
    expect(Number.isInteger(PROFILE_SCHEMA_VERSION)).toBe(true)
    expect(PROFILE_SCHEMA_VERSION > 0).toBe(true)
  })

  it('有效 activeProfileId 应保留', () => {
    expect(normalizeProfileState(defaults, 'profile-b', defaults)).toEqual({
      profiles: defaults,
      activeProfileId: 'profile-b',
    })
  })

  it('悬空 activeProfileId 应回退到首个有效 Profile', () => {
    expect(normalizeProfileState(defaults, 'missing', defaults)).toEqual({
      profiles: defaults,
      activeProfileId: 'profile-a',
    })
  })

  it('空或损坏的 Profile 集合应恢复默认值', () => {
    expect(normalizeProfileState([], 'missing', defaults)).toEqual({
      profiles: defaults,
      activeProfileId: 'profile-a',
    })
  })
})
