import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { advanceCodeEatingBehavior, getCodeComment, shouldStartCodeEating, shouldStartTabletCoding, type PetBehavior } from './petBehavior'
import { classifyPetPointerGesture, choosePetDestination, clampPetPosition, resolvePetClick } from './petMotion'
import { readPetPosition, writePetPosition, clearPetPosition, persistPetState, PET_POSITION_KEY, PET_STORAGE_KEY } from './petPersistence'
import { useRuntimeStore } from '../runtimeStore'
import './PetCompanion.css'

type GrowthStage = 'seed' | 'sprout' | 'hopper' | 'guardian' | 'luminary'

interface PetStats {
  messages: number
  prompts_completed: number
  prompts_failed: number
  tokens_total: number
  token_xp: number
  tools_started: number
  tools_succeeded: number
  tools_failed: number
  tool_success_rate: number
  interactions: number
  active_days: number
  streak_days: number
  longest_streak: number
}

interface PetState {
  name: string
  mood: string
  happiness: number
  energy: number
  xp: number
  bond: number
  born_at_ms: number
  last_seen_day: number
  first_chunk_at_ms: number | null
  stats: PetStats
  memories: string[]
  stage: GrowthStage
  title: string
  age_days: number
  next_stage_xp: number | null
  growth_progress: number
  msg?: string
}

interface Position { x: number; y: number }
interface PointerSession {
  pointerId: number
  startX: number
  startY: number
  startedAt: number
  dx: number
  dy: number
  wasWanderEnabled: boolean
}

const STORAGE_KEY = PET_STORAGE_KEY
const POSITION_KEY = PET_POSITION_KEY
const IS_TAURI = typeof (window as any).__TAURI_INTERNALS__ !== 'undefined' || typeof (window as any).__TAURI__ !== 'undefined'

const EMPTY_STATS: PetStats = {
  messages: 0, prompts_completed: 0, prompts_failed: 0, tokens_total: 0, token_xp: 0,
  tools_started: 0, tools_succeeded: 0, tools_failed: 0, tool_success_rate: 0,
  interactions: 0, active_days: 1, streak_days: 1, longest_streak: 1,
}

const MOCK_PET: PetState = {
  name: '微栖', mood: 'idle', happiness: 65, energy: 80, xp: 0, bond: 0,
  born_at_ms: Date.now(), last_seen_day: Math.floor(Date.now() / 86400000), first_chunk_at_ms: null,
  stats: EMPTY_STATS, memories: [], stage: 'seed', title: '微光种', age_days: 1,
  next_stage_xp: 25, growth_progress: 0, msg: '一粒微光落在了这里。',
}

const STAGE_SCALE: Record<GrowthStage, number> = {
  seed: .72, sprout: .84, hopper: .96, guardian: 1.08, luminary: 1.18,
}

function readPosition(): Position | null {
  return readPetPosition(localStorage)
}

function persistable(pet: PetState) {
  return persistPetState(pet)
}

function PixelCreature({ stage, mood, walking }: { stage: GrowthStage; mood: string; walking: boolean }) {
  const advanced = stage === 'guardian' || stage === 'luminary'
  const grown = stage !== 'seed'
  const body = stage === 'luminary' ? 'var(--pet-glow)' : 'var(--pet-body)'
  const eyeY = mood === 'sleepy' ? 8 : 7
  return (
    <svg className={`pixel-creature stage-${stage} mood-${mood} ${walking ? 'walking' : ''}`}
      viewBox="0 0 24 22" role="img" aria-label={`${stage}阶段像素生物`} shapeRendering="crispEdges">
      <g className="pixel-shadow"><rect x="5" y="19" width="14" height="2" /></g>
      {grown && <g className="pixel-tail"><rect x="18" y="12" width="3" height="2" /><rect x="20" y="10" width="2" height="3" /></g>}
      {advanced && <g className="pixel-antenna"><rect x="7" y="1" width="2" height="3" /><rect x="15" y="1" width="2" height="3" /><rect x="6" y="0" width="2" height="2" /><rect x="16" y="0" width="2" height="2" /></g>}
      <g className="pixel-body" fill={body}>
        {stage === 'seed' ? <>
          <rect x="7" y="6" width="10" height="11" />
          <rect x="5" y="9" width="14" height="6" />
        </> : <>
          <rect x="5" y="5" width="14" height="12" />
          <rect x="3" y="8" width="18" height="7" />
          <rect x="6" y="3" width="4" height="4" />
          <rect x="14" y="3" width="4" height="4" />
        </>}
        {advanced && <><rect x="4" y="14" width="4" height="5" /><rect x="16" y="14" width="4" height="5" /></>}
      </g>
      <g className="pixel-mark" fill="var(--pet-mark)">
        <rect x="10" y="4" width="4" height="2" />
        {stage === 'luminary' && <><rect x="3" y="11" width="2" height="2" /><rect x="19" y="11" width="2" height="2" /></>}
      </g>
      <g className="pixel-face" fill="var(--pet-eye)">
        <rect x="8" y={eyeY} width="2" height={mood === 'sleepy' ? 1 : 2} />
        <rect x="14" y={eyeY} width="2" height={mood === 'sleepy' ? 1 : 2} />
        <rect x="11" y="11" width="2" height="1" />
      </g>
      <g className="pixel-feet" fill="var(--pet-body)">
        <rect x="7" y="16" width="3" height="3" />
        <rect x="14" y="16" width="3" height="3" />
      </g>
      {stage === 'luminary' && <g className="pixel-sparks" fill="var(--pet-glow)"><rect x="1" y="5" width="2" height="2" /><rect x="21" y="4" width="2" height="2" /><rect x="20" y="16" width="1" height="1" /></g>}
    </svg>
  )
}

