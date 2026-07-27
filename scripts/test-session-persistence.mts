import { strict as assert } from 'node:assert'
import {
  LEGACY_SESSION_STORAGE_KEY,
  SESSION_SCHEMA_VERSION,
  SESSION_STORAGE_KEY,
  loadSessions,
  parseSessions,
  persistSessions,
} from '../src/sessionPersistence.ts'

const profiles = [{ id: 'riccati', name: 'Riccati', persona: '', model: '' }]
const legacy = [{ id: 's1', name: '旧会话', source: 'local:old', profileId: 'missing', createdAt: 1 }]

const values = new Map<string, string>([[LEGACY_SESSION_STORAGE_KEY, JSON.stringify(legacy)]])
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
}

const migrated = loadSessions(storage, profiles)
assert.equal(migrated.length, 1)
assert.equal(migrated[0].profileId, 'riccati', '悬空 profileId 应迁移到有效 Profile')
assert.deepEqual(migrated[0].skills, [])
assert.deepEqual(migrated[0].hooks, [])
assert.equal(values.has(LEGACY_SESSION_STORAGE_KEY), false, '旧 key 应在迁移后删除')

const envelope = JSON.parse(values.get(SESSION_STORAGE_KEY) || '{}')
assert.equal(envelope.version, SESSION_SCHEMA_VERSION)
assert.equal(envelope.sessions[0].id, 's1')

persistSessions(storage, migrated)
assert.deepEqual(parseSessions(values.get(SESSION_STORAGE_KEY) || null, profiles), migrated)
assert.deepEqual(parseSessions('[]', profiles), [], '兼容旧数组 schema')

console.log('sessionPersistence 回归测试通过')
