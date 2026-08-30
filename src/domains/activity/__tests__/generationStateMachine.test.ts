import { describe, expect, it } from 'vitest'
import {
  legacyPhaseFromActivity,
  reduceGenerationActivity,
  resolveGenerationIndicatorContext,
  resolveGenerationIndicatorCopy,
} from '../generationStateMachine.ts'

describe('generation activity state machine', () => {
  it('保留并行工具，最后一个工具结束后恢复此前活动', () => {
    let state = reduceGenerationActivity(undefined, { type: 'start', at: 0 })
    state = reduceGenerationActivity(state, { type: 'tool-start', id: 'read-1', name: 'Read', at: 10 })
    state = reduceGenerationActivity(state, { type: 'tool-start', id: 'grep-1', name: 'Grep', at: 20 })
    expect(state?.kind).toBe('tooling')
    expect(state?.activeTools.map(tool => tool.name)).toEqual(['Read', 'Grep'])

    state = reduceGenerationActivity(state, { type: 'responding', at: 30 })
    expect(state?.kind).toBe('tooling')
    expect(state?.resumeKind).toBe('responding')
    state = reduceGenerationActivity(state, { type: 'tool-end', id: 'read-1', at: 40 })
    expect(state?.activeTools.map(tool => tool.name)).toEqual(['Grep'])
    state = reduceGenerationActivity(state, { type: 'tool-end', id: 'grep-1', at: 50 })
    expect(state?.kind).toBe('responding')
    expect(state?.activeTools).toEqual([])
    expect(legacyPhaseFromActivity(state)).toEqual({ kind: 'responding' })
  })

  it('预设词作为主文案，phase 只提供次级上下文', () => {
    const context = resolveGenerationIndicatorContext({ phase: { kind: 'thinking' } })
    expect(context.label).toBe('思考中')
    expect(resolveGenerationIndicatorCopy({
      running: true,
      liveness: 'active',
      presetVerb: '博大精深',
      context,
    })).toEqual({ primary: '博大精深', secondary: '思考中' })
  })

  it('waiting/stalled 保留明确的后端活性提示', () => {
    const context = resolveGenerationIndicatorContext({ phase: { kind: 'responding' } })
    expect(resolveGenerationIndicatorCopy({ running: true, liveness: 'waiting', presetVerb: '博大精深', context }))
      .toEqual({ primary: '等待响应' })
    expect(resolveGenerationIndicatorCopy({ running: true, liveness: 'stalled', presetVerb: '博大精深', context }))
      .toEqual({ primary: '仍在等待后端响应' })
  })

  it('未知工具结束事件不改变活动快照，避免无意义的渲染抖动', () => {
    const state = reduceGenerationActivity(
      reduceGenerationActivity(undefined, { type: 'start', at: 0 }),
      { type: 'tool-start', id: 'read-1', name: 'Read', at: 10 },
    )
    expect(reduceGenerationActivity(state, { type: 'tool-end', id: 'missing', at: 20 })).toBe(state)
  })
})
