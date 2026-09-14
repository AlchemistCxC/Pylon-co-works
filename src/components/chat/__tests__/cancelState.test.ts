import { describe, expect, it } from 'vitest'
import {
  applyCancelEvent,
  beginCancel,
  rejectCancelCommand,
  type CancelState,
} from '../cancelState.ts'

// 迁移自 scripts/test-cancel-state.mts（P91 A1）：取消状态机近平移。
function state(source: string, status: CancelState['status']): CancelState {
  return { source, status }
}

describe('beginCancel', () => {
  it('空 source 不触发调用', () => {
    const current = state('A', 'idle')
    expect(beginCancel('', current)).toEqual({ state: current, shouldInvoke: false })
  })

  it('同 source idle 不重复进入 canceling', () => {
    const current = state('A', 'idle')
    expect(beginCancel('A', current)).toEqual({ state: current, shouldInvoke: false })
  })

  it('generating 状态进入 canceling 并触发调用', () => {
    const current = state('A', 'generating')
    expect(beginCancel('A', current)).toEqual({
      state: state('A', 'canceling'),
      shouldInvoke: true,
    })
  })

  it('已 canceling 不重复触发', () => {
    const current = state('A', 'canceling')
    expect(beginCancel('A', current)).toEqual({ state: current, shouldInvoke: false })
  })

  it('异 source 不触发', () => {
    const current = state('A', 'generating')
    expect(beginCancel('B', current)).toEqual({ state: current, shouldInvoke: false })
  })
})

describe('applyCancelEvent', () => {
  it('同 source success 收敛为 cancelled，异 source 事件被忽略', () => {
    const current = state('A', 'canceling')
    expect(applyCancelEvent('A', { kind: 'success' }, current)).toEqual(state('A', 'cancelled'))
    expect(applyCancelEvent('B', { kind: 'success' }, current)).toEqual(current)
  })

  it('error 事件回落 generating 并携带错误', () => {
    const current = state('A', 'canceling')
    expect(applyCancelEvent('A', { kind: 'error', error: 'event failed' }, current)).toEqual({
      source: 'A',
      status: 'generating',
      error: 'event failed',
    })
  })

  it('仅 canceling 状态可收敛为 cancelled', () => {
    const current = state('A', 'generating')
    expect(applyCancelEvent('A', { kind: 'success' }, current)).toEqual(current)
  })
})

describe('rejectCancelCommand', () => {
  it('拒绝命令回落 generating 并携带错误', () => {
    const current = state('A', 'canceling')
    expect(rejectCancelCommand('A', current, new Error('cancel failed'))).toEqual({
      source: 'A',
      status: 'generating',
      error: 'cancel failed',
    })
  })
})
