// 迁移自 scripts/test-logs-model.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import {
  createLogsViewState,
  transitionLogsView,
  type LogEntry,
  type LogsScope,
  type LogsViewState,
} from '../rightPanelTypes.ts'

const scope: LogsScope = { sessionId: 'session-1', source: 'agent' }
const otherScope: LogsScope = { sessionId: 'session-2', source: 'system' }
const entry: LogEntry = {
  id: 'log-1',
  time: '2026-07-29T12:00:00Z',
  level: 'info',
  source: 'agent',
  message: 'started',
}

const step = (state: LogsViewState, event: Parameters<typeof transitionLogsView>[1]) =>
  transitionLogsView(state, event)

describe('logs 视图状态机（迁移自 scripts/test-logs-model.mts，P91 A1）', () => {
  it('无会话：任何事件都停在 no-session', () => {
    const state = createLogsViewState(null)
    expect(state).toEqual({ status: 'no-session' })
    expect(step(state, { type: 'begin-loading' })).toEqual({ status: 'no-session' })
    expect(step(state, { type: 'loaded', entries: [entry] })).toEqual({ status: 'no-session' })
  })

  it('unwired → loading → empty → ready → error 全链路；set-scope 回 unwired；clear-session 回 no-session', () => {
    let state = createLogsViewState(scope)
    expect(state).toEqual({ status: 'unwired', scope })
    state = step(state, { type: 'begin-loading' })
    expect(state).toEqual({ status: 'loading', scope })
    state = step(state, { type: 'loaded', entries: [] })
    expect(state).toEqual({ status: 'empty', scope, view: { entries: [] } })
    state = step(state, { type: 'begin-loading' })
    expect(state).toEqual({ status: 'loading', scope, view: { entries: [] } })
    state = step(state, { type: 'loaded', entries: [entry] })
    expect(state).toEqual({ status: 'ready', scope, view: { entries: [entry] } })
    state = step(state, { type: 'begin-loading' })
    state = step(state, { type: 'failed', message: 'stream unavailable' })
    expect(state).toEqual({ status: 'error', scope, message: 'stream unavailable', view: { entries: [entry] } })
    state = step(state, { type: 'set-scope', scope: otherScope })
    expect(state).toEqual({ status: 'unwired', scope: otherScope })
    state = step(state, { type: 'clear-session' })
    expect(state).toEqual({ status: 'no-session' })
  })
})
