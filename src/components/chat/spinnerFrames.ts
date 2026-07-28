export const DEFAULT_SPARKLES = '✳✴✵✶✷✸✹✺✻✼❃❊'

export function splitSpinnerFrames(value: string): string[] {
  return Array.from(value || DEFAULT_SPARKLES)
}

export function frameAt(frames: string[], elapsedMs: number): string {
  const safeFrames = frames.length > 0 ? frames : splitSpinnerFrames('')
  return safeFrames[Math.floor(Math.max(0, elapsedMs) / 120) % safeFrames.length]
}

export function completionFrame(frames: string[], elapsedMs: number): string {
  return frameAt(frames, elapsedMs)
}
