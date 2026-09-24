import { createSignal } from 'solid-js'

const neverEnter = () => false
const ENTRY_MOTION_MS = 760

/** An entry flag expires even if its DOM row is virtualized away mid-animation. */
export function createEntryMotion(initial: boolean): () => boolean {
  if (!initial) return neverEnter
  const [entering, setEntering] = createSignal(true)
  setTimeout(() => setEntering(false), ENTRY_MOTION_MS)
  return entering
}
