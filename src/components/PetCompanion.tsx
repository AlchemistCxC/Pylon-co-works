import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IS_TAURI } from '../infrastructure/tauri/env'
import { invoke } from '@tauri-apps/api/core'
import { advanceCodeEatingBehavior, getCodeComment, shouldStartCodeEating, shouldStartTabletCoding, type PetBehavior } from './petBehavior'
import { classifyPetPointerGesture, choosePetDestination, clampPetPosition, resolvePetClick } from './petMotion'
import { readPetPosition, writePetPosition, clearPetPosition, persistPetState, PET_POSITION_KEY, PET_STORAGE_KEY } from './petPersistence'
import { useRuntimeStore } from '../runtimeStore'
import { resolvePetVisualPose, type PetVisualPose } from './petVisualPose'
import './PetCompanion.css'

import { normalizePetState, type PetGrowthStage, type PetState, type PetStats } from '../infrastructure/tauri/petContracts'

// H2：宠物 DTO 集中 + 收窄（petContracts），invoke 结果一律经 normalize 兜底再入库
type GrowthStage = PetGrowthStage
const fetchPet = (cmd: string, args?: Record<string, unknown>) => invoke<unknown>(cmd, args).then(normalizePetState)

interface Position { x: number; y: number }
type PetDirection = 'left' | 'right'
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

const EMPTY_STATS: PetStats = {
  messages: 0, prompts_completed: 0, prompts_failed: 0, tokens_total: 0, token_xp: 0,
  tools_started: 0, tools_succeeded: 0, tools_failed: 0, tool_success_rate: 0,
  interactions: 0, active_days: 1, streak_days: 1, longest_streak: 1,
  code_sessions: 0, code_eaten: 0, code_watched: 0, friends_made: 0, dazes: 0,
  code_files: [], feed_count: 0, play_count: 0, night_visits: 0, cosmetics_collected: 0,
}

const MOCK_PET: PetState = {
  name: '微栖', mood: 'idle', happiness: 65, energy: 80, xp: 0, bond: 0,
  born_at_ms: Date.now(), last_seen_day: Math.floor(Date.now() / 86400000), first_chunk_at_ms: null,
  hunger: 80, fun: 70, loneliness: 0,
  traits: { activity: 60, clinginess: 60, greed: 60, curiosity: 60 },
  machine: 'awake.idle', last_tick_at_ms: Date.now(), recent_events: [],
  last_agent_mode: null, last_agent_model: null, pending_action: null,
  unlocked: [], inventory: [], equipped: null, last_drop_at_ms: 0,
  stats: EMPTY_STATS, memories: [], stage: 'seed', title: '微光种', age_days: 1,
  next_stage_xp: 25, growth_progress: 0, crafting: false, day_part: 'day',
  achievements: [], cosmetics: [
    { id: 'beret', name: '夜光贝雷帽', kind: 'hat', icon: '', owned: true },
    { id: 'pixel_hat', name: '像素渔夫帽', kind: 'hat', icon: '', owned: false },
    { id: 'pixel_cape', name: '像素披风', kind: 'cape', icon: '', owned: true },
    { id: 'star_scarf', name: '星光围巾', kind: 'cape', icon: '', owned: false },
    { id: 'glow_band', name: '光点手环', kind: 'glow', icon: '', owned: true },
    { id: 'code_pin', name: '代码胸针', kind: 'glow', icon: '', owned: false },
    { id: 'phantom_cat', name: '幻影猫', kind: 'companion', icon: '', owned: true },
    { id: 'mini_orb', name: '迷你光球', kind: 'companion', icon: '', owned: false },
    { id: 'code_crown', name: '代码之冕', kind: 'hat', icon: '', owned: false },
    { id: 'bond_glow', name: '羁绊之光', kind: 'glow', icon: '', owned: false },
    { id: 'luminary_wings', name: '长明之翼', kind: 'cape', icon: '', owned: false },
  ], msg: '一粒微光落在了这里。',
}

