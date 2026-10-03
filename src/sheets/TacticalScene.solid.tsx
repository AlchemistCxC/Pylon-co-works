/** @jsxImportSource solid-js */
import { createEffect, onCleanup } from 'solid-js'
import closer from '../assets/tactical/closer.png'
import falling from '../assets/tactical/falling.png'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { useTacticalSceneStore } from './tacticalSceneStore'

/**
 * TacticalScene — tactical-blue 的装饰场景平面（#515 自 React 版逐行为同构迁移）。
 *
 * A decorative plane only. It cannot intercept clicks or move operational controls.
 * 偏好消费走 createZustandSignal（store 本体批0 已是 Solid 内核）；视差 effect 跟踪
 * motion()（对应原 [motion] deps），监听与 rAF 清理路径一致。
 */
export default function TacticalScene() {
  const artwork = createZustandSignal(useTacticalSceneStore, state => state.artwork)
  const opacity = createZustandSignal(useTacticalSceneStore, state => state.opacity)
  const motion = createZustandSignal(useTacticalSceneStore, state => state.motion)

  let plane: HTMLDivElement | undefined
  createEffect(() => {
    const motionEnabled = motion()
    const element = plane
    if (!element) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    const reset = () => { element.style.setProperty('--scene-x', '0px'); element.style.setProperty('--scene-y', '0px') }
    const move = (event: PointerEvent) => {
      if (!motionEnabled || media.matches || event.pointerType === 'touch') return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        element.style.setProperty('--scene-x', `${(event.clientX / window.innerWidth - 0.5) * 14}px`)
        element.style.setProperty('--scene-y', `${(event.clientY / window.innerHeight - 0.5) * 10}px`)
      })
    }
    const reduce = () => { cancelAnimationFrame(frame); reset() }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('blur', reduce)
    media.addEventListener('change', reduce)
    onCleanup(() => { cancelAnimationFrame(frame); reset(); window.removeEventListener('pointermove', move); window.removeEventListener('blur', reduce); media.removeEventListener('change', reduce) })
  })

  return <div ref={el => { plane = el }} class="tactical-scene" aria-hidden="true" data-motion={motion() ? 'on' : 'off'} style={{ '--scene-opacity': String(opacity()) }}>
    <img class="tactical-scene-art" src={closer} alt="" data-visible={artwork() === 'closer'} draggable={false} />
    <img class="tactical-scene-art" src={falling} alt="" data-visible={artwork() === 'falling'} draggable={false} />
    <div class="tactical-scene-shade" />
  </div>
}
