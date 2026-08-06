export const PET_GROWTH_STAGES = ['seed', 'sprout', 'hopper', 'guardian', 'luminary'] as const
export type PetGrowthStage = (typeof PET_GROWTH_STAGES)[number]

export const PET_MACHINES = ['awake.idle', 'awake.interacting', 'awake.distress', 'asleep'] as const
export type PetMachine = (typeof PET_MACHINES)[number]

export const PET_DAY_PARTS = ['dawn', 'day', 'dusk', 'night'] as const
export type PetDayPart = (typeof PET_DAY_PARTS)[number]

export const PET_RECENT_EVENTS = [
  'Poke', 'Feed', 'Play', 'Done', 'Failed', 'Timeout', 'Refused', 'Maxed',
  'ToolOk', 'ToolFail', 'ToolCancel', 'Crashed', 'Connected', 'Code', 'Read',
  'Exec', 'Net', 'Spawn', 'ModeCode', 'ModePlan', 'ModelNew',
] as const
export type PetRecentEvent = (typeof PET_RECENT_EVENTS)[number]

export const PET_COSMETIC_KINDS = ['hat', 'cape', 'glow', 'companion'] as const
export type PetCosmeticKind = (typeof PET_COSMETIC_KINDS)[number]

export interface PetTraits {
  activity: number
  clinginess: number
  greed: number
  curiosity: number
}

export interface PetCosmetic {
  id: string
  name: string
  kind: PetCosmeticKind
  icon: string
  owned: boolean
}

export interface PetAchievement {
  id: string
  name: string
  description: string
  icon: string
  unlocked: boolean
}

export interface PetStats {
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
  code_sessions: number
  code_eaten: number
  code_watched: number
  friends_made: number
  dazes: number
  code_files: string[]
  feed_count: number
  play_count: number
  night_visits: number
  cosmetics_collected: number
}

export interface PetState {
  name: string
  mood: string
  happiness: number
  energy: number
  xp: number
  bond: number
  born_at_ms: number
  last_seen_day: number
  first_chunk_at_ms: number | null
  hunger: number
  fun: number
  loneliness: number
  traits: PetTraits
  machine: PetMachine
  last_tick_at_ms: number
  recent_events: PetRecentEvent[]
  last_agent_mode: string | null
  last_agent_model: string | null
  pending_action: unknown | null
  unlocked: string[]
  inventory: string[]
  equipped: string | null
  last_drop_at_ms: number
  stats: PetStats
  memories: string[]
  stage: PetGrowthStage
  title: string
  age_days: number
  next_stage_xp: number | null
  growth_progress: number
  crafting: boolean
  day_part: PetDayPart
  achievements: PetAchievement[]
  cosmetics: PetCosmetic[]
  msg?: string
}

const num = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
const bool = (value: unknown, fallback = false): boolean => typeof value === 'boolean' ? value : fallback
const maybeNum = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const maybeStr = (value: unknown): string | null => typeof value === 'string' ? value : null
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const enumValue = <T extends string>(value: unknown, values: readonly T[], fallback: T): T => {
  const candidate = str(value)
  return values.includes(candidate as T) ? candidate as T : fallback
}

export function normalizePetTraits(raw: unknown): PetTraits {
  const r = record(raw)
  return {
    activity: num(r.activity, 50),
    clinginess: num(r.clinginess, 50),
    greed: num(r.greed, 50),
    curiosity: num(r.curiosity, 50),
  }
}

export function normalizePetStats(raw: unknown): PetStats {
  const r = record(raw)
  return {
    messages: num(r.messages),
    prompts_completed: num(r.prompts_completed),
    prompts_failed: num(r.prompts_failed),
    tokens_total: num(r.tokens_total),
    token_xp: num(r.token_xp),
    tools_started: num(r.tools_started),
    tools_succeeded: num(r.tools_succeeded),
    tools_failed: num(r.tools_failed),
    tool_success_rate: num(r.tool_success_rate),
    interactions: num(r.interactions),
    active_days: num(r.active_days, 1),
    streak_days: num(r.streak_days, 1),
    longest_streak: num(r.longest_streak, 1),
    code_sessions: num(r.code_sessions),
    code_eaten: num(r.code_eaten),
    code_watched: num(r.code_watched),
    friends_made: num(r.friends_made),
    dazes: num(r.dazes),
    code_files: stringList(r.code_files),
    feed_count: num(r.feed_count),
    play_count: num(r.play_count),
    night_visits: num(r.night_visits),
    cosmetics_collected: num(r.cosmetics_collected),
  }
}

export function normalizePetCosmetics(raw: unknown): PetCosmetic[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    const r = record(item)
    const id = str(r.id)
    if (!id) return []
    return [{
      id,
      name: str(r.name, id),
      kind: enumValue(r.kind, PET_COSMETIC_KINDS, 'glow'),
      icon: str(r.icon),
      owned: bool(r.owned),
    }]
  })
}

export function normalizePetAchievements(raw: unknown): PetAchievement[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    const r = record(item)
    const id = str(r.id)
    if (!id) return []
    return [{
      id,
      name: str(r.name, id),
      description: str(r.description),
      icon: str(r.icon),
      unlocked: bool(r.unlocked),
    }]
  })
}

export function normalizePetState(raw: unknown): PetState {
  const r = record(raw)
  const stage = enumValue(r.stage, PET_GROWTH_STAGES, 'seed')
  return {
    name: str(r.name, '宠物'),
    mood: str(r.mood, 'idle'),
    happiness: num(r.happiness),
    energy: num(r.energy, 80),
    xp: num(r.xp),
    bond: num(r.bond),
    born_at_ms: num(r.born_at_ms),
    last_seen_day: num(r.last_seen_day),
    first_chunk_at_ms: maybeNum(r.first_chunk_at_ms),
    hunger: num(r.hunger, 80),
    fun: num(r.fun, 70),
    loneliness: num(r.loneliness),
    traits: normalizePetTraits(r.traits),
    machine: enumValue(r.machine, PET_MACHINES, 'awake.idle'),
    last_tick_at_ms: num(r.last_tick_at_ms),
    recent_events: stringList(r.recent_events).filter((event): event is PetRecentEvent => (PET_RECENT_EVENTS as readonly string[]).includes(event)),
    last_agent_mode: maybeStr(r.last_agent_mode),
    last_agent_model: maybeStr(r.last_agent_model),
    pending_action: r.pending_action ?? null,
    unlocked: stringList(r.unlocked),
    inventory: stringList(r.inventory),
    equipped: maybeStr(r.equipped),
    last_drop_at_ms: num(r.last_drop_at_ms),
    stats: normalizePetStats(r.stats),
    memories: stringList(r.memories),
    stage,
    title: str(r.title),
    age_days: num(r.age_days),
    next_stage_xp: maybeNum(r.next_stage_xp),
    growth_progress: num(r.growth_progress),
    crafting: bool(r.crafting),
    day_part: enumValue(r.day_part, PET_DAY_PARTS, 'day'),
    achievements: normalizePetAchievements(r.achievements),
    cosmetics: normalizePetCosmetics(r.cosmetics),
    ...(r.msg !== undefined ? { msg: str(r.msg) } : {}),
  }
}
