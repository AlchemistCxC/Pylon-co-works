/**
 * 区域层 · 出厂区域预设数据 —— terminal 桶 / right 区域（刀2 / #223）。
 *
 * ★ **本文件由 `scripts/generate-factory-zone-presets.mts --write` 生成，不要手改。**
 *   校验：`bun scripts/generate-factory-zone-presets.mts`（默认模式，逐字节比对）。
 * 值 = 生成时刻的 `pickZoneFields(GLOBAL_PRESETS[来源].theme, 'right')`，逐字段照抄
 * （含终端补全烘入的默认值；cc 区含 ccLayout/ccHidden/ccScale 三个元件名单字段）。
 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'

export const FACTORY_TERMINAL_RIGHT: readonly ZonePresetEntry[] = [
  {
    id: 'claude',
    mode: 'terminal',
    zone: 'right',
    label: 'Claude 风格',
    origin: 'factory',
    source: { presetName: 'claude' },
    values: {
      rightBg: "#000000",
      rightBgImage: "",
      rightWidth: 260,
      rightTransparency: 1,
      rightBlur: 0,
    },
  },
  {
    id: 'nord',
    mode: 'terminal',
    zone: 'right',
    label: 'Nord Frost',
    origin: 'factory',
    source: { presetName: 'nord' },
    values: {
      rightBg: "#252838",
      rightBgImage: "",
      rightWidth: 250,
      rightTransparency: 1,
      rightBlur: 0,
    },
  },
  {
    id: 'tokyo',
    mode: 'terminal',
    zone: 'right',
    label: 'Tokyo Night',
    origin: 'factory',
    source: { presetName: 'tokyo' },
    values: {
      rightBg: "#16161e",
      rightBgImage: "",
      rightWidth: 260,
      rightTransparency: 1,
      rightBlur: 0,
    },
  },
  {
    id: 'amber',
    mode: 'terminal',
    zone: 'right',
    label: 'Amber CRT',
    origin: 'factory',
    source: { presetName: 'amber' },
    values: {
      rightBg: "#120b00",
      rightBgImage: "",
      rightWidth: 260,
      rightTransparency: 1,
      rightBlur: 0,
    },
  },
  {
    id: 'matrix',
    mode: 'terminal',
    zone: 'right',
    label: 'Matrix 磷绿',
    origin: 'factory',
    source: { presetName: 'matrix' },
    values: {
      rightBg: "#050f05",
      rightBgImage: "",
      rightWidth: 260,
      rightTransparency: 1,
      rightBlur: 0,
    },
  },
]

// 本文件 5 条 / 25 个字段值
