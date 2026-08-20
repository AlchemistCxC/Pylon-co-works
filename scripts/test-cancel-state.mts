import assert from 'node:assert/strict'
import {
  applyCancelEvent,
  beginCancel,
  createCancelState,
  rejectCancelCommand,
  type CancelState,
} from '../src/components/chat/cancelState.ts'

function state(source: string, status: CancelState['status']): CancelState {
  return { source, status }
}

{
  const current = state('A', 'idle')
  const result = beginCancel('', current)
  assert.deepEqual(result, { state: current, shouldInvoke: false })
}

{
  const current = state('A', 'idle')
  const result = beginCancel('A', current)
  assert.deepEqual(result, { state: current, shouldInvoke: false })
}

{
  const current = state('A', 'generating')
  const result = beginCancel('A', current)
  assert.deepEqual(result, {
    state: state('A', 'canceling'),
    shouldInvoke: true,
  })
}

{
  const current = state('A', 'canceling')
  const result = beginCancel('A', current)
  assert.deepEqual(result, { state: current, shouldInvoke: false })
}

{
  const current = state('A', 'generating')
  const result = beginCancel('B', current)
  assert.deepEqual(result, { state: current, shouldInvoke: false })
}

{
  const current = state('A', 'canceling')
  assert.deepEqual(
    applyCancelEvent('A', { kind: 'success' }, current),
    state('A', 'cancelled'),
  )
  assert.deepEqual(
    applyCancelEvent('B', { kind: 'success' }, current),
    current,
    'a cancel event from another source must be ignored',
  )
}

{
  const current = state('A', 'canceling')
  assert.deepEqual(
    rejectCancelCommand('A', current, new Error('cancel failed')),
    { source: 'A', status: 'generating', error: 'cancel failed' },
  )
}

{
  const current = state('A', 'canceling')
  assert.deepEqual(
    applyCancelEvent('A', { kind: 'error', error: 'event failed' }, current),
    { source: 'A', status: 'generating', error: 'event failed' },
  )
}

{
  const current = state('A', 'generating')
  assert.deepEqual(
    applyCancelEvent('A', { kind: 'success' }, current),
    current,
    'only a canceling state may converge to cancelled',
  )
}

console.log('cancel-state regression tests passed')
