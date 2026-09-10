import { useEffect, useRef, type CSSProperties } from 'react'
import closer from '../assets/tactical/closer.png'
import falling from '../assets/tactical/falling.png'
import { useTacticalSceneStore } from './tacticalSceneStore'

/** A decorative plane only. It cannot intercept clicks or move operational controls. */
export default function TacticalScene() {
  const { artwork, opacity, motion } = useTacticalSceneStore()
  const plane = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = plane.current
    if (!element) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    const reset = () => { element.style.setProperty('--scene-x', '0px'); element.style.setProperty('--scene-y', '0px') }
    const move = (event: PointerEvent) => {
      if (!motion || media.matches || event.pointerType === 'touch') return
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
    return () => { cancelAnimationFrame(frame); reset(); window.removeEventListener('pointermove', move); window.removeEventListener('blur', reduce); media.removeEventListener('change', reduce) }
  }, [motion])
  return <div ref={plane} className="tactical-scene" aria-hidden="true" data-motion={motion ? 'on' : 'off'} style={{ '--scene-opacity': opacity } as CSSProperties}>
    <img className="tactical-scene-art" src={closer} alt="" data-visible={artwork === 'closer'} draggable={false} />
    <img className="tactical-scene-art" src={falling} alt="" data-visible={artwork === 'falling'} draggable={false} />
    <div className="tactical-scene-shade" />
  </div>
}
