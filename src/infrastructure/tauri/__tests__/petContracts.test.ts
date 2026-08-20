/**
 * ISSUE-18 W1（LR2-WI08）：Pet 权威源仲裁——不得无条件 localStorage 覆盖后端。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizePetState,
  resolvePetStateConflict,
  toPetStateEnvelope,
  type PetState,
} from '../petContracts'

function petState(overrides: Partial<PetState>): PetState {
  const base: PetState = {
    name: '微栖', mood: 'idle', happiness: 65, energy: 80, xp: 0, bond: 0,
    born_at_ms: 0, last_seen_day: 1, first_chunk_at_ms: null,
    hunger: 80, fun: 70, loneliness: 0,
    traits: { activity: 60, clinginess: 60, greed: 60, curiosity: 60 },
    machine: 'awake.idle', last_tick_at_ms: 0, recent_events: [],
    last_agent_mode: null, last_agent_model: null, pending_action: null,
    unlocked: [], inventory: [], equipped: null, last_drop_at_ms: 0,
    stats: {
      messages: 0, prompts_completed: 0, prompts_failed: 0, tokens_total: 0, token_xp: 0,
      tools_started: 0, tools_succeeded: 0, tools_failed: 0, tool_success_rate: 0,
      interactions: 0, active_days: 1, streak_days: 1, longest_streak: 1,
      code_sessions: 0, code_eaten: 0, code_watched: 0, friends_made: 0, dazes: 0,
      code_files: [], feed_count: 0, play_count: 0, night_visits: 0, cosmetics_collected: 0,
    },
    memories: [], stage: 'seed', title: '微光种', age_days: 1,
    next_stage_xp: 25, growth_progress: 0, crafting: false, day_part: 'day',
    achievements: [], cosmetics: [],
  }
  return { ...base, ...overrides }
}

describe('resolvePetStateConflict（ISSUE-18 W1 权威源仲裁）', () => {
  it('本地较新 → 本地胜（推送本地到后端，不静默覆盖）', () => {
    const local = toPetStateEnvelope(petState({ last_tick_at_ms: 2000 }), 'local')
    const backend = toPetStateEnvelope(petState({ last_tick_at_ms: 1000 }), 'backend')
    const winner = resolvePetStateConflict(local, backend)
    expect(winner?.source).toBe('local')
  })

  it('后端较新 → 后端胜（localStorage 缓存不得覆盖后端权威状态）', () => {
    const local = toPetStateEnvelope(petState({ last_tick_at_ms: 1000 }), 'local')
    const backend = toPetStateEnvelope(petState({ last_tick_at_ms: 2000 }), 'backend')
    const winner = resolvePetStateConflict(local, backend)
    expect(winner?.source).toBe('backend')
  })

  it('相等 → backend 优先（后端为单一权威源）', () => {
    const local = toPetStateEnvelope(petState({ last_tick_at_ms: 1000 }), 'local')
    const backend = toPetStateEnvelope(petState({ last_tick_at_ms: 1000 }), 'backend')
    const winner = resolvePetStateConflict(local, backend)
    expect(winner?.source).toBe('backend')
  })

  it('单侧缺失 → 取存在侧', () => {
    const backend = toPetStateEnvelope(petState({ last_tick_at_ms: 1000 }), 'backend')
    expect(resolvePetStateConflict(null, backend)?.source).toBe('backend')
    const local = toPetStateEnvelope(petState({ last_tick_at_ms: 1000 }), 'local')
    expect(resolvePetStateConflict(local, null)?.source).toBe('local')
    expect(resolvePetStateConflict(null, null)).toBeNull()
  })
})

describe('normalizePetState 保留仲裁键', () => {
  it('last_tick_at_ms 透传（仲裁键不丢失）', () => {
    const raw = { name: 'p', last_tick_at_ms: 1234 }
    const state = normalizePetState(raw)
    expect(state.last_tick_at_ms).toBe(1234)
    expect(toPetStateEnvelope(state, 'backend').updatedAtMs).toBe(1234)
  })
})
