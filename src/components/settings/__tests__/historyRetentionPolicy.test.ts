import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COUNT_LIMIT,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_TIME_DAYS,
  RETENTION_COUNT_LIMITS,
  RETENTION_MODE_OPTIONS,
  RETENTION_STORAGE_KEY,
  RETENTION_TIME_DAYS,
  isRetentionPolicyValid,
  readRetentionPolicy,
  retentionPolicyImpact,
  writeRetentionPolicy,
  type RetentionPolicy,
  type StorageLike,
} from '../historyRetentionPolicy'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value },
  }
}

describe('history retention policy contract', () => {
  it('defaults to permanent when nothing is stored', () => {
    const storage = memoryStorage()
    expect(readRetentionPolicy(storage)).toEqual(DEFAULT_RETENTION_POLICY)
  })

  it('falls back to permanent when stored value is garbage', () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: 'not-json' })
    expect(readRetentionPolicy(storage)).toEqual(DEFAULT_RETENTION_POLICY)
  })

  it('falls back to permanent when mode is unknown', () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: JSON.stringify({ mode: 'monthly' }) })
    expect(readRetentionPolicy(storage)).toEqual(DEFAULT_RETENTION_POLICY)
  })

  it('falls back to permanent when mode field is missing', () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: JSON.stringify({}) })
    expect(readRetentionPolicy(storage)).toEqual(DEFAULT_RETENTION_POLICY)
  })

  it('falls back to permanent when by_time lacks days (D-15 字段缺失)', () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: JSON.stringify({ mode: 'by_time' }) })
    expect(readRetentionPolicy(storage)).toEqual(DEFAULT_RETENTION_POLICY)
  })

  it('falls back to permanent when by_count lacks count (D-15 字段缺失)', () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: JSON.stringify({ mode: 'by_count' }) })
    expect(readRetentionPolicy(storage)).toEqual(DEFAULT_RETENTION_POLICY)
  })

  it('falls back to permanent when days is out of contract tiers', () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: JSON.stringify({ mode: 'by_time', days: 25 }) })
    expect(readRetentionPolicy(storage)).toEqual(DEFAULT_RETENTION_POLICY)
  })

  it('falls back to permanent when count is out of contract tiers', () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: JSON.stringify({ mode: 'by_count', count: 250 }) })
    expect(readRetentionPolicy(storage)).toEqual(DEFAULT_RETENTION_POLICY)
  })

  it('reads a valid by_time policy', () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: JSON.stringify({ mode: 'by_time', days: 90 }) })
    expect(readRetentionPolicy(storage)).toEqual({ mode: 'by_time', days: 90 })
  })

  it('reads a valid by_count policy', () => {
    const storage = memoryStorage({ [RETENTION_STORAGE_KEY]: JSON.stringify({ mode: 'by_count', count: 500 }) })
    expect(readRetentionPolicy(storage)).toEqual({ mode: 'by_count', count: 500 })
  })

  it('write then read roundtrips the policy', () => {
    const storage = memoryStorage()
    writeRetentionPolicy(storage, { mode: 'by_time', days: 180 })
    expect(readRetentionPolicy(storage)).toEqual({ mode: 'by_time', days: 180 })
    expect(storage.data[RETENTION_STORAGE_KEY]).toBe(JSON.stringify({ mode: 'by_time', days: 180 }))
  })

  it('shows no impact for permanent (D-15: 默认无影响)', () => {
    expect(retentionPolicyImpact(DEFAULT_RETENTION_POLICY)).toBeNull()
  })

  it('by_time impact states expected scope and no immediate delete (D-15)', () => {
    const impact = retentionPolicyImpact({ mode: 'by_time', days: 30 })
    expect(impact).not.toBeNull()
    expect(impact!.kind).toBe('warn')
    expect(impact!.text).toContain('30 天')
    expect(impact!.text).toContain('立即删除')
  })

  it('by_count impact states expected scope and no immediate delete (D-15)', () => {
    const impact = retentionPolicyImpact({ mode: 'by_count', count: 1000 })
    expect(impact).not.toBeNull()
    expect(impact!.kind).toBe('warn')
    expect(impact!.text).toContain('1000 条')
    expect(impact!.text).toContain('立即删除')
  })

  it('contract tiers and defaults match the implementation contract', () => {
    expect(RETENTION_TIME_DAYS).toEqual([7, 30, 90, 180, 365])
    expect(DEFAULT_TIME_DAYS).toBe(30)
    expect(RETENTION_COUNT_LIMITS).toEqual([100, 500, 1000, 5000, 10000])
    expect(DEFAULT_COUNT_LIMIT).toBe(1000)
  })

  it('mode options cover exactly the contract modes', () => {
    const values = RETENTION_MODE_OPTIONS.map(option => option.value)
    expect(values).toEqual(['permanent', 'by_time', 'by_count'])
    expect(RETENTION_MODE_OPTIONS.map(option => option.label)).toEqual([
      '永久保存',
      '按时间保留',
      '按每个 Session 消息数量保留',
    ])
  })

  it('isRetentionPolicyValid rejects off-contract policies', () => {
    expect(isRetentionPolicyValid({ mode: 'permanent' })).toBe(true)
    expect(isRetentionPolicyValid({ mode: 'by_time', days: 90 })).toBe(true)
    expect(isRetentionPolicyValid({ mode: 'by_count', count: 5000 })).toBe(true)
    expect(isRetentionPolicyValid({ mode: 'by_time' } as RetentionPolicy)).toBe(false)
    expect(isRetentionPolicyValid({ mode: 'by_count' } as RetentionPolicy)).toBe(false)
    expect(isRetentionPolicyValid({ mode: 'by_time', days: 25 })).toBe(false)
    expect(isRetentionPolicyValid({ mode: 'by_count', count: 250 })).toBe(false)
  })
})
