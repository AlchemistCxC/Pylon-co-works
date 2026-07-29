export const DEFAULT_SPARKLES = '✳✴✵✶✷✸✹✺✻✼❃❊'

export const SPINNER_FRAME_PRESETS = {
  sparkles: DEFAULT_SPARKLES,
  'ascii-line': '|/-\\\\',
  braille: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
  dots: '⠁⠂⠄⡀⢀⠠⠐⠈',
} as const

function splitGraphemes(value: string): string[] {
  type Segmenter = new (locales?: string | string[], options?: { granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ segment: string }>
  }
  const Segmenter = (Intl as typeof Intl & { Segmenter?: Segmenter }).Segmenter
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(value), item => item.segment)
  }
  return Array.from(value)
}

export function normalizeSpinnerFrames(value: string): string[] {
  return Array.from(new Set(splitGraphemes(value).map(frame => frame.trim()).filter(Boolean)))
}

export function resolveSpinnerFrames(preset: keyof typeof SPINNER_FRAME_PRESETS | 'custom', custom: string): string[] {
  const frames = preset === 'custom' ? normalizeSpinnerFrames(custom) : normalizeSpinnerFrames(SPINNER_FRAME_PRESETS[preset])
  return frames.length > 0 ? frames : normalizeSpinnerFrames(DEFAULT_SPARKLES)
}

export type SpinnerMarkerMode = 'frame' | 'custom'

export function resolveSpinnerMarker(
  frames: string[],
  mode: SpinnerMarkerMode,
  value: string,
): string {
  if (mode === 'custom') return value.trim() || frames[0] || normalizeSpinnerFrames(DEFAULT_SPARKLES)[0]
  return frames.includes(value) ? value : frames[0] || normalizeSpinnerFrames(DEFAULT_SPARKLES)[0]
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
