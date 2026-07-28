export interface PetPoint { x: number; y: number }
export interface PetSize { width: number; height: number }
export interface PetRect extends PetSize { left: number; top: number }
export type PetDestinationKind = 'perched' | 'wander' | 'edge'

interface DestinationOptions {
  host: PetRect
  input: PetRect | null
  pet: PetSize
  rightInset: number
  random?: () => number
}

export function clampPetPosition(point: PetPoint, host: PetSize, pet: PetSize, rightInset = 0): PetPoint {
  const maxX = Math.max(0, host.width - Math.max(0, rightInset) - pet.width)
  const maxY = Math.max(0, host.height - pet.height)
  return {
    x: clamp(point.x, 0, maxX),
    y: clamp(point.y, 0, maxY),
  }
}

export function choosePetDestination({ host, input, pet, rightInset, random = Math.random }: DestinationOptions) {
  const roll = random()
  if (input && roll < 0.65) {
    const inputX = input.left - host.left
    const inputY = input.top - host.top
    const x = inputX + 8 + random() * Math.max(0, input.width - pet.width - 16)
    const y = inputY - pet.height + 4 + random() * 6
    return { kind: 'perched' as const, position: clampPetPosition({ x, y }, host, pet, rightInset) }
  }

  const usableWidth = Math.max(0, host.width - Math.max(0, rightInset) - pet.width)
  const chatBottom = input
    ? Math.max(0, input.top - host.top - pet.height - 12)
    : Math.max(0, host.height - pet.height)

  if (roll < 0.9) {
    return {
      kind: 'wander' as const,
      position: clampPetPosition({ x: random() * usableWidth, y: random() * chatBottom }, host, pet, rightInset),
    }
  }

  const edge = random()
  const x = edge < 0.5 ? 8 : Math.max(0, usableWidth - 8)
  const y = 8 + random() * Math.max(0, chatBottom - 16)
  return { kind: 'edge' as const, position: clampPetPosition({ x, y }, host, pet, rightInset) }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
