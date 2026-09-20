import { describe, expect, it } from 'vitest'
import { CC_LAYOUT_SCHEMA_VERSION, DEFAULT_CC_LAYOUT, normalizeCcLayout, type CcLayoutV3 } from '../../../ccLayoutState.ts'
import { CC_WIDGET_IDS } from '../widgetDefinitions.ts'

describe('Control Center layout v9（刀4 名单换代）', () => {
  it('默认布局覆盖全部可落槽控件，新增上下文控件使用稳定槽位', () => {
    expect(CC_LAYOUT_SCHEMA_VERSION).toBe(9)
    // 可落槽控件 = 内置轨 ∪ 注册轨中占槽位者（cc-send-button）
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements).sort()).toEqual([...CC_WIDGET_IDS, 'cc-send-button'].sort())
    // S11：pct 并入 tokens；用量控件默认排在权限控件右侧
    expect(DEFAULT_CC_LAYOUT.placements.tokens).toMatchObject({ slot: 'status-secondary', order: 5 })
    // 刀4：legacy `send` 的槽位事实迁到注册轨 id
    expect(DEFAULT_CC_LAYOUT.placements['cc-send-button']).toMatchObject({ slot: 'actions', order: 0 })
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).not.toContain('pct')
    // 刀4 删除的 5 个 id 不得再出现在默认布局里
    for (const id of ['session', 'workspace', 'activity', 'ekg', 'send', 'tasks']) {
      expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).not.toContain(id)
    }
  })

  it('v6 用户布局保留旧控件位置，legacy `send` 迁到 cc-send-button', () => {
    // v6 时代磁盘上只有 legacy `send`（没有 `cc-send-button` 这个键）
    const legacyPlacements: Record<string, unknown> = { ...DEFAULT_CC_LAYOUT.placements }
    delete legacyPlacements['cc-send-button']
    legacyPlacements.model = { slot: 'actions', order: 9, offsetX: 12, offsetY: -4 }
    legacyPlacements.send = { slot: 'actions', order: 7, offsetX: 4, offsetY: -2 }

    const normalized = normalizeCcLayout({ version: 6, placements: legacyPlacements } as unknown as Partial<CcLayoutV3>)
    expect(normalized.placements.model).toMatchObject({ slot: 'actions', order: 9, offsetX: 12, offsetY: -4 })
    // 刀4 数据迁移：键名换、位置不动
    expect(normalized.placements['cc-send-button']).toMatchObject({ slot: 'actions', order: 7, offsetX: 4, offsetY: -2 })
  })

  it('v8 老布局不被重置（版本白名单显式含 8）', () => {
    const v8 = {
      version: 8,
      placements: {
        model: { slot: 'actions' as const, order: 9, offsetX: 11, offsetY: -3 },
      },
    }
    const normalized = normalizeCcLayout(v8 as unknown as Partial<CcLayoutV3>)
    expect(normalized.version).toBe(CC_LAYOUT_SCHEMA_VERSION)
    expect(normalized.placements.model).toMatchObject({ slot: 'actions', order: 9, offsetX: 11, offsetY: -3 })
    // 未提供的老键回落默认布局
    expect(normalized.placements.tokens).toEqual(DEFAULT_CC_LAYOUT.placements.tokens)
  })

  it('v7 老布局不被重置（版本白名单补 7，#197）', () => {
    // v7 时代磁盘上还是旧名单（含 session / ekg 等已删 id）与 legacy `send`
    const v7 = {
      version: 7,
      placements: {
        model: { slot: 'actions' as const, order: 9, offsetX: 11, offsetY: -3 },
        tokens: { slot: 'status-primary' as const, order: 1, offsetX: -2, offsetY: 4 },
        session: { slot: 'status-secondary' as const, order: 6, offsetX: 0, offsetY: 0 },
        ekg: { slot: 'status-primary' as const, order: 2, offsetX: 3, offsetY: 1 },
        send: { slot: 'actions' as const, order: 4, offsetX: 8, offsetY: -1 },
      },
    }
    const normalized = normalizeCcLayout(v7 as unknown as Partial<CcLayoutV3>)
    expect(normalized.version).toBe(CC_LAYOUT_SCHEMA_VERSION)
    // 现役 id 的位置保留
    expect(normalized.placements.model).toMatchObject({ slot: 'actions', order: 9, offsetX: 11, offsetY: -3 })
    expect(normalized.placements.tokens).toMatchObject({ slot: 'status-primary', order: 1, offsetX: -2, offsetY: 4 })
    // legacy `send` 键名换、位置不动
    expect(normalized.placements['cc-send-button']).toMatchObject({ slot: 'actions', order: 4, offsetX: 8, offsetY: -1 })
    // 已删 id 自然丢弃
    expect(Object.keys(normalized.placements)).not.toContain('session')
    expect(Object.keys(normalized.placements)).not.toContain('ekg')
  })

  it('不在白名单里的版本整份回落默认布局', () => {
    const v2 = { version: 2, placements: { model: { slot: 'actions' as const, order: 9, offsetX: 11, offsetY: -3 } } }
    const normalized = normalizeCcLayout(v2 as unknown as Partial<CcLayoutV3>)
    expect(normalized.placements.model).toEqual(DEFAULT_CC_LAYOUT.placements.model)
  })
})
