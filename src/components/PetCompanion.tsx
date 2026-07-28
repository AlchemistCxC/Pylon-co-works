import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { choosePetDestination, clampPetPosition } from './petMotion'
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

const STORAGE_KEY = 'pylon-pet-v3'
const POSITION_KEY = `${STORAGE_KEY}:position`
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
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function persistable(pet: PetState) {
  const { stage: _stage, title: _title, age_days: _ageDays, next_stage_xp: _next, growth_progress: _progress, msg: _msg, ...state } = pet
  return state
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

export default function PetCompanion({ rightOpen = false, rightWidth = 0 }: { rightOpen?: boolean; rightWidth?: number }) {
  const [pet, setPet] = useState<PetState | null>(null)
  const [position, setPosition] = useState<Position | null>(readPosition)
  const [wanderEnabled, setWanderEnabled] = useState(() => localStorage.getItem(POSITION_KEY) === null)
  const [walking, setWalking] = useState(false)
  const [perched, setPerched] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const shellRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  const save = useCallback((next: PetState) => {
    setPet(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable(next)))
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
    const timer = window.setInterval(async () => {
      try { save(await invoke<PetState>('get_pet')) } catch { /* 下一轮重试 */ }
    }, 12_000)
    return () => window.clearInterval(timer)
  }, [save])

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
        rightInset: rightOpen ? rightWidth : 0,
      })
      setWalking(true)
      setPerched(false)
      setPosition(destination.position)
      window.setTimeout(() => {
        setWalking(false)
        setPerched(destination.kind === 'perched')
      }, 2200)
    }
    const first = window.setTimeout(wander, 1800)
    const timer = window.setInterval(wander, 9000)
    return () => { cancelled = true; window.clearTimeout(first); window.clearInterval(timer) }
  }, [dragging, rightOpen, rightWidth, wanderEnabled])

  useEffect(() => {
    const shell = shellRef.current
    const host = shell?.parentElement
    if (!shell || !host) return
    const clampCurrentPosition = () => setPosition(current => current
      ? clampPetPosition(current, { width: host.clientWidth, height: host.clientHeight },
        { width: shell.offsetWidth, height: shell.offsetHeight }, rightOpen ? rightWidth : 0)
      : current)
    clampCurrentPosition()
    window.addEventListener('resize', clampCurrentPosition)
    return () => window.removeEventListener('resize', clampCurrentPosition)
  }, [rightOpen, rightWidth])

  const onPointerDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return
    const shell = shellRef.current
    if (!shell) return
    const rect = shell.getBoundingClientRect()
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    setWanderEnabled(false)
    setDragging(true)
    shell.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current || !shellRef.current?.parentElement) return
    const host = shellRef.current.parentElement.getBoundingClientRect()
    const x = Math.max(0, Math.min(host.width - shellRef.current.offsetWidth, event.clientX - host.left - dragRef.current.dx))
    const y = Math.max(0, Math.min(host.height - shellRef.current.offsetHeight, event.clientY - host.top - dragRef.current.dy))
    setPosition({ x, y })
  }

  const onPointerUp = () => {
    dragRef.current = null
    setDragging(false)
    if (position) localStorage.setItem(POSITION_KEY, JSON.stringify(position))
  }

  const resumeWander = () => {
    localStorage.removeItem(POSITION_KEY)
    setPosition(null)
    setWanderEnabled(true)
  }

  const style = useMemo(() => position
    ? { left: `${position.x}px`, top: `${position.y}px`, right: 'auto', bottom: 'auto', '--pet-scale': STAGE_SCALE[pet?.stage || 'seed'] } as React.CSSProperties
    : { '--pet-scale': STAGE_SCALE[pet?.stage || 'seed'] } as React.CSSProperties, [position, pet?.stage])

  if (!pet) return error ? <div className="pet-load-error">宠物加载失败：{error}</div> : null

  return (
    <section ref={shellRef} className={`pet-companion ${dragging ? 'dragging' : ''} ${perched ? 'perched' : ''}`}
      style={style} aria-label="长期陪伴宠物" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div className="pet-creature-hitbox" onDoubleClick={resumeWander}
        title={`${pet.name}：拖拽固定位置，双击恢复自主漫游`}>
        <PixelCreature stage={pet.stage} mood={pet.mood} walking={walking} />
      </div>
    </section>
  )
}
