/**
 * 区域层 · 出厂区域预设数据 —— gui 桶 / sidebar 区域（刀2 / #223）。
 *
 * ★ **本文件是出厂区域预设的落盘数据（刀2 / #223 产出）；生成脚本已于刀3 删除，请勿手改。**
 *   它是**唯一真值**：10 套出厂预设的有效值由它算出（`effectivePresetTheme`）——
 *   改这里的任何一个值，等于改掉所有引用它的预设。历史来源见 `.agents/records/issue-223-factory-zone-presets-as-data.md`。
 * 值 = 生成时刻的 `pickZoneFields(GLOBAL_PRESETS[来源].theme, 'sidebar')`，逐字段照抄
 * （含终端补全烘入的默认值；cc 区含 ccLayout/ccHidden 两个元件名单字段）。
 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'

export const FACTORY_GUI_SIDEBAR: readonly ZonePresetEntry[] = [
  {
    id: 'glass',
    mode: 'gui',
    zone: 'sidebar',
    label: 'Glass Light',
    origin: 'factory',
    source: { presetName: 'glass' },
    values: {
      sidebarBg: "rgba(245,245,250,0.55)",
      sidebarTextColor: "rgba(0,0,0,0.75)",
      sidebarNameSize: 14,
      sidebarGroupSize: 12,
    },
  },
  {
    id: 'solarized',
    mode: 'gui',
    zone: 'sidebar',
    label: 'Solarized Light',
    origin: 'factory',
    source: { presetName: 'solarized' },
    values: {
      sidebarBg: "#eee8d5",
      sidebarBgImage: "",
      sidebarWidth: 250,
      sidebarTransparency: 1,
      sidebarBlur: 0,
      sidebarTextColor: "#586e75",
      sidebarNameSize: 14,
      sidebarGroupSize: 12,
    },
  },
  {
    id: 'agent-command',
    mode: 'gui',
    zone: 'sidebar',
    label: 'Agent 指挥台',
    origin: 'factory',
    source: { presetName: 'agent-command' },
    values: {
      sidebarBg: "#0b1424",
      sidebarTextColor: "#a8bdd6",
      sidebarNameSize: 14,
    },
  },
  {
    id: 'agent-map',
    mode: 'gui',
    zone: 'sidebar',
    label: 'Agent 关系图',
    origin: 'factory',
    source: { presetName: 'agent-map' },
    values: {
      sidebarBg: "#171526",
      sidebarTextColor: "#c4b5d9",
      sidebarNameSize: 14,
    },
  },
  {
    id: 'focus-flow',
    mode: 'gui',
    zone: 'sidebar',
    label: '专注流程',
    origin: 'factory',
    source: { presetName: 'focus-flow' },
    values: {
      sidebarBg: "#1d1b17",
      sidebarTextColor: "#b8afa0",
      sidebarNameSize: 14,
    },
  },
]

// 本文件 5 条 / 21 个字段值
