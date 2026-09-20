/** 预设层 · 类型定义：PresetName / GlobalPreset。 */

import type { ThemeSettings } from '../store.ts'

// ── 预设定义 ─────────────────────────────────────────────────────

export type PresetName =
  | 'claude'
  | 'glass'
  | 'nord'
  | 'tokyo'
  | 'solarized'
  | 'amber'
  | 'matrix'
  | 'agent-command'
  | 'agent-map'
  | 'focus-flow'
  // 刀7：两条「默认预设」——与预设同定位（同形状、同应用路径），唯一触达是
  // 「重置主题」；**不进 GLOBAL_PRESETS**，故列表与区域池都看不到它们。
  | 'gui-default'
  | 'terminal-default'

export interface GlobalPreset {
  name: PresetName
  label: string
  /** 刀5（#201）：预设归属桶——预设菜单第一级只有 GUI / 终端 两桶（用户拍板归属表）。 */
  interfaceMode: PresetInterfaceMode
  theme: Partial<ThemeSettings>
  /** 可选的聊天呈现方案；应用全局预设时与主题一起激活。 */
  presentationProfileId?: string
}

export type PresetInterfaceMode = 'gui' | 'terminal'
