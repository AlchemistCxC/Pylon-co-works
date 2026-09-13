// 迁移自 scripts/test-tool-indicator-visual.mts + scripts/test-tool-status-exhaustive.mts + scripts/test-tool-status.mts（P91 A1）。
// test-tool-indicator-visual.mts 的 CSS 源码正则断言段不迁（结构守卫，非行为证据）。
import { describe, expect, it } from 'vitest'
import { assertNeverToolStatus, normalizeToolStatus, resolveToolPresentationState } from '../status.ts'
import { resolveToolIndicatorMotion, toolIndicatorMotionClass } from '../../../components/chat/toolIndicatorMotion.ts'

describe('toolIndicatorMotion 状态动画映射（迁移自 scripts/test-tool-indicator-visual.mts，P91 A1）', () => {
  it('7 态 → 动画映射；class 后缀拼接', () => {
    expect(resolveToolIndicatorMotion('queued')).toBe('static')
    expect(resolveToolIndicatorMotion('running')).toBe('breathe')
    expect(resolveToolIndicatorMotion('waiting')).toBe('pulse')
    expect(resolveToolIndicatorMotion('completed')).toBe('settle')
    expect(resolveToolIndicatorMotion('failed')).toBe('flash')
    expect(resolveToolIndicatorMotion('cancelled')).toBe('static')
    expect(resolveToolIndicatorMotion('unknown')).toBe('static')
    expect(toolIndicatorMotionClass('running')).toBe('term-tool-indicator--breathe')
  })

  it('状态动画与颜色解析分离：相同的主题颜色 resolver 仍然负责状态颜色（B2：唯一 API）', () => {
    expect(resolveToolPresentationState('completed').tone).toBe('ok')
    expect(resolveToolPresentationState('running').tone).toBe('run')
    expect(resolveToolPresentationState('failed').tone).toBe('err')
    expect(resolveToolPresentationState(undefined, true).tone).toBe('ok') // unknown+有输出 → ok
    expect(resolveToolPresentationState(undefined, false).tone).toBe('run') // unknown+无输出 → run
  })
})

describe('normalizeToolStatus 穷举 + tone 派生（迁移自 scripts/test-tool-status-exhaustive.mts，P91 A1）', () => {
  it('主分支归一化；未知状态 → unknown', () => {
    expect(normalizeToolStatus('pending')).toBe('queued')
    expect(normalizeToolStatus('in_progress')).toBe('running')
    expect(normalizeToolStatus('completed')).toBe('completed')
    expect(normalizeToolStatus('failed')).toBe('failed')
    expect(normalizeToolStatus('cancelled')).toBe('cancelled')
    expect(normalizeToolStatus('future-status')).toBe('unknown')
  })

  it('别名分支（防回退）', () => {
    expect(normalizeToolStatus('canceled')).toBe('cancelled') // 单 l 'canceled' → cancelled
    expect(normalizeToolStatus('success')).toBe('completed') // 'success' → completed
    expect(normalizeToolStatus('pending')).toBe('queued') // 'pending' → queued
    expect(normalizeToolStatus('error')).toBe('failed') // 'error' → failed
    expect(normalizeToolStatus('in_progress')).toBe('running') // 'in_progress' → running
  })

  it('resolveToolPresentationState tone 派生；assertNever 穷尽守卫', () => {
    expect(resolveToolPresentationState('waiting').tone).toBe('run')
    expect(resolveToolPresentationState('completed').tone).toBe('ok')
    expect(resolveToolPresentationState('failed').tone).toBe('err')
    expect(resolveToolPresentationState(undefined, true).tone).toBe('ok')
    expect(resolveToolPresentationState(undefined, false).tone).toBe('run')
    expect(() => assertNeverToolStatus('invalid' as never)).toThrow(/未处理的工具状态: invalid/)
  })
})

describe('resolveToolPresentationState tone 解析（B2 唯一 API；迁移自 scripts/test-tool-status.mts，P91 A1）', () => {
  it('别名输入 → tone 收敛', () => {
    expect(resolveToolPresentationState('pending').tone).toBe('run')
    expect(resolveToolPresentationState('in_progress').tone).toBe('run')
    expect(resolveToolPresentationState('completed').tone).toBe('ok')
    expect(resolveToolPresentationState('failed').tone).toBe('err')
    expect(resolveToolPresentationState('error').tone).toBe('err')
    expect(resolveToolPresentationState(undefined, true).tone).toBe('ok')
    expect(resolveToolPresentationState(undefined, false).tone).toBe('run')
  })
})
