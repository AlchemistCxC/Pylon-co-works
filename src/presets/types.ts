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
  theme: Partial<ThemeSettings>
  /** 可选的聊天呈现方案；应用全局预设时与主题一起激活。 */
  presentationProfileId?: string
}
