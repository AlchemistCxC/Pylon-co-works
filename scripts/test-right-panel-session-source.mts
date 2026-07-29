import assert from 'node:assert/strict'
import { resolveSessionSource } from '../src/components/right-panel/rightPanelTypes.ts'

const sessions = [
  { id: 'local-a', source: 'backend-a' },
  { id: 'local-b', source: 'backend-b' },
]

assert.equal(resolveSessionSource(null, sessions), null)
assert.equal(resolveSessionSource('missing', sessions), null)
assert.equal(resolveSessionSource('local-a', sessions), 'backend-a')
assert.equal(resolveSessionSource('local-b', sessions), 'backend-b')

console.log('RightPanel Session.id → Session.source: PASS')
