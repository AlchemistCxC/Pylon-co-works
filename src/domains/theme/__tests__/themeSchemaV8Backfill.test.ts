import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../themeDefaults.ts'
import { THEME_FIELD_DEFS } from '../../../themeFieldDefs.ts'
import { PRESET_ZONES } from '../presetReducer.ts'
import { THEME_SCHEMA_VERSION, themeDomainMigrate } from '../migration.ts'
import { CC_LAYOUT_SCHEMA_VERSION, DEFAULT_CC_LAYOUT } from '../../../ccLayoutState.ts'

const defaults = {
  base: DEFAULTS,
  appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, ''])),
  custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  ccLayout: DEFAULTS.ccLayout,
}

type Migrated = { ccLayout: { placements: Record<string, { slot: string; order: number }> } }

describe('theme schema v8：老安装补入 reasoning 控件', () => {
  // 回归锚点：不 bump 版本号，存量 v7 安装的 migrate 钩子不触发，
  // normalizeCcLayout 的补位逻辑就永远跑不到 —— 控件在老浏览器里永远不出现。
  it('持久化版本已推进到 9（v8 的补位逻辑仍然生效）', () => {
    expect(THEME_SCHEMA_VERSION).toBe(9)
  })

  it('存量 v7 布局缺 reasoning 时，migrate 后补入默认位置', () => {
    const legacyPlacements: Record<string, unknown> = { ...DEFAULT_CC_LAYOUT.placements }
    delete legacyPlacements.reasoning // 老浏览器存的清单里没有这一项
    const migrated = themeDomainMigrate({
      ccLayout: { version: CC_LAYOUT_SCHEMA_VERSION, placements: legacyPlacements },
    }, defaults, 7) as unknown as Migrated

    expect(migrated.ccLayout.placements.reasoning).toBeTruthy()
    expect(migrated.ccLayout.placements.reasoning).toMatchObject({ slot: 'status-secondary', order: 3 })
    // 既有控件不被踩掉：补位是按 widget ID 合并，不是整表替换
    expect(migrated.ccLayout.placements.mode).toMatchObject({ slot: 'status-secondary', order: 4 })
    expect(migrated.ccLayout.placements.model).toMatchObject({ slot: 'status-secondary', order: 2 })
  })

  it('用户已拖过的 reasoning 位置不被默认值覆盖（迁移可重复执行）', () => {
    const placements = {
      ...DEFAULT_CC_LAYOUT.placements,
      reasoning: { slot: 'actions' as const, order: 9, offsetX: 7, offsetY: -3 },
    }
    const migrated = themeDomainMigrate({
      ccLayout: { version: CC_LAYOUT_SCHEMA_VERSION, placements },
    }, defaults, 8) as unknown as Migrated

    expect(migrated.ccLayout.placements.reasoning).toMatchObject({ slot: 'actions', order: 9 })
  })
})

describe('theme schema v9：老安装补入权限控件字段组（S10）', () => {
  // 回归锚点（2026-09-15）：控件 id `mode` 早已存在、布局无需补位，但 permission* 是新增
  // 字段。字段归一化只挂在 migrate 钩子上 —— 不 bump，存量安装里这 7 个键永远是
  // undefined，权限控件会按 NaN 尺寸渲染。
  it('存量 v8 主题缺 permission* 时，migrate 后补入默认值', () => {
    const legacy: Record<string, unknown> = { ...DEFAULTS }
    delete legacy.permissionSwitchMode
    delete legacy.permissionTextColor
    delete legacy.permissionWidth

    const migrated = themeDomainMigrate(legacy, defaults, 8)

    expect(migrated.permissionSwitchMode).toBe('menu')
    expect(migrated.permissionTextColor).toBe('mode')
    expect(migrated.permissionWidth).toBe(120)
  })

  it('旧字段 pillBg 已从字段表移除（存量残留键不再被任何设置项/控件读取）', () => {
    // 迁移会原样保留未知的旧键（无害），真正的保证是字段表里已经没有它 ——
    // 设置面板不再暴露、主题变量注入不再生成 --pill-bg。
    expect(Object.keys(THEME_FIELD_DEFS)).not.toContain('pillBg')
    expect(Object.keys(DEFAULTS)).not.toContain('pillBg')
  })
})
