import type { PetMachine, PetRecentEvent } from '../infrastructure/tauri/petContracts'

export type PetVisualPose =
  | 'idle'
  | 'interact'
  | 'sleep'
  | 'happy'
  | 'distress'
  | 'sniff-code'
  | 'read'
  | 'execute-cover-ears'
  | 'network-look'
  | 'craft-friend'
  | 'dazed'
  | 'confused'
  | 'startled'
  | 'tired'

const POSE_BY_EVENT: Partial<Record<PetRecentEvent, PetVisualPose>> = {
  Poke: 'interact',
  Feed: 'happy',
  Play: 'happy',
  Done: 'happy',
  Failed: 'distress',
  Timeout: 'dazed',
  Refused: 'confused',
  Maxed: 'tired',
  ToolFail: 'distress',
  ToolCancel: 'startled',
  Crashed: 'distress',
  Connected: 'happy',
  Code: 'sniff-code',
  Read: 'read',
  Exec: 'execute-cover-ears',
  Net: 'network-look',
  Spawn: 'craft-friend',
  ModeCode: 'read',
}

export function resolvePetVisualPose({
  machine,
  recentEvents,
  crafting,
  poking,
  behaviorActive,
  tabletCoding,
}: {
  machine: PetMachine
  recentEvents: readonly PetRecentEvent[]
  crafting: boolean
  poking: boolean
  behaviorActive: boolean
  tabletCoding: boolean
}): PetVisualPose {
  if (poking) return 'interact'
  if (behaviorActive) return 'sniff-code'
  if (tabletCoding) return 'read'
  if (machine === 'asleep') return 'sleep'
  if (machine === 'awake.distress') return 'distress'

  const latest = recentEvents.at(-1)
  if (latest && POSE_BY_EVENT[latest]) return POSE_BY_EVENT[latest]
  if (crafting) return 'craft-friend'
  if (machine === 'awake.interacting') return 'interact'
  return 'idle'
}