const STAGE_SCALE: Record<GrowthStage, number> = {
  seed: .88, sprout: .94, hopper: 1, guardian: 1.04, luminary: 1.06,
}

const VISUAL_MOODS = new Set([
  'idle', 'sleepy', 'error', 'hungry', 'tired', 'lonely', 'dazed',
  'confused', 'startled', 'happy', 'excited', 'focused', 'curious',
])

function readPosition(): Position | null {
  return readPetPosition(localStorage)
}

function persistable(pet: PetState) {
  return persistPetState(pet)
}

function CosmeticOverlay({ id }: { id: string | null }) {
  if (!id) return null
  return <g className={`pet-cosmetic pet-cosmetic-${id}`} data-cosmetic={id} aria-hidden="true">
    {id === 'beret' && <><path className="cosmetic-dark" d="M10 8h17v3H8V9h2zM14 5h10v3H12V7h2z" /><rect className="cosmetic-glow" x="13" y="7" width="11" height="1" /></>}
    {id === 'pixel_hat' && <><path className="cosmetic-warm" d="M8 8h21v3H7V9h1zM12 5h13v3H10V7h2zM16 3h5v2h-5z" /><rect className="cosmetic-accent" x="12" y="8" width="13" height="1" /></>}
    {id === 'pixel_cape' && <path className="cosmetic-cape" d="M7 15h5v11H8v-3H6v-7h1zm22 0h-5v11h4v-3h2v-7h-1zM10 24h16v5H10z" />}
    {id === 'star_scarf' && <><path className="cosmetic-scarf" d="M8 14h20v3h-3v8h-4v-8H8z" /><rect className="cosmetic-glow" x="11" y="15" width="12" height="1" /></>}
    {id === 'glow_band' && <><rect className="cosmetic-glow" x="6" y="23" width="3" height="2" /><rect className="cosmetic-glow" x="28" y="23" width="3" height="2" /></>}
    {id === 'code_pin' && <><rect className="cosmetic-accent" x="16" y="18" width="6" height="5" /><path className="cosmetic-cutout" d="M17 19h2v1h-1v1h1v1h-2zm4 0h-2v1h1v1h-1v1h2z" /></>}
    {id === 'phantom_cat' && <><path className="cosmetic-companion" d="M30 20h5v8h-6v-6h1zM30 18h2v3h-2zm3 0h2v3h-2z" /><rect className="cosmetic-glow" x="32" y="22" width="1" height="1" /></>}
    {id === 'mini_orb' && <><rect className="cosmetic-glow" x="31" y="11" width="4" height="4" /><rect className="cosmetic-glow" x="32" y="10" width="2" height="6" /><rect className="cosmetic-glow" x="30" y="12" width="6" height="2" /></>}
    {id === 'code_crown' && <><path className="cosmetic-accent" d="M10 9h4l3-5 3 5 4-5 3 5h2v4H9V9z" /><rect className="cosmetic-glow" x="12" y="11" width="14" height="1" /></>}
    {id === 'bond_glow' && <><rect className="cosmetic-glow" x="3" y="7" width="2" height="2" /><rect className="cosmetic-glow" x="31" y="6" width="2" height="2" /><rect className="cosmetic-glow" x="32" y="26" width="1" height="1" /><rect className="cosmetic-glow" x="4" y="27" width="1" height="1" /></>}
    {id === 'luminary_wings' && <><path className="cosmetic-glow" d="M7 12H3v3H1v8h3v4h6v-5h2v-8H7zm22 0h4v3h2v8h-3v4h-6v-5h-2v-8h5z" /><path className="cosmetic-wing" d="M6 15H4v7h3v-4h2v-3zm24 0h2v7h-3v-4h-2v-3z" /></>}
  </g>
}

