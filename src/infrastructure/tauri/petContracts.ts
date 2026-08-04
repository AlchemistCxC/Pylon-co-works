/**
 * petContracts — 宠物后端 DTO 收窄（H2）。
 *
 * 此前 snake_case DTO 只在 PetCompanion 组件内声明，invoke<PetState> 结果直接信任并
 * 写回 localStorage——后端漂移时前端静默把错误结构持久化（污染长期存储）。集中定义 +
 * normalize：按字段类型兜底，未知值回默认，杜绝脏数据入库。
 */

export const PET_GROWTH_STAGES = ['seed', 'sprout', 'hopper', 'guardian', 'luminary'] as const
export type PetGrowthStage = (typeof PET_GROWTH_STAGES)[number]

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
  stats: PetStats
  memories: string[]
  stage: PetGrowthStage
  title: string
  age_days: number
  next_stage_xp: number | null
  growth_progress: number
  msg?: string
}

const num = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
const maybeNum = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export function normalizePetStats(raw: unknown): PetStats {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
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
    active_days: num(r.active_days),
    streak_days: num(r.streak_days),
    longest_streak: num(r.longest_streak),
  }
}

export function normalizePetState(raw: unknown): PetState {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const stage = str(r.stage) as PetGrowthStage
  return {
    name: str(r.name, '宠物'),
    mood: str(r.mood, 'calm'),
    happiness: num(r.happiness),
    energy: num(r.energy),
    xp: num(r.xp),
    bond: num(r.bond),
    born_at_ms: num(r.born_at_ms),
    last_seen_day: num(r.last_seen_day),
    first_chunk_at_ms: maybeNum(r.first_chunk_at_ms),
    stats: normalizePetStats(r.stats),
    memories: stringList(r.memories),
    stage: (PET_GROWTH_STAGES as readonly string[]).includes(stage) ? stage : 'seed',
    title: str(r.title),
    age_days: num(r.age_days),
    next_stage_xp: maybeNum(r.next_stage_xp),
    growth_progress: num(r.growth_progress),
    ...(r.msg !== undefined ? { msg: str(r.msg) } : {}),
  }
}
