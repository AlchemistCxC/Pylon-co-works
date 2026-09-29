/**
 * 区域层 · 出厂区域预设数据 —— gui 桶 / right 区域（刀2 / #223）。
 *
 * ★ **本文件是出厂区域预设的落盘数据（刀2 / #223 产出）；生成脚本已于刀3 删除，请勿手改。**
 *   它是**唯一真值**：10 套出厂预设的有效值由它算出（`effectivePresetTheme`）——
 *   改这里的任何一个值，等于改掉所有引用它的预设。历史来源见 `.agents/records/issue-223-factory-zone-presets-as-data.md`。
 * 值 = 生成时刻的 `pickZoneFields(GLOBAL_PRESETS[来源].theme, 'right')`，逐字段照抄
 * （含终端补全烘入的默认值；cc 区含 ccLayout/ccHidden 两个元件名单字段）。
 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'

export const FACTORY_GUI_RIGHT: readonly ZonePresetEntry[] = [
  {
    id: 'glass',
    mode: 'gui',
    zone: 'right',
    label: 'Glass Light',
    origin: 'factory',
    source: { presetName: 'glass' },
    values: {
      rightBg: "rgba(245,245,250,0.55)",
      rightWidth: 250,
    },
  },
  {
    id: 'solarized',
    mode: 'gui',
    zone: 'right',
    label: 'Solarized Light',
    origin: 'factory',
    source: { presetName: 'solarized' },
    values: {
      rightBg: "#eee8d5",
      rightBgImage: "",
      rightWidth: 260,
      rightTransparency: 1,
      rightBlur: 0,
    },
  },
  {
    id: 'agent-command',
    mode: 'gui',
    zone: 'right',
    label: 'Agent 指挥台',
    origin: 'factory',
    source: { presetName: 'agent-command' },
    values: {
      rightBg: "#0b1424",
    },
  },
  {
    id: 'agent-map',
    mode: 'gui',
    zone: 'right',
    label: 'Agent 关系图',
    origin: 'factory',
    source: { presetName: 'agent-map' },
    values: {
      rightBg: "#171526",
    },
  },
  {
    id: 'focus-flow',
    mode: 'gui',
    zone: 'right',
    label: '专注流程',
    origin: 'factory',
    source: { presetName: 'focus-flow' },
    values: {
      rightBg: "#1d1b17",
    },
  },
]

// 本文件 5 条 / 10 个字段值
