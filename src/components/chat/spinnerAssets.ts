import type { SpinnerMotionKind } from './spinnerMotion.ts'

export type SpinnerAssetId =
  | 'sparkles'
  | 'ascii-line'
  | 'braille'
  | 'dots'
  | 'orbit'
  | 'clock'
  | 'wave'
  | 'blocks'
  | 'scan'
  | 'custom'

export interface SpinnerAssetPreset {
  id: SpinnerAssetId
  label: string
  frames: string
  motion: SpinnerMotionKind
  defaultIntervalMs: number
  direction?: 'forward' | 'reverse' | 'alternate'
}

export interface SpinnerVerbPreset {
  id: 'zh' | 'en' | 'analysis' | 'engineering' | 'custom'
  label: string
  verbs: readonly string[]
}

export const SPINNER_ASSET_PRESETS: readonly SpinnerAssetPreset[] = [
  { id: 'sparkles', label: 'Sparkles', frames: '✳✴✵✶✷✸✹✺✻✼❃❊', motion: 'cycle', defaultIntervalMs: 120 },
  { id: 'ascii-line', label: 'ASCII Line', frames: '|/-\\', motion: 'cycle', defaultIntervalMs: 120 },
  { id: 'braille', label: 'Braille', frames: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', motion: 'cycle', defaultIntervalMs: 100 },
  { id: 'dots', label: 'Dots', frames: '⠁⠂⠄⡀⢀⠠⠐⠈', motion: 'cycle', defaultIntervalMs: 140 },
  { id: 'orbit', label: 'Orbit', frames: '◜◝◞◟', motion: 'ping-pong', defaultIntervalMs: 140 },
  { id: 'clock', label: 'Clock', frames: '◷◶◵◴', motion: 'cycle', defaultIntervalMs: 160 },
  { id: 'wave', label: 'Wave', frames: '▁▂▃▄▅▆▇█▇▆▅▄▃', motion: 'cycle', defaultIntervalMs: 90 },
  { id: 'blocks', label: 'Blocks', frames: '▖▘▝▗', motion: 'bounce', defaultIntervalMs: 130 },
  { id: 'scan', label: 'Scan', frames: '▏▎▍▌▋▊▉█', motion: 'ping-pong', defaultIntervalMs: 100 },
  { id: 'custom', label: 'Custom', frames: '', motion: 'cycle', defaultIntervalMs: 120 },
]

export const SPINNER_VERB_PRESETS: readonly SpinnerVerbPreset[] = [
  { id: 'zh', label: '中文', verbs: ['格物致知','见微知著','大道至简','慎思明辨','融会贯通','温故知新','举一反三'] },
  { id: 'en', label: 'English', verbs: ['Thinking', 'Reading', 'Checking', 'Reasoning', 'Working', 'Reviewing', 'Verifying'] },
  { id: 'analysis', label: '分析', verbs: ['解析', '推演', '归纳', '校验', '定位', '拆解', '复核'] },
  { id: 'engineering', label: '工程', verbs: ['读取', '搜索', '修改', '构建', '测试', '整理', '验证'] },
  { id: 'custom', label: '自定义', verbs: [] },
]

export function getSpinnerAssetPreset(id: string): SpinnerAssetPreset {
  return SPINNER_ASSET_PRESETS.find(preset => preset.id === id) || SPINNER_ASSET_PRESETS[0]
}

export function getSpinnerVerbPreset(id: string): SpinnerVerbPreset {
  return SPINNER_VERB_PRESETS.find(preset => preset.id === id) || SPINNER_VERB_PRESETS[0]
}
