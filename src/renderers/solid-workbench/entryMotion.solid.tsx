import { createSignal } from 'solid-js'

const neverEnter = () => false

/** An entry flag expires even if its DOM row is virtualized away mid-animation. */
export function createEntryMotion(initial: boolean): () => boolean {
  if (!initial) return neverEnter
  const [entering, setEntering] = createSignal(true)
  setTimeout(() => setEntering(false), 420)
  return entering
}
