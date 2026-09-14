/**
 * ISSUE-18 W1（LR2-WI08）：Pet 权威源仲裁——不得无条件 localStorage 覆盖后端。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizePetState,
  normalizePetStats,
  resolvePetStateConflict,
  toPetStateEnvelope,
  type PetState,
} from '../petContracts.ts'

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

// ── 迁移自 scripts/test-pet-contracts.mts（P91 A1）──
// H2：宠物 snake_case DTO 收窄——脏数据按字段类型兜底，杜绝污染 localStorage
describe('petContracts snake_case DTO 收窄（迁移自 scripts/test-pet-contracts.mts，P91 A1）', () => {
  it('normalizePetStats：非数字字段回退 0', () => {
    const stats = normalizePetStats({ messages: 'bad', prompts_completed: 3, tokens_total: 99 })
    expect(stats.messages).toBe(0) // 非数字字段回退 0
    expect(stats.prompts_completed).toBe(3)
    expect(stats.tokens_total).toBe(99)
  })

  it('normalizePetState：脏数据按字段类型兜底', () => {
    const state = normalizePetState({
      happiness: 'high',
      energy: 50,
      xp: 120,
      stage: 'hooper', // 非法 stage → seed
      stats: { tokens_total: 'x' },
      memories: ['a', 42, 'b'],
      first_chunk_at_ms: null,
    })
    expect(state.happiness).toBe(0) // 非法 happiness 回退 0
    expect(state.energy).toBe(50)
    expect(state.stage).toBe('seed') // 非法 stage 回退 seed
    expect(state.stats.tokens_total).toBe(0)
    expect(state.memories).toEqual(['a', 'b']) // memories 只留字符串
    expect(state.first_chunk_at_ms).toBeNull()
    expect(state.name).toBe('宠物') // 缺省 name 回退
  })

  it('完全缺失的输入 → 全默认（不崩、可持久化）', () => {
    const empty = normalizePetState(undefined)
    expect(empty.name).toBe('宠物')
    expect(empty.stats.messages).toBe(0)
  })
})
