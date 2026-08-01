import assert from 'node:assert/strict'
import { classifyPetPointerGesture, clampPetPosition, choosePetDestination, resolvePetClick } from '../src/components/petMotion.ts'

const host = { left: 0, top: 0, width: 1000, height: 700 }
const input = { left: 180, top: 590, width: 620, height: 70 }
const pet = { width: 116, height: 106 }

assert.deepEqual(clampPetPosition({ x: -20, y: 900 }, host, pet, 220), { x: 0, y: 594 },
  '位置应限制在扣除右栏后的可用工作区')

const perched = choosePetDestination({ host, input, pet, rightInset: 0, random: sequence([0.2, 0.5, 0.5]) })
assert.equal(perched.kind, 'perched')
assert.ok(perched.position.x >= 180 && perched.position.x <= 684, '停靠点应位于输入栏宽度范围内')
assert.ok(perched.position.y >= 488 && perched.position.y <= 494, '停靠点应贴在输入栏上方')

assert.equal(choosePetDestination({ host, input, pet, rightInset: 0, random: sequence([0.7, 0.5, 0.5]) }).kind, 'wander')
assert.equal(choosePetDestination({ host, input, pet, rightInset: 0, random: sequence([0.95, 0.5, 0.5]) }).kind, 'edge')

const rightSafe = choosePetDestination({ host, input: null, pet, rightInset: 300, random: sequence([0.7, 0.99, 0.5]) })
assert.ok(rightSafe.position.x <= 584, '右栏打开时漫游点不得进入右栏覆盖区')

assert.equal(classifyPetPointerGesture({ startX: 10, startY: 10, endX: 13, endY: 12, durationMs: 180 }), 'click')
assert.equal(classifyPetPointerGesture({ startX: 10, startY: 10, endX: 30, endY: 10, durationMs: 180 }), 'drag')
assert.equal(classifyPetPointerGesture({ startX: 10, startY: 10, endX: 10, endY: 10, durationMs: 700 }), 'none')
assert.deepEqual(resolvePetClick({ lastClickAt: null, currentClickAt: 1000 }), { kind: 'pending-single', nextLastClickAt: 1000 })
assert.deepEqual(resolvePetClick({ lastClickAt: 1000, currentClickAt: 1220 }), { kind: 'double', nextLastClickAt: null })
assert.deepEqual(resolvePetClick({ lastClickAt: 1000, currentClickAt: 1400 }), { kind: 'pending-single', nextLastClickAt: 1400 })

console.log('pet motion tests passed')

function sequence(values: number[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}
