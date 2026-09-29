/**
 * themeDefaults — 主题默认值真值表（D2：从 store.ts 移入域，node 可 import）。
 *
 * 标量默认由 defs 派生（THEME_DEFAULTS）+ 对象/复合字段（ccLayout/ccHidden/ccHiddenEmpty/META 路由）显式声明。
 * 加标量字段：defs 加声明 + THEME_DEFAULTS 加默认值即可。
 * 完整性由 test-defaults-completeness.mts 运行时断言（Q1：不做类型体操）。
 */
import { THEME_DEFAULTS } from './themeFieldDefs.ts'
import { cloneCcLayout, DEFAULT_CC_LAYOUT } from '../cc/ccLayoutState.ts'
import { PRESET_ZONES } from './presetReducer.ts'
import type { ThemeSettings } from './themeStore.ts'

export const DEFAULTS: ThemeSettings = {
  ...THEME_DEFAULTS,
  ccHidden: [],
  // ★ #266 刀2：显隐的**空态切面**。基准值 = 出厂空态（那 6 件）—— 也就是刀2 之前硬编码在
  //   `widgetDefinitions.ts` 里的那份名单，逐字搬到这里当**基准**：没套任何预设时（新装 / 未登记
  //   界面模式），空态仍保持「极简」（只有输入栏）。
  //   ★ 为什么不是空数组：空数组 = "空态什么都不藏" ⇒ 新装的空态会突然多出状态行与发送按钮，
  //     那是**产品行为变化**，本刀只搬位置、不改变观感（既有测试 `mountSolidControlCenterPreview`
  //     的「04b 空态极简」锁的就是这件事）。
  //   「预设没写空态切面 ⇒ 回落该预设的常态切面」这条回落**不在这里**，在预设落值那一步
  //   （`presetReducer.inheritCcEmptySlice`，按"预设里有没有这个键"判）。
  ccHiddenEmpty: ['model', 'reasoning', 'mode', 'tokens', 'cc-send-button', 'cc-command-hint'],
  ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
  ccEditMode: false,
  // appliedPreset/custom 键集由 PRESET_ZONES 派生（单一真值，不平行维护）
  appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, ''])) as Record<string, string>,
  custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])) as Record<string, boolean>,
} as unknown as ThemeSettings
