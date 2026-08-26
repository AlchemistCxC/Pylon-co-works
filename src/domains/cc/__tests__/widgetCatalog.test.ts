import { describe, expect, it } from 'vitest'
import { DEFAULT_CC_LAYOUT } from '../../../ccLayoutState.ts'
import {
  BUILTIN_CC_WIDGET_CONTRIBUTIONS,
  CC_WIDGET_IDS,
} from '../widgetCatalog.ts'

const VALID_SLOTS = new Set(['input', 'status-primary', 'status-secondary', 'actions'])

describe('Control Center widget catalog', () => {
  it('keeps ids and default placements in sync', () => {
    const catalogIds = BUILTIN_CC_WIDGET_CONTRIBUTIONS.map(item => item.id)
    expect(new Set(catalogIds).size).toBe(catalogIds.length)
    expect([...catalogIds].sort()).toEqual([...CC_WIDGET_IDS].sort())
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements).sort()).toEqual([...catalogIds].sort())
  })

  it('declares property fields and legal default placements for every widget', () => {
    for (const item of BUILTIN_CC_WIDGET_CONTRIBUTIONS) {
      expect(item.propertyFields).toBeDefined()
      const { slot, order, offsetX, offsetY } = item.defaultPlacement
      expect(VALID_SLOTS.has(slot)).toBe(true)
      expect(Number.isInteger(order)).toBe(true)
      expect(order).toBeGreaterThanOrEqual(0)
      expect(order).toBeLessThanOrEqual(99)
      expect(Number.isFinite(offsetX)).toBe(true)
      expect(Number.isFinite(offsetY)).toBe(true)
      expect(offsetX).toBeGreaterThanOrEqual(-48)
      expect(offsetX).toBeLessThanOrEqual(48)
      expect(offsetY).toBeGreaterThanOrEqual(-16)
      expect(offsetY).toBeLessThanOrEqual(16)
    }
  })

  it('derives DEFAULT_CC_LAYOUT placements from catalog contributions', () => {
    for (const item of BUILTIN_CC_WIDGET_CONTRIBUTIONS) {
      expect(DEFAULT_CC_LAYOUT.placements[item.id]).toEqual(item.defaultPlacement)
    }
  })
})
