// 迁移自 scripts/test-pet-behavior.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { advanceCodeEatingBehavior, getCodeComment, shouldStartCodeEating, shouldStartTabletCoding, type PetBehavior } from '../petBehavior.ts'

describe('petBehavior 行为触发序列（迁移自 scripts/test-pet-behavior.mts，P91 A1）', () => {
  it('shouldStartCodeEating 门槛：有代码且未停靠输入栏才可能触发', () => {
    expect(shouldStartCodeEating({ hasCode: false, perched: false, random: () => 0 })).toBe(false)
    expect(shouldStartCodeEating({ hasCode: true, perched: true, random: () => 0 })).toBe(false) // 输入栏停靠期间不应触发啃代码
    expect(shouldStartCodeEating({ hasCode: true, perched: false, random: () => 0.05 })).toBe(true)
    expect(shouldStartCodeEating({ hasCode: true, perched: false, random: () => 0.5 })).toBe(false)
  })

  it('advanceCodeEatingBehavior 状态序列：sniffing → eating → chewing → spitting → commenting → idle', () => {
    const expected = ['sniffing-code', 'eating-code', 'chewing', 'spitting-fragment', 'commenting', 'idle'] as const
    let behavior: PetBehavior = 'idle'
    for (const next of expected) {
      behavior = advanceCodeEatingBehavior(behavior)
      expect(behavior).toBe(next)
    }
  })

  it('getCodeComment 按随机数取评语', () => {
    expect(getCodeComment(() => 0)).toBe('这段缩进有点硌牙。')
    expect(getCodeComment(() => 0.999)).toBe('这个函数有点长。')
  })

  it('shouldStartTabletCoding 门槛：生成中且空闲才可能触发', () => {
    expect(shouldStartTabletCoding({ generating: false, behavior: 'idle', random: () => 0 })).toBe(false)
    expect(shouldStartTabletCoding({ generating: true, behavior: 'chewing', random: () => 0 })).toBe(false) // 宠物执行其他行为时不应突然掏出平板
    expect(shouldStartTabletCoding({ generating: true, behavior: 'idle', random: () => 0.34 })).toBe(true)
    expect(shouldStartTabletCoding({ generating: true, behavior: 'idle', random: () => 0.35 })).toBe(false)
  })
})
