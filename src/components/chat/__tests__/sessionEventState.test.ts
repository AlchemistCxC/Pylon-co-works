// 迁移自 scripts/test-session-event-state.mts（P91 A1）。
// source 隔离契约：后台 source 持续接收事件且互不污染、生成态按 source 去重隔离、
// known/rendered 判定。逐断言平移。
import { describe, expect, it } from 'vitest'
import {
  addGeneratingSource,
  isKnownSource,
  isRenderedSource,
  removeGeneratingSource,
  updateSourceState,
} from '../sessionEventState.ts'

describe('sessionEventState source 隔离（原 test-session-event-state.mts）', () => {
  it('后台 source 应继续接收事件，且不得污染当前 source', () => {
    const messages: Record<string, string[]> = {
      'local:a': ['A-1'],
      'local:b': ['B-1'],
    }
    updateSourceState(messages, 'local:a', current => [...current, 'A-2'])
    expect(messages['local:a']).toEqual(['A-1', 'A-2'])
    expect(messages['local:b']).toEqual(['B-1'])
  })

  it('生成状态应按 source 去重隔离；done/error 只结束对应 source', () => {
    let generating = addGeneratingSource([], 'local:a')
    generating = addGeneratingSource(generating, 'local:b')
    generating = addGeneratingSource(generating, 'local:a')
    expect(generating).toEqual(['local:a', 'local:b'])
    generating = removeGeneratingSource(generating, 'local:a')
    expect(generating).toEqual(['local:b'])
  })

  it('isKnownSource / isRenderedSource 判定', () => {
    expect(isKnownSource('local:a', ['local:a', 'local:b'])).toBe(true)
    expect(isKnownSource('local:deleted', ['local:a', 'local:b'])).toBe(false)
    expect(isRenderedSource('local:b', 'local:b')).toBe(true)
    expect(isRenderedSource('local:a', 'local:b')).toBe(false)
  })
})
