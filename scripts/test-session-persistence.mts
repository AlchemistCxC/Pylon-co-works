import { strict as assert } from 'node:assert'
import {
  LEGACY_SESSION_STORAGE_KEY,
  SESSION_SCHEMA_VERSION,
  SESSION_STORAGE_KEY,
  loadSessions,
  parseSessions,
  persistSessions,
} from '../src/sessionPersistence.ts'

const profiles = [{ id: 'custom', name: 'Custom', persona: '', model: '' }]
const legacy = [
  { id: 's1', name: '旧会话', profileId: 'missing', createdAt: 1 },
  { id: 's1', name: '重复会话', source: 'local:duplicate', profileId: 'custom', createdAt: 2 },
  { name: '缺失 ID', profileId: 'custom' },
]

const values = new Map<string, string>([[LEGACY_SESSION_STORAGE_KEY, JSON.stringify(legacy)]])
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
}

const migrated = loadSessions(storage, profiles)
assert.equal(migrated.length, 1, '重复 ID 去重，缺失 ID 不得生成新实体')
assert.equal(migrated[0].id, 's1', '迁移不得改写 Session.id')
assert.equal(migrated[0].source, 'local:s1', '缺失 source 应使用稳定 Session.id')
assert.equal(migrated[0].profileId, 'custom', '应使用 hydrate 后的 Profile 真值')
assert.deepEqual(migrated[0].skills, [])
assert.deepEqual(migrated[0].hooks, [])
assert.equal(values.has(LEGACY_SESSION_STORAGE_KEY), false, '旧 key 应在迁移成功后删除')

const envelope = JSON.parse(values.get(SESSION_STORAGE_KEY) || '{}')
assert.equal(envelope.version, SESSION_SCHEMA_VERSION)
assert.equal(envelope.sessions[0].id, 's1')

persistSessions(storage, migrated)
assert.deepEqual(parseSessions(values.get(SESSION_STORAGE_KEY) || null, profiles), migrated)
assert.deepEqual(parseSessions('[]', profiles), [], '兼容旧数组 schema')
assert.deepEqual(parseSessions('{broken', profiles), [], '损坏 JSON 不得抛出')
assert.deepEqual(parseSessions('{"version":2,"sessions":[]}', profiles), [], '未知未来版本不得误解析')

const fallbackValues = new Map<string, string>([
  [SESSION_STORAGE_KEY, '{broken'],
  [LEGACY_SESSION_STORAGE_KEY, JSON.stringify([{ id: 'legacy', profileId: 'custom' }])],
])
const fallbackStorage = {
  getItem: (key: string) => fallbackValues.get(key) ?? null,
  setItem: (key: string, value: string) => { fallbackValues.set(key, value) },
  removeItem: (key: string) => { fallbackValues.delete(key) },
}
assert.equal(loadSessions(fallbackStorage, profiles)[0].id, 'legacy', '当前 key 损坏时应回退旧 key')

console.log('sessionPersistence 回归测试通过')
