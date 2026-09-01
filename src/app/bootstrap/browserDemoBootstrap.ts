/** Browser/mock-only adapter. Keeping the demo import behind this seam prevents
 * Tauri's application composition root from importing demo seed code. */
import { seedDemo, type DemoSeedOptions } from '../../demo/seed.ts'

export function runBrowserDemoSeed(
  setActiveSession: (id: string | null) => void,
  options?: DemoSeedOptions,
): void {
  seedDemo(setActiveSession, options)
}
