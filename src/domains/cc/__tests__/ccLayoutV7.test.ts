import { describe, expect, it } from 'vitest'
import { CC_LAYOUT_SCHEMA_VERSION, DEFAULT_CC_LAYOUT, normalizeCcLayout } from '../../../ccLayoutState.ts'
import { CC_WIDGET_IDS } from '../widgetDefinitions.ts'

describe('Control Center layout v7', () => {
  it('默认布局覆盖全部 widget，新增上下文控件使用稳定槽位', () => {
    expect(CC_LAYOUT_SCHEMA_VERSION).toBe(7)
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements).sort()).toEqual([...CC_WIDGET_IDS].sort())
    expect(DEFAULT_CC_LAYOUT.placements.session).toMatchObject({ slot: 'status-secondary', order: 0 })
    expect(DEFAULT_CC_LAYOUT.placements.workspace).toMatchObject({ slot: 'status-secondary', order: 1 })
    expect(DEFAULT_CC_LAYOUT.placements.activity).toMatchObject({ slot: 'status-primary', order: 0 })
  })

  it('v6 用户布局保留旧控件位置并补入新控件', () => {
    const legacy = {
      version: 6,
      placements: {
        ...DEFAULT_CC_LAYOUT.placements,
        model: { slot: 'actions' as const, order: 9, offsetX: 12, offsetY: -4 },
      },
    }
    delete (legacy.placements as Partial<typeof legacy.placements>).session
    delete (legacy.placements as Partial<typeof legacy.placements>).workspace
    delete (legacy.placements as Partial<typeof legacy.placements>).activity
    const normalized = normalizeCcLayout(legacy)
    expect(normalized.placements.model).toMatchObject({ slot: 'actions', order: 9, offsetX: 12, offsetY: -4 })
    expect(normalized.placements.session).toEqual(DEFAULT_CC_LAYOUT.placements.session)
    expect(normalized.placements.workspace).toEqual(DEFAULT_CC_LAYOUT.placements.workspace)
    expect(normalized.placements.activity).toEqual(DEFAULT_CC_LAYOUT.placements.activity)
  })
})
