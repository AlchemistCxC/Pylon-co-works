/**
 * 区域层 · 出厂区域预设数据 —— gui 桶 / global 区域（刀2 / #223）。
 *
 * ★ **本文件是出厂区域预设的落盘数据（刀2 / #223 产出）；生成脚本已于刀3 删除，请勿手改。**
 *   它是**唯一真值**：10 套出厂预设的有效值由它算出（`effectivePresetTheme`）——
 *   改这里的任何一个值，等于改掉所有引用它的预设。历史来源见 `.agents/records/issue-223-factory-zone-presets-as-data.md`。
 * 值 = 生成时刻的 `pickZoneFields(GLOBAL_PRESETS[来源].theme, 'global')`，逐字段照抄
 * （含终端补全烘入的默认值；cc 区含 ccLayout/ccHidden 两个元件名单字段）。
 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'

export const FACTORY_GUI_GLOBAL: readonly ZonePresetEntry[] = [
  {
    id: 'glass',
    mode: 'gui',
    zone: 'global',
    label: 'Glass Light',
    origin: 'factory',
    source: { presetName: 'glass' },
    values: {
      accent: "#6366f1",
      transparency: 0.9,
      bgBlur: 24,
      globalFontSize: 17,
      globalBgColor: "#f0f0f5",
      titlebarBg: "rgba(245,245,250,0.72)",
      titlebarTextColor: "rgba(0,0,0,0.78)",
      userColor: "#6366f1",
    },
  },
  {
    id: 'solarized',
    mode: 'gui',
    zone: 'global',
    label: 'Solarized Light',
    origin: 'factory',
    source: { presetName: 'solarized' },
    values: {
      accent: "#268bd2",
      transparency: 1,
      bgBlur: 0,
      globalFont: "system",
      codeFont: "mono",
      globalFontSize: 15,
      globalBgImage: "",
      globalBgColor: "#fdf6e3",
      uiScheme: "light",
      titlebarBg: "#eee8d5",
      titlebarTextColor: "#586e75",
      userName: "",
      userPrefix: "❯",
      userColor: "#268bd2",
      showTabBar: true,
      showSidebar: true,
      showPet: true,
    },
  },
  {
    id: 'agent-command',
    mode: 'gui',
    zone: 'global',
    label: 'Agent 指挥台',
    origin: 'factory',
    source: { presetName: 'agent-command' },
    values: {
      accent: "#38bdf8",
      transparency: 1,
      globalFont: "system",
      globalFontSize: 15,
      globalBgColor: "#08111f",
      uiScheme: "dark",
      titlebarBg: "#0b1424",
      titlebarTextColor: "#dbeafe",
      userColor: "#38bdf8",
    },
  },
  {
    id: 'agent-map',
    mode: 'gui',
    zone: 'global',
    label: 'Agent 关系图',
    origin: 'factory',
    source: { presetName: 'agent-map' },
    values: {
      accent: "#a78bfa",
      transparency: 1,
      globalFont: "system",
      globalFontSize: 15,
      globalBgColor: "#11101d",
      uiScheme: "dark",
      titlebarBg: "#171526",
      titlebarTextColor: "#ede9fe",
      userColor: "#a78bfa",
    },
  },
  {
    id: 'focus-flow',
    mode: 'gui',
    zone: 'global',
    label: '专注流程',
    origin: 'factory',
    source: { presetName: 'focus-flow' },
    values: {
      accent: "#d6a85f",
      transparency: 1,
      globalFont: "system",
      globalFontSize: 15,
      globalBgColor: "#181713",
      uiScheme: "dark",
      titlebarBg: "#1d1b17",
      titlebarTextColor: "#eee8dc",
      userColor: "#d6a85f",
    },
  },
]

// 本文件 5 条 / 52 个字段值
