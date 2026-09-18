import { describe, expect, it } from 'vitest'
import { normalizeZoneRecord } from '../migration.ts'
import { PRESET_ZONES } from '../presetReducer.ts'

const DEFAULTS: Record<string, string> = {
  global: 'g-default',
  sidebar: 's-default',
  chat: 'c-default',
  cc: 'cc-default',
  right: 'r-default',
}

const isString = (item: unknown): item is string => typeof item === 'string'

describe('normalizeZoneRecord', () => {
  it('非法值回落 defaults[zone]，合法值原样保留', () => {
    const result = normalizeZoneRecord(
      { global: 'g-kept', sidebar: 42, chat: null, cc: undefined, right: 'r-kept' },
      DEFAULTS,
      isString,
    )

    expect(result).toEqual({
      global: 'g-kept',
      sidebar: 's-default',
      chat: 'c-default',
      cc: 'cc-default',
      right: 'r-kept',
    })
  })

  it('只保留 PRESET_ZONES 的键，区域轴外的键必须被丢弃', () => {
    const result = normalizeZoneRecord(
      { global: 'g-kept', leftover: 'must-be-dropped', ccLayout: 'must-be-dropped' },
      DEFAULTS,
      isString,
    )

    expect(Object.keys(result).sort()).toEqual([...PRESET_ZONES].sort())
    expect('leftover' in result).toBe(false)
    expect('ccLayout' in result).toBe(false)
  })

  it('非对象输入（null / 字符串等）→ 全默认', () => {
    for (const input of [null, undefined, 'nope', 42, true]) {
      expect(normalizeZoneRecord(input, DEFAULTS, isString)).toEqual(DEFAULTS)
    }
  })
})
