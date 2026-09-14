// 迁移自 scripts/test-pet-motion.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { classifyPetPointerGesture, clampPetPosition, choosePetDestination, resolvePetClick } from '../petMotion.ts'

function sequence(values: number[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

describe('petMotion 位置/手势/双击（迁移自 scripts/test-pet-motion.mts，P91 A1）', () => {
  const host = { left: 0, top: 0, width: 1000, height: 700 }
  const input = { left: 180, top: 590, width: 620, height: 70 }
  const pet = { width: 116, height: 106 }

  it('clampPetPosition 限制在扣除右栏后的可用工作区', () => {
    expect(clampPetPosition({ x: -20, y: 900 }, host, pet, 220)).toEqual({ x: 0, y: 594 })
  })

  it('choosePetDestination：perched 停靠在输入栏上方', () => {
    const perched = choosePetDestination({ host, input, pet, rightInset: 0, random: sequence([0.2, 0.5, 0.5]) })
    expect(perched.kind).toBe('perched')
    expect(perched.position.x).toBeGreaterThanOrEqual(180)
    expect(perched.position.x).toBeLessThanOrEqual(684) // 停靠点应位于输入栏宽度范围内
    expect(perched.position.y).toBeGreaterThanOrEqual(488)
    expect(perched.position.y).toBeLessThanOrEqual(494) // 停靠点应贴在输入栏上方
  })

  it('随机数决定 wander / edge 目的地', () => {
    expect(choosePetDestination({ host, input, pet, rightInset: 0, random: sequence([0.7, 0.5, 0.5]) }).kind).toBe('wander')
    expect(choosePetDestination({ host, input, pet, rightInset: 0, random: sequence([0.95, 0.5, 0.5]) }).kind).toBe('edge')
  })

  it('右栏打开时漫游点不得进入右栏覆盖区', () => {
    const rightSafe = choosePetDestination({ host, input: null, pet, rightInset: 300, random: sequence([0.7, 0.99, 0.5]) })
    expect(rightSafe.position.x).toBeLessThanOrEqual(584)
  })

  it('classifyPetPointerGesture：click / drag / none', () => {
    expect(classifyPetPointerGesture({ startX: 10, startY: 10, endX: 13, endY: 12, durationMs: 180 })).toBe('click')
    expect(classifyPetPointerGesture({ startX: 10, startY: 10, endX: 30, endY: 10, durationMs: 180 })).toBe('drag')
    expect(classifyPetPointerGesture({ startX: 10, startY: 10, endX: 10, endY: 10, durationMs: 700 })).toBe('none')
  })

  it('resolvePetClick 双击窗口判定', () => {
    expect(resolvePetClick({ lastClickAt: null, currentClickAt: 1000 })).toEqual({ kind: 'pending-single', nextLastClickAt: 1000 })
    expect(resolvePetClick({ lastClickAt: 1000, currentClickAt: 1220 })).toEqual({ kind: 'double', nextLastClickAt: null })
    expect(resolvePetClick({ lastClickAt: 1000, currentClickAt: 1400 })).toEqual({ kind: 'pending-single', nextLastClickAt: 1400 })
  })
})
