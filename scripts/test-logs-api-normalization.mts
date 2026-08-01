import assert from 'node:assert/strict'
import { normalizeRuntimeLogs } from '../src/components/right-panel/logsApi.ts'

assert.deepEqual(normalizeRuntimeLogs([
  { id: 1, timestamp: '2026-07-30T00:00:00Z', level: 'warn', source: 'runtime', message: 'warning' },
  { id: '2', timestamp: 'now', level: 'unknown', source: 'session', message: 'safe fallback' },
  { id: 3, timestamp: 'bad', source: 'runtime' },
  null,
]), [
  { id: '1', time: '2026-07-30T00:00:00Z', level: 'warn', source: 'runtime', message: 'warning' },
  { id: '2', time: 'now', level: 'info', source: 'session', message: 'safe fallback' },
])
assert.deepEqual(normalizeRuntimeLogs({}), [])

console.log('RuntimeLogHub adapter normalization: PASS')
