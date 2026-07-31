import { getSpinnerAssetPreset, type SpinnerAssetId } from './spinnerAssets.ts'
import { resolveFrameIndex, type SpinnerMotionKind } from './spinnerMotion.ts'

export const DEFAULT_SPARKLES = getSpinnerAssetPreset('sparkles').frames

export type SpinnerFramePreset = SpinnerAssetId

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

export function resolveSpinnerFrames(preset: SpinnerFramePreset, custom: string): string[] {
  const frames = preset === 'custom' ? normalizeSpinnerFrames(custom) : normalizeSpinnerFrames(getSpinnerAssetPreset(preset).frames)
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

export function frameAt(
  frames: string[],
  elapsedMs: number,
  intervalMs = 120,
  motion: SpinnerMotionKind = 'cycle',
  direction?: 'forward' | 'reverse' | 'alternate',
): string {
  const safeFrames = frames.length > 0 ? frames : splitSpinnerFrames('')
  return safeFrames[resolveFrameIndex({
    frameCount: safeFrames.length,
    elapsedMs,
    intervalMs,
    motion,
    direction,
  })]
}

export function completionFrame(frames: string[], elapsedMs: number): string {
  return frameAt(frames, elapsedMs)
}
