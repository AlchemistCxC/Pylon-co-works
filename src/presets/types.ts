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
