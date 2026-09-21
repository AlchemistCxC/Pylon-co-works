/**
 * 区域层 · 出厂区域预设数据 —— terminal 桶 / sidebar 区域（刀2 / #223）。
 *
 * ★ **本文件由 `scripts/generate-factory-zone-presets.mts --write` 生成，不要手改。**
 *   校验：`bun scripts/generate-factory-zone-presets.mts`（默认模式，逐字节比对）。
 * 值 = 生成时刻的 `pickZoneFields(GLOBAL_PRESETS[来源].theme, 'sidebar')`，逐字段照抄
 * （含终端补全烘入的默认值；cc 区含 ccLayout/ccHidden/ccScale 三个元件名单字段）。
 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'

export const FACTORY_TERMINAL_SIDEBAR: readonly ZonePresetEntry[] = [
  {
    id: 'claude',
    mode: 'terminal',
    zone: 'sidebar',
    label: 'Claude 风格',
    origin: 'factory',
    source: { presetName: 'claude' },
    values: {
      sidebarBg: "#000000",
      sidebarBgImage: "",
      sidebarWidth: 250,
      sidebarTransparency: 1,
      sidebarBlur: 0,
      sidebarTextColor: "#999999",
      sidebarNameSize: 14,
      sidebarGroupSize: 12,
    },
  },
  {
    id: 'nord',
    mode: 'terminal',
    zone: 'sidebar',
    label: 'Nord Frost',
    origin: 'factory',
    source: { presetName: 'nord' },
    values: {
      sidebarBg: "#252838",
      sidebarBgImage: "",
      sidebarWidth: 250,
      sidebarTransparency: 1,
      sidebarBlur: 0,
      sidebarTextColor: "#c8d0e0",
      sidebarNameSize: 14,
      sidebarGroupSize: 12,
    },
  },
  {
    id: 'tokyo',
    mode: 'terminal',
    zone: 'sidebar',
    label: 'Tokyo Night',
    origin: 'factory',
    source: { presetName: 'tokyo' },
    values: {
      sidebarBg: "#16161e",
      sidebarBgImage: "",
      sidebarWidth: 250,
      sidebarTransparency: 1,
      sidebarBlur: 0,
      sidebarTextColor: "#a9b1d6",
      sidebarNameSize: 14,
      sidebarGroupSize: 12,
    },
  },
  {
    id: 'amber',
    mode: 'terminal',
    zone: 'sidebar',
    label: 'Amber CRT',
    origin: 'factory',
    source: { presetName: 'amber' },
    values: {
      sidebarBg: "#120b00",
      sidebarBgImage: "",
      sidebarWidth: 250,
      sidebarTransparency: 1,
      sidebarBlur: 0,
      sidebarTextColor: "#cc8c00",
      sidebarNameSize: 14,
      sidebarGroupSize: 12,
    },
  },
  {
    id: 'matrix',
    mode: 'terminal',
    zone: 'sidebar',
    label: 'Matrix 磷绿',
    origin: 'factory',
    source: { presetName: 'matrix' },
    values: {
      sidebarBg: "#050f05",
      sidebarBgImage: "",
      sidebarWidth: 250,
      sidebarTransparency: 1,
      sidebarBlur: 0,
      sidebarTextColor: "#39ff14",
      sidebarNameSize: 14,
      sidebarGroupSize: 12,
    },
  },
]

// 本文件 5 条 / 40 个字段值