function PixelCreature({ stage, mood, walking, direction, pose, cosmetic }: { stage: GrowthStage; mood: string; walking: boolean; direction: PetDirection; pose: PetVisualPose; cosmetic: string | null }) {
  const visualMood = VISUAL_MOODS.has(mood) ? mood : 'idle'
  return (
    <svg className={`pixel-creature stage-${stage} mood-${visualMood} pose-${pose} direction-${direction} ${walking ? 'walking' : ''}`}
      data-direction={direction}
      data-pose={pose}
      viewBox="0 0 36 32" role="img" aria-label={`${stage}阶段像素生物，${visualMood}状态`} shapeRendering="crispEdges">
      {stage === 'seed' && <>
        <ellipse className="pixel-shadow" cx="18" cy="28" rx="8" ry="2" />
        <g className="pixel-body">
          <path className="pixel-body-dark" d="M12 13h12v2h3v10h-3v3H12v-3H9V15h3z" />
          <path className="pixel-body-fill" d="M13 11h10v2h3v11h-3v3H13v-3h-3V14h3z" />
          <path className="pixel-body-light" d="M14 12h7v2h-7zM12 15h3v7h-3z" />
          <g className="pixel-core"><rect x="16" y="9" width="4" height="4" /><rect className="pixel-core-light" x="17" y="10" width="2" height="2" /></g>
          <rect className="pixel-eye pixel-eye-a" x="14" y="17" width="2" height="2" /><rect className="pixel-eye pixel-eye-b" x="21" y="17" width="2" height="2" /><rect className="pixel-mouth" x="17" y="22" width="3" height="1" />
          <g className="pixel-arm pixel-arm-a"><path className="pixel-body-fill" d="M10 19h3v4h-2v-2h-1z" /><rect className="pixel-body-light" x="10" y="22" width="3" height="2" /></g>
          <g className="pixel-arm pixel-arm-b"><path className="pixel-body-fill" d="M24 19h3v4h-1v-2h-2z" /><rect className="pixel-body-light" x="24" y="22" width="3" height="2" /></g>
          <g className="pixel-leg pixel-leg-a"><rect className="pixel-body-dark" x="12" y="25" width="4" height="3" /></g><g className="pixel-leg pixel-leg-b"><rect className="pixel-body-dark" x="21" y="25" width="4" height="3" /></g>
        </g>
      </>}
      {stage === 'sprout' && <>
        <ellipse className="pixel-shadow" cx="18" cy="29" rx="10" ry="2" />
        <g className="pixel-tail"><path className="pixel-body-light" d="M27 20h4v-3h2v6h-5z" /></g>
        <g className="pixel-body">
          <g className="pixel-ear"><path className="pixel-body-dark" d="M10 7h5v6h-5zM22 7h5v6h-5z" /><path className="pixel-body-light" d="M11 8h2v3h-2zM23 8h2v3h-2z" /></g>
          <path className="pixel-body-dark" d="M9 13h19v12h-3v3H11v-3H8V16h1z" /><path className="pixel-body-fill" d="M10 12h17v13h-3v2H12v-2H9V15h1z" />
          <path className="pixel-body-light" d="M11 13h6v2h-6zM10 16h3v6h-3z" /><rect className="pixel-core" x="17" y="11" width="3" height="3" />
          <rect className="pixel-eye pixel-eye-a" x="13" y="17" width="2" height="2" /><rect className="pixel-eye pixel-eye-b" x="22" y="17" width="2" height="2" /><rect className="pixel-mouth" x="17" y="21" width="3" height="1" />
          <g className="pixel-arm pixel-arm-a"><path className="pixel-body-dark" d="M8 18h4v6H9v-2H8z" /><rect className="pixel-body-light" x="8" y="23" width="4" height="2" /></g><g className="pixel-arm pixel-arm-b"><path className="pixel-body-dark" d="M26 18h4v6h-1v-2h-3z" /><rect className="pixel-body-light" x="26" y="23" width="4" height="2" /></g>
          <g className="pixel-leg pixel-leg-a"><path className="pixel-body-dark" d="M11 24h5v5h-4v-2h-1z" /></g><g className="pixel-leg pixel-leg-b"><path className="pixel-body-dark" d="M22 24h5v5h-4v-2h-1z" /></g>
        </g>
      </>}
      {stage === 'hopper' && <>
        <ellipse className="pixel-shadow" cx="18" cy="29" rx="13" ry="2" />
        <g className="pixel-tail"><path className="pixel-body-dark" d="M26 18h5v-3h3v-3h2v7h-3v3h-7z" /><rect className="pixel-body-light" x="33" y="12" width="2" height="3" /></g>
        <g className="pixel-body">
          <g className="pixel-ear"><path className="pixel-body-dark" d="M8 8h4v7H8zM15 6h4v8h-4z" /><path className="pixel-body-light" d="M9 9h2v4H9zM16 7h2v5h-2z" /></g>
          <path className="pixel-body-dark" d="M6 14h21v3h4v8h-4v3H8v-2H4v-8h2z" /><path className="pixel-body-fill" d="M7 13h19v3h4v8h-4v3H9v-2H5v-7h2z" />
          <path className="pixel-body-light" d="M8 14h9v2H8zM6 18h3v5H6z" /><rect className="pixel-eye pixel-eye-a" x="11" y="18" width="2" height="2" /><rect className="pixel-eye pixel-eye-b" x="20" y="18" width="2" height="2" /><rect className="pixel-mouth" x="15" y="22" width="3" height="1" />
          <g className="pixel-arm pixel-arm-a"><path className="pixel-body-dark" d="M4 18h4v7H5v-2H4z" /><rect className="pixel-body-light" x="4" y="24" width="4" height="2" /></g><g className="pixel-arm pixel-arm-b"><path className="pixel-body-dark" d="M27 17h4v7h-1v-2h-3z" /><rect className="pixel-body-light" x="27" y="23" width="4" height="2" /></g>
          <g className="pixel-leg pixel-leg-a"><path className="pixel-body-dark" d="M8 24h5v6H8v-2H6v-2h2zM21 24h4v6h-5v-2h1z" /></g><g className="pixel-leg pixel-leg-b"><path className="pixel-body-dark" d="M14 24h4v5h-5v-2h1zM26 23h4v5h-5v-2h1z" /></g>
        </g>
      </>}
      {stage === 'guardian' && <>
        <ellipse className="pixel-shadow" cx="18" cy="29" rx="12" ry="2" />
        <g className="pixel-tail"><path className="pixel-body-dark" d="M27 20h5v-4h3v7h-3v3h-5z" /></g>
        <g className="pixel-body">
          <g className="pixel-antenna"><path className="pixel-glow" d="M11 3h2v5h-2zM24 3h2v5h-2zM9 2h3v2H9zM25 2h3v2h-3z" /></g>
          <path className="pixel-body-dark" d="M8 9h20v4h3v13h-4v3H9v-3H6V13h2z" /><path className="pixel-body-fill" d="M9 8h18v4h3v13h-4v3H10v-3H7V12h2z" />
          <path className="pixel-body-light" d="M10 10h7v2h-7zM8 14h3v8H8z" /><rect className="pixel-eye pixel-eye-a" x="12" y="15" width="2" height="2" /><rect className="pixel-eye pixel-eye-b" x="23" y="15" width="2" height="2" /><rect className="pixel-mouth" x="17" y="20" width="3" height="1" />
          <g className="pixel-arm pixel-arm-a"><path className="pixel-body-dark" d="M6 17h5v8H8v-3H6z" /><rect className="pixel-body-light" x="6" y="24" width="5" height="2" /></g><g className="pixel-arm pixel-arm-b"><path className="pixel-body-dark" d="M27 17h5v8h-2v-3h-3z" /><rect className="pixel-body-light" x="27" y="24" width="5" height="2" /></g>
          <g className="pixel-core"><rect className="pixel-glow" x="15" y="22" width="7" height="5" /><rect className="pixel-core-light" x="17" y="23" width="3" height="3" /></g>
          <g className="pixel-leg pixel-leg-a"><path className="pixel-body-dark" d="M9 24h6v6h-5v-2H9z" /></g><g className="pixel-leg pixel-leg-b"><path className="pixel-body-dark" d="M23 24h6v6h-5v-2h-1z" /></g>
        </g>
      </>}
      {stage === 'luminary' && <>
        <ellipse className="pixel-shadow" cx="18" cy="29" rx="12" ry="2" />
        <g className="pixel-wing"><path className="pixel-glow" d="M7 13H3v3H1v6h3v3h5v-4h2v-7H7z" /><path className="pixel-body-light" d="M6 15H4v6h3v-3h2v-3z" /></g><g className="pixel-wing"><path className="pixel-glow" d="M29 13h4v3h2v6h-3v3h-5v-4h-2v-7h4z" /><path className="pixel-body-light" d="M30 15h2v6h-3v-3h-2v-3z" /></g>
        <g className="pixel-tail"><path className="pixel-glow" d="M27 21h4v-3h3v-3h2v7h-3v3h-6z" /></g>
        <g className="pixel-body">
          <g className="pixel-antenna"><path className="pixel-glow" d="M10 2h2v6h-2zM25 2h2v6h-2zM8 1h3v2H8zM26 1h3v2h-3z" /></g>
          <path className="pixel-body-dark" d="M8 9h20v4h3v13h-4v3H9v-3H6V13h2z" /><path className="pixel-body-fill" d="M9 8h18v4h3v13h-4v3H10v-3H7V12h2z" />
          <path className="pixel-body-light" d="M10 9h7v2h-7zM8 13h3v9H8zM26 12h2v8h-2z" /><rect className="pixel-eye pixel-eye-a" x="12" y="15" width="2" height="2" /><rect className="pixel-eye pixel-eye-b" x="23" y="15" width="2" height="2" /><rect className="pixel-mouth" x="17" y="19" width="3" height="1" />
          <g className="pixel-arm pixel-arm-a"><path className="pixel-body-dark" d="M6 17h5v8H8v-3H6z" /><rect className="pixel-body-light" x="6" y="24" width="5" height="2" /><rect className="pixel-glow" x="7" y="25" width="3" height="1" /></g><g className="pixel-arm pixel-arm-b"><path className="pixel-body-dark" d="M27 17h5v8h-2v-3h-3z" /><rect className="pixel-body-light" x="27" y="24" width="5" height="2" /><rect className="pixel-glow" x="28" y="25" width="3" height="1" /></g>
          <g className="pixel-core"><rect className="pixel-glow" x="14" y="21" width="9" height="7" /><rect className="pixel-core-light" x="16" y="22" width="5" height="5" /><rect className="pixel-glow" x="18" y="23" width="1" height="3" /></g>
          <g className="pixel-leg pixel-leg-a"><path className="pixel-body-dark" d="M9 24h6v6h-5v-2H9z" /></g><g className="pixel-leg pixel-leg-b"><path className="pixel-body-dark" d="M23 24h6v6h-5v-2h-1z" /></g>
          <g className="pixel-sparks"><rect className="pixel-glow" x="3" y="8" width="2" height="2" /><rect className="pixel-glow" x="32" y="7" width="2" height="2" /><rect className="pixel-glow" x="31" y="27" width="1" height="1" /></g>
        </g>
      </>}
      <g className="pixel-mood-marks" aria-hidden="true">
        <path className="mood-brows" d="M11 13h5v1h-5zm10 0h5v1h-5z" />
        <path className="mood-smile" d="M15 20h2v1h4v-1h2v2h-2v1h-4v-1h-2z" />
        <rect className="mood-open-mouth" x="17" y="20" width="3" height="3" />
        <path className="mood-tear" d="M25 18h2v3h-1v2h-2v-2h1z" />
        <path className="mood-drool" d="M21 22h2v3h-1v2h-2v-2h1z" />
        <path className="mood-question" d="M28 8h4v1h1v3h-2v2h-2v-3h2v-1h-3zm1 8h2v2h-2z" />
        <path className="mood-z" d="M27 6h6v2h-3l3 3v2h-6v-2h3l-3-3z" />
        <path className="mood-spark" d="M4 9h2v2h2v2H6v2H4v-2H2v-2h2zm27 7h1v2h2v1h-2v2h-1v-2h-2v-1h2z" />
        <path className="mood-daze" d="M28 7h4v1h1v3h-1v1h-3v-1h2V9h-2v1h-2V8h1z" />
        <path className="mood-focus" d="M10 13h6v2h-4v1h-2zm11 0h6v3h-2v-1h-4z" />
      </g>
      <CosmeticOverlay id={cosmetic} />
    </svg>
  )
}

