import { describe, expect, it } from 'vitest'
import { isInteractionActivity, resolveActivity } from '../activity.ts'

describe('Activity tool / interaction 分类', () => {
  it('将 Hermes clarify 工具分流为 interaction', () => {
    expect(resolveActivity({ name: 'clarify' })).toEqual({
      surface: 'interaction',
      interactionKind: 'clarify',
      rawName: 'clarify',
      matchedBy: 'interaction-name',
    })
  })

  it('将 Peri AskUserQuestion 分流为多问题交互', () => {
    expect(resolveActivity({ name: 'AskUserQuestion' })).toMatchObject({
      surface: 'interaction',
      interactionKind: 'ask-question',
      matchedBy: 'interaction-name',
    })
  })

  it('独立 approval.request wire event 优先于工具名', () => {
    expect(resolveActivity({ name: 'execute_code', eventType: 'approval.request' })).toMatchObject({
      surface: 'interaction',
      interactionKind: 'approval',
      matchedBy: 'wire-event',
    })
  })

  it('显式 oauth event 进入 interaction', () => {
    expect(isInteractionActivity({ eventType: 'oauth-needed' })).toBe(true)
    expect(resolveActivity({ eventType: 'oauth-needed' })).toMatchObject({ interactionKind: 'oauth' })
  })

  it('普通工具和未知事件保持 tool fallback', () => {
    expect(resolveActivity({ name: 'terminal' })).toMatchObject({ surface: 'tool', interactionKind: null })
    expect(resolveActivity({ name: 'vendor_tool', eventType: 'vendor.unknown' })).toMatchObject({
      surface: 'tool',
      interactionKind: null,
      matchedBy: 'fallback',
    })
  })

  it('明确 surface 时保留未知 interaction kind，不静默改成 tool', () => {
    expect(resolveActivity({ name: 'vendor_prompt', surface: 'interaction' })).toMatchObject({
      surface: 'interaction',
      interactionKind: 'unknown',
      matchedBy: 'wire-event',
    })
  })
})
