import { attachSolidPersist, createSolidStoreKernel, resolveLocalStorage } from '../infrastructure/state/solidStoreKernel'
import { createReactStoreHook, type ZustandHook } from '../host/reactStoreShim'

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
// #515 批0：zustand → Solid 内核置换（对外签名不变；hook shim 待 React 面退役时拆除）。
const kernel = createSolidStoreKernel<TacticalSceneState>({
  artwork: 'closer', opacity: 0.42, motion: true,
  setArtwork: artwork => kernel.setState({ artwork }),
  setOpacity: opacity => kernel.setState({ opacity: Number.isFinite(opacity) ? Math.min(0.7, Math.max(0.15, opacity)) : 0.42 }),
  setMotion: motion => kernel.setState({ motion }),
})

attachSolidPersist(kernel, {
  name: 'pylon-tactical-scene-v1',
  storage: resolveLocalStorage(),
  partialize: ({ artwork, opacity, motion }) => ({ artwork, opacity, motion }),
  merge: (saved, current) => {
    const value = saved as Partial<TacticalSceneState> | null
    return { ...current,
      artwork: (value?.artwork === 'falling' ? 'falling' : 'closer') as TacticalArtwork,
      opacity: typeof value?.opacity === 'number' && Number.isFinite(value.opacity) ? Math.min(0.7, Math.max(0.15, value.opacity)) : 0.42,
      motion: typeof value?.motion === 'boolean' ? value.motion : true,
    }
  },
})

export const useTacticalSceneStore: ZustandHook<TacticalSceneState> = createReactStoreHook(kernel)