export default function PetCompanion({ rightInset = 0 }: { rightInset?: number }) {
  const [pet, setPet] = useState<PetState | null>(null)
  const [position, setPosition] = useState<Position | null>(readPosition)
  const [wanderEnabled, setWanderEnabled] = useState(() => localStorage.getItem(POSITION_KEY) === null)
  const [walking, setWalking] = useState(false)
  const [perched, setPerched] = useState(false)
  const [behavior, setBehavior] = useState<PetBehavior>('idle')
  const [comment, setComment] = useState('')
  const [tabletCoding, setTabletCoding] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [poking, setPoking] = useState(false)
  const [error, setError] = useState('')
  const shellRef = useRef<HTMLElement>(null)
  const pointerRef = useRef<PointerSession | null>(null)
  const positionRef = useRef<Position | null>(position)
  const previousRightInsetRef = useRef(rightInset)
  const lastClickAtRef = useRef<number | null>(null)
  const singleClickTimerRef = useRef<number | null>(null)
  const pokeTimerRef = useRef<number | null>(null)
  const wanderSettleTimerRef = useRef<number | null>(null)
  const wasGeneratingRef = useRef(false)
  const generating = useRuntimeStore(s => (s.liveGeneratingSources || []).length > 0)

  const save = useCallback((next: PetState) => {
    // 数据无变化时不产生新 state、不写盘（参考 CC hooks/useMemoryUsage 的 normal 不 setState 模式）
    const serialized = JSON.stringify(persistable(next))
    setPet(previous => {
      if (previous && JSON.stringify(persistable(previous)) === serialized) return previous
      localStorage.setItem(STORAGE_KEY, serialized)
      return next
    })
  }, [])

  useEffect(() => {
    if (!IS_TAURI) { setPet(MOCK_PET); return }
    const restore = async () => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        save(saved
          ? await invoke<PetState>('pet_action', { action: 'restore', value: saved })
          : await invoke<PetState>('get_pet'))
      } catch (cause) { setError(String(cause)) }
    }
    restore()
  }, [save])

  useEffect(() => {
    if (!IS_TAURI) return
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try { save(await invoke<PetState>('get_pet')) } catch { /* 下一轮重试 */ }
    }
    const timer = window.setInterval(poll, 12_000)
    const onVisibility = () => { if (document.visibilityState === 'visible') poll() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [save])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  useEffect(() => () => {
    if (singleClickTimerRef.current != null) window.clearTimeout(singleClickTimerRef.current)
    if (pokeTimerRef.current != null) window.clearTimeout(pokeTimerRef.current)
    if (wanderSettleTimerRef.current != null) window.clearTimeout(wanderSettleTimerRef.current)
  }, [])

  useEffect(() => {
    if (!wanderEnabled || dragging) return
    let cancelled = false
    const wander = () => {
      if (cancelled || dragging) return
      const host = shellRef.current?.parentElement
      const shell = shellRef.current
      if (!host || !shell) return
      const hostRect = host.getBoundingClientRect()
      const input = host.querySelector<HTMLElement>('.control-center .input-bar')
      const inputRect = input?.getBoundingClientRect() ?? null
      const destination = choosePetDestination({
        host: { left: hostRect.left, top: hostRect.top, width: hostRect.width, height: hostRect.height },
        input: inputRect && inputRect.width > 0
          ? { left: inputRect.left, top: inputRect.top, width: inputRect.width, height: inputRect.height }
          : null,
        pet: { width: shell.offsetWidth, height: shell.offsetHeight },
        rightInset,
      })
      setWalking(true)
      setPerched(false)
      setPosition(destination.position)
      if (wanderSettleTimerRef.current != null) window.clearTimeout(wanderSettleTimerRef.current)
      wanderSettleTimerRef.current = window.setTimeout(() => {
        wanderSettleTimerRef.current = null
        setWalking(false)
        setPerched(destination.kind === 'perched')
      }, 2200)
    }
    const first = window.setTimeout(wander, 1800)
    const timer = window.setInterval(wander, 9000)
    return () => { cancelled = true; window.clearTimeout(first); window.clearInterval(timer) }
  }, [dragging, rightInset, wanderEnabled])

  useEffect(() => {
    const shell = shellRef.current
    const host = shell?.parentElement
    if (!shell || !host) return
    const insetChanged = previousRightInsetRef.current !== rightInset
    previousRightInsetRef.current = rightInset
    const clampCurrentPosition = () => setPosition(current => current
      ? clampPetPosition(current, { width: host.clientWidth, height: host.clientHeight },
        { width: shell.offsetWidth, height: shell.offsetHeight }, rightInset)
      : insetChanged && rightInset > 0
        ? clampPetPosition({ x: host.clientWidth, y: Math.max(0, host.clientHeight - shell.offsetHeight - 18) },
          { width: host.clientWidth, height: host.clientHeight },
          { width: shell.offsetWidth, height: shell.offsetHeight }, rightInset)
        : current)
    clampCurrentPosition()
    window.addEventListener('resize', clampCurrentPosition)
    return () => window.removeEventListener('resize', clampCurrentPosition)
  }, [rightInset])

  useEffect(() => {
    if (!wanderEnabled || dragging || behavior !== 'idle') return
    const attempt = () => {
      const hasCode = Boolean(shellRef.current?.parentElement?.querySelector('.term-code-block'))
      if (shouldStartCodeEating({ hasCode, perched })) setBehavior('sniffing-code')
    }
    const first = window.setTimeout(attempt, 15_000)
    const timer = window.setInterval(attempt, 45_000)
    return () => { window.clearTimeout(first); window.clearInterval(timer) }
  }, [behavior, dragging, perched, wanderEnabled])

  useEffect(() => {
    const generationStarted = generating && !wasGeneratingRef.current
    const generationStopped = !generating && wasGeneratingRef.current
    wasGeneratingRef.current = generating
    if (generationStarted) setTabletCoding(shouldStartTabletCoding({ generating, behavior }))
    if (generationStopped || behavior !== 'idle') setTabletCoding(false)
  }, [behavior, generating])

  useEffect(() => {
    if (behavior === 'idle') return
    const duration: Record<Exclude<PetBehavior, 'idle'>, number> = {
      'sniffing-code': 600,
      'eating-code': 900,
      chewing: 1200,
      'spitting-fragment': 500,
      commenting: 4000,
    }
    if (behavior === 'commenting') setComment(getCodeComment())
    const timer = window.setTimeout(() => {
      const next = advanceCodeEatingBehavior(behavior)
      if (next === 'idle') setComment('')
      setBehavior(next)
    }, duration[behavior])
    return () => window.clearTimeout(timer)
  }, [behavior])

  const onPointerDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return
    const shell = shellRef.current
    if (!shell) return
    const rect = shell.getBoundingClientRect()
    pointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: Date.now(),
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      wasWanderEnabled: wanderEnabled,
    }
    shell.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const pointer = pointerRef.current
    const shell = shellRef.current
    const host = shell?.parentElement
    if (!pointer || pointer.pointerId !== event.pointerId || !shell || !host) return
    const gesture = classifyPetPointerGesture({
      startX: pointer.startX,
      startY: pointer.startY,
      endX: event.clientX,
      endY: event.clientY,
      durationMs: Date.now() - pointer.startedAt,
    })
    if (gesture !== 'drag') return
    setWanderEnabled(false)
    const hostRect = host.getBoundingClientRect()
    const next = clampPetPosition({
      x: event.clientX - hostRect.left - pointer.dx,
      y: event.clientY - hostRect.top - pointer.dy,
    }, { width: hostRect.width, height: hostRect.height }, { width: shell.offsetWidth, height: shell.offsetHeight }, rightInset)
    positionRef.current = next
    setPosition(next)
    setDragging(true)
  }

  const resumeWander = () => {
    clearPetPosition(localStorage)
    positionRef.current = null
    setPosition(null)
    setWanderEnabled(true)
  }

  const poke = () => {
    setPoking(true)
    setComment('嗯？')
    if (pokeTimerRef.current != null) window.clearTimeout(pokeTimerRef.current)
    pokeTimerRef.current = window.setTimeout(() => {
      setPoking(false)
      setComment('')
    }, 1200)
    if (IS_TAURI) {
      invoke<PetState>('pet_action', { action: 'poke' })
        .then(save)
        .catch(cause => setError(String(cause)))
    }
  }

  const onPointerUp = (event: React.PointerEvent) => {
    const pointer = pointerRef.current
    const shell = shellRef.current
    if (!pointer || pointer.pointerId !== event.pointerId) return
    const gesture = classifyPetPointerGesture({
      startX: pointer.startX,
      startY: pointer.startY,
      endX: event.clientX,
      endY: event.clientY,
      durationMs: Date.now() - pointer.startedAt,
    })
    const finalPosition = positionRef.current
    pointerRef.current = null
    setDragging(false)
    if (shell?.hasPointerCapture(event.pointerId)) shell.releasePointerCapture(event.pointerId)
    if (gesture === 'drag') {
      if (finalPosition) writePetPosition(localStorage, finalPosition)
      return
    }
    if (gesture !== 'click') {
      setWanderEnabled(pointer.wasWanderEnabled)
      return
    }
    const currentClickAt = Date.now()
    const click = resolvePetClick({ lastClickAt: lastClickAtRef.current, currentClickAt })
    lastClickAtRef.current = click.nextLastClickAt
    if (click.kind === 'double') {
      if (singleClickTimerRef.current != null) window.clearTimeout(singleClickTimerRef.current)
      resumeWander()
      return
    }
    if (singleClickTimerRef.current != null) window.clearTimeout(singleClickTimerRef.current)
    singleClickTimerRef.current = window.setTimeout(() => {
      lastClickAtRef.current = null
      singleClickTimerRef.current = null
      poke()
    }, 300)
  }

  // 触屏/指针被系统打断（pointercancel）或捕获丢失时复位拖拽状态，并恢复拖拽前的漫游设置，
  // 避免 dragging 永久残留 / 宠物停止漫游
  const onPointerCancel = (event: React.PointerEvent) => {
    const shell = shellRef.current
    if (!pointerRef.current || pointerRef.current.pointerId !== event.pointerId) return
    const wasWanderEnabled = pointerRef.current.wasWanderEnabled
    pointerRef.current = null
    setDragging(false)
    setWanderEnabled(wasWanderEnabled)
    if (shell?.hasPointerCapture(event.pointerId)) shell.releasePointerCapture(event.pointerId)
  }

  const onLostPointerCapture = (event: React.PointerEvent) => {
    const pointer = pointerRef.current
    if (!pointer || pointer.pointerId !== event.pointerId) return
    pointerRef.current = null
    setDragging(false)
    setWanderEnabled(pointer.wasWanderEnabled)
  }

  const style = useMemo(() => position
    ? { left: `${position.x}px`, top: `${position.y}px`, right: 'auto', bottom: 'auto', '--pet-scale': STAGE_SCALE[pet?.stage || 'seed'] } as React.CSSProperties
    : { '--pet-scale': STAGE_SCALE[pet?.stage || 'seed'] } as React.CSSProperties, [position, pet?.stage])

  if (!pet) return error ? <div className="pet-load-error">宠物加载失败：{error}</div> : null

  return (
    <section ref={shellRef} className={`pet-companion ${dragging ? 'dragging' : ''} ${poking ? 'poking' : ''} ${perched ? 'perched' : ''} ${tabletCoding ? 'tablet-coding' : ''} behavior-${behavior}`}
      style={style} aria-label="长期陪伴宠物"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel} onLostPointerCapture={onLostPointerCapture}>
      {behavior === 'spitting-fragment' && <span className="pet-code-fragment" aria-hidden="true">{'{}'}</span>}
      {comment && <div className="pet-speech-bubble" role="status">{comment}</div>}
      {tabletCoding && <div className="pet-tablet" aria-label="宠物正在平板电脑上敲代码">
        <span className="pet-tablet-screen"><i /><i /><i /></span>
        <span className="pet-tablet-keyboard" />
      </div>}
      <div className="pet-creature-hitbox"
        title={`${pet.name}：单击互动，拖拽固定位置，双击恢复自主漫游`}>
        <PixelCreature stage={pet.stage} mood={pet.mood} walking={walking} />
      </div>
    </section>
  )
}
