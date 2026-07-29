export const DEFAULT_SPARKLES = '✳✴✵✶✷✸✹✺✻✼❃❊'

export const SPINNER_FRAME_PRESETS = {
  sparkles: DEFAULT_SPARKLES,
  'ascii-line': '|/-\\\\',
  braille: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
  dots: '⠁⠂⠄⡀⢀⠠⠐⠈',
} as const

export function normalizeSpinnerFrames(value: string): string[] {
  return Array.from(new Set(value.split('').map(frame => frame.trim()).filter(Boolean)))
}

export function resolveSpinnerFrames(preset: keyof typeof SPINNER_FRAME_PRESETS | 'custom', custom: string): string[] {
  const frames = preset === 'custom' ? normalizeSpinnerFrames(custom) : normalizeSpinnerFrames(SPINNER_FRAME_PRESETS[preset])
  return frames.length > 0 ? frames : normalizeSpinnerFrames(DEFAULT_SPARKLES)
}

export function splitSpinnerFrames(value: string): string[] {
  return normalizeSpinnerFrames(value || DEFAULT_SPARKLES)
}

export function frameAt(frames: string[], elapsedMs: number, intervalMs = 120): string {
  const safeFrames = frames.length > 0 ? frames : splitSpinnerFrames('')
  const interval = Math.max(1, intervalMs)
  return safeFrames[Math.floor(Math.max(0, elapsedMs) / interval) % safeFrames.length]
}

export function completionFrame(frames: string[], elapsedMs: number): string {
  return frameAt(frames, elapsedMs)
}
