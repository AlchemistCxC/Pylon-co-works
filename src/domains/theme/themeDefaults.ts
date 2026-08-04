/**
 * themeDefaults — 主题默认值真值表（D2：从 store.ts 移入域，node 可 import）。
 *
 * 标量默认由 defs 派生（THEME_DEFAULTS）+ 对象/复合字段（ccLayout/ccHidden/ccScale/META 路由）显式声明。
 * 加标量字段：defs 加声明 + THEME_DEFAULTS 加默认值即可。
 * 完整性由 test-defaults-completeness.mts 运行时断言（Q1：不做类型体操）。
 */
import { THEME_DEFAULTS } from '../../themeFieldDefs.ts'
import { cloneCcLayout, DEFAULT_CC_LAYOUT } from '../../ccLayoutState.ts'
import type { ThemeSettings } from '../../store.ts'

export const DEFAULTS: ThemeSettings = {
  ...THEME_DEFAULTS,
  ccHidden: [],
  ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
  ccEditMode: false,
  ccScale: {},
  appliedPreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
  custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
} as unknown as ThemeSettings
