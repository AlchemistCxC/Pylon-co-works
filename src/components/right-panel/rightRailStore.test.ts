import { describe, expect, it } from 'vitest'
import { clampRightRailWidth, RIGHT_RAIL_DEFAULT_WIDTH, RIGHT_RAIL_MAX_WIDTH, RIGHT_RAIL_MIN_WIDTH } from './rightRailStore.ts'

describe('rightRailStore', () => {
  it('clamps persisted and drag widths to the shell contract', () => {
    expect(clampRightRailWidth(Number.NaN)).toBe(RIGHT_RAIL_DEFAULT_WIDTH)
    expect(clampRightRailWidth(RIGHT_RAIL_MIN_WIDTH - 20)).toBe(RIGHT_RAIL_MIN_WIDTH)
    expect(clampRightRailWidth(RIGHT_RAIL_MAX_WIDTH + 20)).toBe(RIGHT_RAIL_MAX_WIDTH)
    expect(clampRightRailWidth(321.7)).toBe(322)
  })
})
