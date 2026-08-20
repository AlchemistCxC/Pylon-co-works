export type PetBehavior =
  | 'idle'
  | 'sniffing-code'
  | 'eating-code'
  | 'chewing'
  | 'spitting-fragment'
  | 'commenting'

const CODE_COMMENTS = [
  '这段缩进有点硌牙。',
  '泛型嚼起来像硬糖。',
  '这里的分支味道太重了。',
  '嗯，类型是脆的。',
  '这个函数有点长。',
]

const NEXT_BEHAVIOR: Record<PetBehavior, PetBehavior> = {
  idle: 'sniffing-code',
  'sniffing-code': 'eating-code',
  'eating-code': 'chewing',
  chewing: 'spitting-fragment',
  'spitting-fragment': 'commenting',
  commenting: 'idle',
}

export function shouldStartCodeEating({ hasCode, perched, random = Math.random }: {
  hasCode: boolean
  perched: boolean
  random?: () => number
}) {
  return hasCode && !perched && random() < 0.12
}

export function shouldStartTabletCoding({ generating, behavior, random = Math.random }: {
  generating: boolean
  behavior: PetBehavior
  random?: () => number
}) {
  return generating && behavior === 'idle' && random() < 0.35
}

export function advanceCodeEatingBehavior(behavior: PetBehavior): PetBehavior {
  return NEXT_BEHAVIOR[behavior]
}

export function getCodeComment(random: () => number = Math.random) {
  const index = Math.min(CODE_COMMENTS.length - 1, Math.floor(random() * CODE_COMMENTS.length))
  return CODE_COMMENTS[index]
}
