import { describe, expect, it } from 'vitest'
import { parseTranslateOffset, rectsOverlap, resolveAllowedOffset, shouldBypassCollisionConstraint, type CcRectLike } from '../ccPlacementCollision.ts'

/**
 * #238 刀4「占区不叠加」的纯几何单测（node 环境，不依赖 DOM）。
 * 组件级（两条通路都接上守卫）见 `mountSolidWorkbench.solid.test.tsx`。
 */

const rect = (left: number, top: number, right: number, bottom: number): CcRectLike => ({ left, top, right, bottom })

describe('#238 刀4 · 相交判据（面积 > 0；★ 允许贴合）', () => {
  it('相交（含包含关系）为 true', () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(5, 5, 15, 15))).toBe(true)
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(2, 2, 4, 4))).toBe(true)
  })

  it('★ 边贴边（交集面积 = 0）不算撞 —— 不加魔法间隙', () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(10, 0, 20, 10))).toBe(false) // 右缘贴左缘
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(0, 10, 10, 20))).toBe(false) // 下缘贴上缘
  })

  it('完全分离为 false', () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(11, 0, 20, 10))).toBe(false)
  })
})

describe('#238 刀4 · 约束算法「推不动就贴着它滑」', () => {
  // 被拖者 0,0..100,40（此刻 offset = 0,0）；障碍 200,0..300,40
  const base = rect(0, 0, 100, 40)
  const obstacle = rect(200, 0, 300, 40)
  const applied = { offsetX: 0, offsetY: 0 }

  it('① 全量候选不撞 ⇒ 采用', () => {
    expect(resolveAllowedOffset({
      applied, baseRect: base, candidate: { offsetX: 50, offsetY: 0 }, previous: applied, obstacles: [obstacle],
    })).toEqual({ offsetX: 50, offsetY: 0 })
  })

  it('① 贴合允许：候选刚好贴到障碍左缘（= 100）⇒ 采用', () => {
    expect(resolveAllowedOffset({
      applied, baseRect: base, candidate: { offsetX: 100, offsetY: 0 }, previous: applied, obstacles: [obstacle],
    })).toEqual({ offsetX: 100, offsetY: 0 })
  })

  it('② 全量撞、只水平走不撞 ⇒ 水平滑走（保留上一次的 y）', () => {
    // 障碍在**右下**（140,50..240,90）：候选 (50,60) ⇒ 矩形 50,60..150,100 与它相交（x 140..150、y 60..90）
    // 只水平 (50,0) ⇒ 50,0..150,40：与障碍 y 方向完全不相交 ⇒ 放行
    const rightBelow = rect(140, 50, 240, 90)
    const allowed = resolveAllowedOffset({
      applied, baseRect: base, candidate: { offsetX: 50, offsetY: 60 }, previous: applied, obstacles: [rightBelow],
    })
    expect(allowed).toEqual({ offsetX: 50, offsetY: 0 })
  })

  it('③ 全量撞、只垂直走不撞 ⇒ 垂直滑走（保留上一次的 x）', () => {
    // 障碍在**正右**（140,0..240,90）：候选 (50,60) 撞；只水平 (50,0) 也撞（x 140..150、y 0..40）；
    // 只垂直 (0,60) ⇒ 0,60..100,100：x 方向完全不相交 ⇒ 放行
    const rightSide = rect(140, 0, 240, 90)
    const allowed = resolveAllowedOffset({
      applied, baseRect: base, candidate: { offsetX: 50, offsetY: 60 }, previous: applied, obstacles: [rightSide],
    })
    expect(allowed).toEqual({ offsetX: 0, offsetY: 60 })
  })

  it('④ 全都不行 ⇒ 保持原位（不是弹回原点，是"上一次被接受的位置"）', () => {
    const blocked = rect(0, 0, 1000, 1000) // 四面围死
    expect(resolveAllowedOffset({
      applied, baseRect: base, candidate: { offsetX: 30, offsetY: 30 }, previous: { offsetX: 12, offsetY: -4 }, obstacles: [blocked],
    })).toEqual({ offsetX: 12, offsetY: -4 })
  })

  it('候选矩形按 `applied` 换算：此刻已经带了偏移（+50,0）⇒ 再 +50 的候选是 +100', () => {
    // 此刻矩形 = 已含 offset 50 ⇒ 50,0..150,40；候选 offset 100 ⇒ 100,0..200,40（仍不撞障碍 200..300）
    const allowed = resolveAllowedOffset({
      applied: { offsetX: 50, offsetY: 0 },
      baseRect: rect(50, 0, 150, 40),
      candidate: { offsetX: 100, offsetY: 0 },
      previous: { offsetX: 50, offsetY: 0 },
      obstacles: [obstacle],
    })
    expect(allowed).toEqual({ offsetX: 100, offsetY: 0 })
  })

  it('存量重叠不消解：原位上就叠着（不在障碍集里的旧邻居）⇒ 回退到原位也不额外惩罚', () => {
    // previous 本身就与某障碍相交 ⇒ 四个候选都撞 ⇒ 返回 previous（保持原样，不推开）
    const overlapping = rect(0, 0, 100, 40)
    expect(resolveAllowedOffset({
      applied, baseRect: base, candidate: { offsetX: 5, offsetY: 5 }, previous: applied, obstacles: [overlapping],
    })).toEqual({ offsetX: 0, offsetY: 0 })
  })
})

describe('#238 刀4 · 从 inline transform 读回此刻生效的偏移', () => {
  it('空 / 无匹配 ⇒ 零偏移', () => {
    expect(parseTranslateOffset('')).toEqual({ offsetX: 0, offsetY: 0 })
    expect(parseTranslateOffset(null)).toEqual({ offsetX: 0, offsetY: 0 })
    expect(parseTranslateOffset('none')).toEqual({ offsetX: 0, offsetY: 0 })
  })

  it('读回 `placementStyle` 写的那两种形状（含负值与无空格）', () => {
    expect(parseTranslateOffset('translate(12px, -3px)')).toEqual({ offsetX: 12, offsetY: -3 })
    expect(parseTranslateOffset('translate(-48px,-16px)')).toEqual({ offsetX: -48, offsetY: -16 })
  })
})

describe('#238 刀4 · 什么时候**不做**约束（豁免判据，纯函数可测）', () => {
  const floating = ['cc-send-button']
  it('非编辑态一律放行（常态界面不跑几何）', () => {
    expect(shouldBypassCollisionConstraint({ editMode: false, id: 'model', floatingIds: floating, touchesOffset: true })).toBe(true)
    expect(shouldBypassCollisionConstraint({ editMode: false, id: 'cc-send-button', floatingIds: floating, touchesOffset: true })).toBe(true)
  })

  it('★ 悬浮件放行（发送按钮本来就要压在输入栏上）', () => {
    expect(shouldBypassCollisionConstraint({ editMode: true, id: 'cc-send-button', floatingIds: floating, touchesOffset: true })).toBe(true)
  })

  it('只改 order 不进约束', () => {
    expect(shouldBypassCollisionConstraint({ editMode: true, id: 'model', floatingIds: floating, touchesOffset: false })).toBe(true)
  })

  it('编辑态 + 非悬浮 + 碰了偏移 ⇒ **必须**走约束', () => {
    expect(shouldBypassCollisionConstraint({ editMode: true, id: 'model', floatingIds: floating, touchesOffset: true })).toBe(false)
    expect(shouldBypassCollisionConstraint({ editMode: true, id: 'input', floatingIds: floating, touchesOffset: true })).toBe(false)
  })
})
