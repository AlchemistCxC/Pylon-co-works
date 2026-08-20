import { strict as assert } from 'node:assert'
import {
  createLogsViewState,
  transitionLogsView,
  type LogEntry,
  type LogsScope,
  type LogsViewState,
} from '../src/components/right-panel/rightPanelTypes.ts'

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

let state = createLogsViewState(null)
assert.deepEqual(state, { status: 'no-session' })
assert.deepEqual(step(state, { type: 'begin-loading' }), { status: 'no-session' })
assert.deepEqual(step(state, { type: 'loaded', entries: [entry] }), { status: 'no-session' })

state = createLogsViewState(scope)
assert.deepEqual(state, { status: 'unwired', scope })
state = step(state, { type: 'begin-loading' })
assert.deepEqual(state, { status: 'loading', scope })
state = step(state, { type: 'loaded', entries: [] })
assert.deepEqual(state, { status: 'empty', scope, view: { entries: [] } })
state = step(state, { type: 'begin-loading' })
assert.deepEqual(state, { status: 'loading', scope, view: { entries: [] } })
state = step(state, { type: 'loaded', entries: [entry] })
assert.deepEqual(state, { status: 'ready', scope, view: { entries: [entry] } })
state = step(state, { type: 'begin-loading' })
state = step(state, { type: 'failed', message: 'stream unavailable' })
assert.deepEqual(state, { status: 'error', scope, message: 'stream unavailable', view: { entries: [entry] } })
state = step(state, { type: 'set-scope', scope: otherScope })
assert.deepEqual(state, { status: 'unwired', scope: otherScope })
state = step(state, { type: 'clear-session' })
assert.deepEqual(state, { status: 'no-session' })

console.log('Logs model regression: PASS')
