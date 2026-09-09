import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type TacticalArtwork = 'closer' | 'falling'
interface TacticalSceneState {
  artwork: TacticalArtwork
  opacity: number
  motion: boolean
  setArtwork(artwork: TacticalArtwork): void
  setOpacity(opacity: number): void
  setMotion(motion: boolean): void
}

/** Preferences belong only to this optional interface; never write global theme settings. */
export const useTacticalSceneStore = create<TacticalSceneState>()(persist(set => ({
  artwork: 'closer', opacity: 0.42, motion: true,
  setArtwork: artwork => set({ artwork }),
  setOpacity: opacity => set({ opacity: Number.isFinite(opacity) ? Math.min(0.7, Math.max(0.15, opacity)) : 0.42 }),
  setMotion: motion => set({ motion }),
}), {
  name: 'pylon-tactical-scene-v1',
  partialize: ({ artwork, opacity, motion }) => ({ artwork, opacity, motion }),
  merge: (saved, current) => {
    const value = saved as Partial<TacticalSceneState> | null
    return { ...current,
      artwork: value?.artwork === 'falling' ? 'falling' : 'closer',
      opacity: typeof value?.opacity === 'number' && Number.isFinite(value.opacity) ? Math.min(0.7, Math.max(0.15, value.opacity)) : 0.42,
      motion: typeof value?.motion === 'boolean' ? value.motion : true,
    }
  },
}))
