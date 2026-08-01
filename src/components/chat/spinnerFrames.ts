import { getSpinnerAssetPreset, type SpinnerAssetId } from './spinnerAssets.ts'
import { resolveFrameIndex, type SpinnerMotionKind } from './spinnerMotion.ts'
import { segmentGraphemes } from '../../utils/textWidth.ts'

export const DEFAULT_SPARKLES = getSpinnerAssetPreset('sparkles').frames

export type SpinnerFramePreset = SpinnerAssetId

export function normalizeSpinnerFrames(value: string): string[] {
  return Array.from(new Set(segmentGraphemes(value).map(frame => frame.trim()).filter(Boolean)))
}

// 帧解析结果缓存：resolveSpinnerFrames 被 Settings 预览、Footer、事件控制器每渲染调用，
// 相同输入缓存命中（LRU 上限，防自定义帧字符串无限增长）。
const framesCache = new Map<string, string[]>()
const FRAMES_CACHE_LIMIT = 64

function cacheFrames(key: string, frames: string[]): string[] {
  framesCache.delete(key)
  framesCache.set(key, frames)
  if (framesCache.size > FRAMES_CACHE_LIMIT) {
    const oldest = framesCache.keys().next().value
    if (oldest !== undefined) framesCache.delete(oldest)
  }
  return frames
}

export function resolveSpinnerFrames(preset: SpinnerFramePreset, custom: string): string[] {
  const cacheKey = `${preset}\u0000${custom}`
  const cached = framesCache.get(cacheKey)
  if (cached !== undefined) return cached
  const frames = preset === 'custom' ? normalizeSpinnerFrames(custom) : normalizeSpinnerFrames(getSpinnerAssetPreset(preset).frames)
  return cacheFrames(cacheKey, frames.length > 0 ? frames : normalizeSpinnerFrames(DEFAULT_SPARKLES))
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
