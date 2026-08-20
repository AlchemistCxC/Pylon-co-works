import { strict as assert } from 'node:assert'
import {
  LEGACY_SESSION_STORAGE_KEY,
  SESSION_SCHEMA_VERSION,
  SESSION_STORAGE_KEY,
  loadSessions,
  parseSessions,
  persistSessions,
  type OwnerHints,
} from '../src/sessionPersistence.ts'
import type { Session } from '../src/identityStore.ts'

const profiles = [{ id: 'custom', name: 'Custom', persona: '', model: '' }]
const legacy = [
  { id: 's1', name: '旧会话', profileId: 'missing', createdAt: 1 },
  { id: 's1', name: '重复会话', source: 'local:duplicate', profileId: 'custom', createdAt: 2 },
  { name: '缺失 ID', profileId: 'custom' },
]

function makeStorage(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

// 唯一 Agent 引用 s1 → 归属可推断（ISSUE-01 Tier 2：sheet 显式 sessionId）
const PERI_HINT: OwnerHints = { activeSessionByAgent: { peri: 's1' } }

// —— A1：owner 可唯一确定 → ready，迁移写回 v2 并删除旧 key ——
{
  const values = new Map<string, string>([[LEGACY_SESSION_STORAGE_KEY, JSON.stringify(legacy)]])
  const storage = makeStorage(values)

  const migrated = loadSessions(storage, profiles, PERI_HINT)
  assert.equal(migrated.kind, 'ready', '唯一 Agent 引用 sessionId 时应可解析')
  if (migrated.kind === 'ready') {
    assert.equal(migrated.sessions.length, 1, '重复 ID 去重，缺失 ID 不得生成新实体')
    assert.equal(migrated.sessions[0].id, 's1', '迁移不得改写 Session.id')
    assert.equal(migrated.sessions[0].source, 'local:s1', '缺失 source 应使用稳定 Session.id')
    assert.equal(migrated.sessions[0].profileId, 'custom', '应使用 hydrate 后的 Profile 真值')
    assert.deepEqual(migrated.sessions[0].skills, [])
    assert.deepEqual(migrated.sessions[0].hooks, [])
    assert.equal(migrated.sessions[0].agentId, 'peri', 'owner 推断应落到引用的 Agent')
  }
  assert.equal(values.has(LEGACY_SESSION_STORAGE_KEY), false, '旧 key 应在迁移成功后删除')
  const envelope = JSON.parse(values.get(SESSION_STORAGE_KEY) || '{}')
  assert.equal(envelope.version, SESSION_SCHEMA_VERSION)
  assert.equal(envelope.sessions[0].id, 's1')
  assert.equal(envelope.sessions[0].agentId, 'peri')
}

// —— A2：owner 无法唯一确定 → needs-owner-resolution，不写回、不删旧 key ——
{
  const values = new Map<string, string>([[LEGACY_SESSION_STORAGE_KEY, JSON.stringify(legacy)]])
  const storage = makeStorage(values)

  const result = loadSessions(storage, profiles)
  assert.equal(result.kind, 'needs-owner-resolution', '无 owner hints 时不得静默归属')
  if (result.kind === 'needs-owner-resolution') {
    assert.equal(result.sessions.length, 0, '未解析会话不得进入 sessions')
    assert.equal(result.unresolved.length, 1, '重复 ID 去重，缺失 ID 不得生成新实体')
    assert.equal(result.unresolved[0].id, 's1', '迁移不得改写 Session.id')
  }
  assert.equal(values.has(LEGACY_SESSION_STORAGE_KEY), true, 'unresolved 不删除旧 key（保留现场）')
  assert.equal(values.has(SESSION_STORAGE_KEY), false, 'unresolved 不写回新 key')
}

// —— B：persistSessions roundtrip 与 parseSessions 边界 ——
{
  const values = new Map<string, string>()
  const storage = makeStorage(values)
  const ready: Session = {
    id: 's1', agentId: 'peri', name: '会话一', source: 'local:s1', profileId: 'custom', createdAt: 1,
    lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
    metadata: {}, context: {},
  }

  persistSessions(storage, [ready])
  const roundtrip = parseSessions(values.get(SESSION_STORAGE_KEY) || null, profiles)
  assert.equal(roundtrip.kind, 'ready', 'v2 roundtrip 应为 ready')
  if (roundtrip.kind === 'ready') assert.deepEqual(roundtrip.sessions, [ready])

  assert.deepEqual(parseSessions('[]', profiles), { kind: 'ready', sessions: [] }, '兼容旧数组 schema')

  const broken = parseSessions('{broken', profiles)
  assert.equal(broken.kind, 'corrupt', '损坏 JSON 不得抛出')

  const future = parseSessions('{"version":3,"sessions":[]}', profiles)
  assert.equal(future.kind, 'corrupt', '未知未来版本不得误解析')
}

// —— C：当前 key 损坏 → 回退旧 key ——
{
  const fallbackValues = new Map<string, string>([
    [SESSION_STORAGE_KEY, '{broken'],
    [LEGACY_SESSION_STORAGE_KEY, JSON.stringify([{ id: 'legacy', profileId: 'custom' }])],
  ])
  const fallbackStorage = makeStorage(fallbackValues)
  const fallback = loadSessions(fallbackStorage, profiles, { activeSessionByAgent: { peri: 'legacy' } })
  assert.equal(fallback.kind, 'ready', '当前 key 损坏时应回退旧 key')
  if (fallback.kind === 'ready') assert.equal(fallback.sessions[0].id, 'legacy')
  assert.equal(fallbackValues.has(LEGACY_SESSION_STORAGE_KEY), false, '回退迁移后删除旧 key')
}

console.log('sessionPersistence 回归测试通过')
