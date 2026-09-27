export const WINDOW_SIZE_KEY = 'pylon-window-size'

export interface WindowSize {
  width: number
  height: number
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const MIN_WIDTH = 400
const MIN_HEIGHT = 300

export function loadWindowSize(storage: StorageLike): WindowSize | null {
  try {
    const raw = storage.getItem(WINDOW_SIZE_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const candidate = value as Record<string, unknown>
    const width = candidate.width
    const height = candidate.height
    if (typeof width !== 'number' || typeof height !== 'number') return null
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null
    if (width < MIN_WIDTH || height < MIN_HEIGHT) return null
    return { width: Math.round(width), height: Math.round(height) }
  } catch {
    return null
  }
}

export function persistWindowSize(storage: StorageLike, size: WindowSize): void {
  try {
    storage.setItem(WINDOW_SIZE_KEY, JSON.stringify(size))
  } catch {
    // 存储不可用：跳过记忆
  }
}

export function clearWindowSize(storage: StorageLike): void {
  try {
    storage.removeItem(WINDOW_SIZE_KEY)
  } catch {
    // 存储不可用：跳过
  }
}