export default function PetCompanion({ rightInset = 0 }: { rightInset?: number }) {
  const [pet, setPet] = useState<PetState | null>(null)
  const [position, setPosition] = useState<Position | null>(readPosition)
  // 存储不可用（无痕/受限 WebView）时降级为默认启用 wandering，绝不在渲染期抛异常
  const [wanderEnabled, setWanderEnabled] = useState(() => {
    try { return localStorage.getItem(POSITION_KEY) === null } catch { return true }
  })
  const [walking, setWalking] = useState(false)
  const [direction, setDirection] = useState<PetDirection>('right')
  const [perched, setPerched] = useState(false)
  const [behavior, setBehavior] = useState<PetBehavior>('idle')
  const [comment, setComment] = useState('')
  const [tabletCoding, setTabletCoding] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [poking, setPoking] = useState(false)
  const [error, setError] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
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
    let changed = false
    setPet(previous => {
      if (previous && JSON.stringify(persistable(previous)) === serialized) return previous
      changed = true
      return next
    })
    // 写盘在 updater 外：StrictMode/并发下 updater 可能双调用，副作用必须在纯函数外；
    // changed 标志保留"无变化不写盘"语义，存储不可用时静默降级。
    if (changed) {
      try { localStorage.setItem(STORAGE_KEY, serialized) } catch { /* 存储不可用：跳过写盘 */ }
    }
  }, [])

  useEffect(() => {
    if (!IS_TAURI) { setPet(MOCK_PET); return }
    const restore = async () => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        save(saved
          ? await fetchPet('pet_action', { action: 'restore', value: saved })
          : await fetchPet('get_pet'))
      } catch (cause) { setError(String(cause)) }
    }
    restore()
  }, [save])

  useEffect(() => {
    if (!IS_TAURI) return
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try { save(await fetchPet('get_pet')) } catch { /* 下一轮重试 */ }
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
      const currentX = positionRef.current?.x
      if (currentX != null && destination.position.x !== currentX) {
        setDirection(destination.position.x < currentX ? 'left' : 'right')
      }
      setPerched(false)
      positionRef.current = destination.position
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
    return () => {
      cancelled = true
      window.clearTimeout(first)
      window.clearInterval(timer)
      // 残留 settle timer 会按旧 destination 在 effect 重跑后再次 setWalking/Perched
      if (wanderSettleTimerRef.current != null) window.clearTimeout(wanderSettleTimerRef.current)
      wanderSettleTimerRef.current = null
    }
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
    if (next.x !== positionRef.current?.x) setDirection(next.x < (positionRef.current?.x ?? next.x) ? 'left' : 'right')
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
      fetchPet('pet_action', { action: 'poke' })
        .then(save)
        .catch(cause => setError(String(cause)))
    }
  }

  const runAction = (action: 'feed' | 'play' | 'equip' | 'unequip', value?: string) => {
    if (!IS_TAURI) {
      setPet(current => current ? {
        ...current,
        equipped: action === 'equip' ? value || null : action === 'unequip' ? null : current.equipped,
        mood: action === 'feed' || action === 'play' ? 'happy' : current.mood,
        recent_events: action === 'feed' ? [...current.recent_events, 'Feed'] : action === 'play' ? [...current.recent_events, 'Play'] : current.recent_events,
      } : current)
      return
    }
    fetchPet('pet_action', { action, ...(value ? { value } : {}) })
      .then(save)
      .catch(cause => setError(String(cause)))
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

  const pose = resolvePetVisualPose({
    machine: pet?.machine || 'awake.idle',
    recentEvents: pet?.recent_events || [],
    crafting: pet?.crafting || false,
    poking,
    behaviorActive: behavior !== 'idle',
    tabletCoding,
  })

  if (!pet) return error ? <div className="pet-load-error">宠物加载失败：{error}</div> : null

  return (
    <section ref={shellRef} className={`pet-companion ${dragging ? 'dragging' : ''} ${poking ? 'poking' : ''} ${perched ? 'perched' : ''} ${tabletCoding ? 'tablet-coding' : ''} behavior-${behavior} pose-${pose}`}
      style={style} aria-label="长期陪伴宠物"
      data-stage={pet.stage} data-machine={pet.machine} data-mood={pet.mood} data-pose={pose} data-direction={direction}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel} onLostPointerCapture={onLostPointerCapture}>
      {behavior === 'spitting-fragment' && <span className="pet-code-fragment" aria-hidden="true">{'{}'}</span>}
      {comment && <div className="pet-speech-bubble" role="status">{comment}</div>}
      <button className="pet-panel-toggle" type="button" aria-label="打开宠物状态与衣橱" aria-expanded={panelOpen} onClick={() => setPanelOpen(open => !open)}>◆</button>
      {panelOpen && <div className="pet-panel" onPointerDown={event => event.stopPropagation()}>
        <header><div><strong>{pet.name}</strong><span>{pet.title} · 羁绊 {pet.bond}</span></div><span className={`pet-day pet-day-${pet.day_part}`}>{pet.day_part}</span></header>
        <div className="pet-needs">
          {([['饥饿', pet.hunger, 'hunger'], ['趣味', pet.fun, 'fun'], ['陪伴', 100 - pet.loneliness, 'loneliness']] as const).map(([label, value, kind]) => <div className="pet-need" key={kind}><span>{label}</span><i><b className={`need-${kind}`} style={{ width: `${value}%` }} /></i><em>{value}</em></div>)}
        </div>
        <div className="pet-care-controls"><button type="button" onClick={() => runAction('feed')}>喂食</button><button type="button" onClick={() => runAction('play')}>玩耍</button></div>
        {pet.crafting && <div className="pet-crafting"><span>正在捏朋友</span><i><b /></i></div>}
        <div className="pet-wardrobe" aria-label="宠物衣橱">
          <div className="pet-panel-label">衣橱</div>
          <div className="pet-cosmetic-list">
            {pet.cosmetics.map(item => <button key={item.id} type="button" disabled={!item.owned} className={pet.equipped === item.id ? 'equipped' : ''} title={item.owned ? item.name : `${item.name}（未解锁）`} onClick={() => runAction(pet.equipped === item.id ? 'unequip' : 'equip', item.id)}><span className={`pet-cosmetic-swatch swatch-${item.kind}`} />{item.name}</button>)}
            {pet.cosmetics.length === 0 && <span className="pet-panel-empty">装扮目录将在 Tauri 中载入</span>}
          </div>
        </div>
      </div>}
      {tabletCoding && <div className="pet-tablet" aria-label="宠物正在平板电脑上敲代码">
        <span className="pet-tablet-screen"><i /><i /><i /></span>
        <span className="pet-tablet-keyboard" />
      </div>}
      <div className="pet-creature-hitbox"
        title={`${pet.name}：单击互动，拖拽固定位置，双击恢复自主漫游`}>
        <PixelCreature stage={pet.stage} mood={pet.mood} walking={walking} direction={direction} pose={pose} cosmetic={pet.equipped} />
      </div>
    </section>
  )
}
