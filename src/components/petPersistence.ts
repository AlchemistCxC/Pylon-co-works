export interface PetPosition {
  x: number
  y: number
}

export interface PetStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const PET_STORAGE_KEY = 'pylon-pet-v3'
export const PET_POSITION_KEY = `${PET_STORAGE_KEY}:position`

const DERIVED_KEYS = new Set([
  'stage',
  'title',
  'age_days',
  'next_stage_xp',
  'growth_progress',
  'msg',
])

export function readPetPosition(storage: PetStorage): PetPosition | null {
  try {
    const raw = storage.getItem(PET_POSITION_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!isPetPosition(value)) return null
    return value
  } catch {
    return null
  }
}

export function writePetPosition(storage: PetStorage, position: PetPosition): void {
  storage.setItem(PET_POSITION_KEY, JSON.stringify(position))
}

export function clearPetPosition(storage: PetStorage): void {
  storage.removeItem(PET_POSITION_KEY)
}

export function persistPetState<T extends object>(state: T): Omit<T, 'stage' | 'title' | 'age_days' | 'next_stage_xp' | 'growth_progress' | 'msg'> {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !DERIVED_KEYS.has(key))) as Omit<T, 'stage' | 'title' | 'age_days' | 'next_stage_xp' | 'growth_progress' | 'msg'>
}

function isPetPosition(value: unknown): value is PetPosition {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y)
}
