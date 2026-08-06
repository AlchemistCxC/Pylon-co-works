import assert from 'node:assert/strict'
import { normalizeRuntimeLogList } from '../src/infrastructure/tauri/runtimeLogContracts.ts'

// W2-12（遗留 7 迁移）：logs 归一化从旧 right-panel/logsApi 迁到 W1-08 的 runtimeLogContracts
const entries = normalizeRuntimeLogList([
  { id: 1, timestamp: '1722500000000', level: 'warn', source: 'runtime', message: 'warning' },
  { id: 2, timestamp: 'bad', level: 'unknown', source: 'session', message: 'safe fallback' },
  { id: 3, source: 'runtime' },
  null,
])
assert.equal(entries.length, 2)
assert.equal(entries[0]?.id, 1)
assert.equal(entries[0]?.level, 'warn')
assert.equal(entries[1]?.level, 'info', '非法 level 归 info')
assert.deepEqual(normalizeRuntimeLogList({}), [])
assert.deepEqual(normalizeRuntimeLogList('not-array'), [])

console.log('runtime log contracts normalization: PASS')
