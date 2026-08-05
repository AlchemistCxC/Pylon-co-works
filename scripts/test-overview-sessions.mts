import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizePersistedSessions, recentPersistedSessions } from '../src/domains/overview/persistedSessions.ts'

// W1-06：最近会话恢复——宽容 normalize + updatedAt 倒序取 5 + 不直接 load（listener 就绪）

// 1. normalize 宽容：非数组 → []；未知项/缺 id 跳过不崩；updatedAt 数字/字符串/缺失稳定
assert.deepEqual(normalizePersistedSessions(null), [])
assert.deepEqual(normalizePersistedSessions('x'), [])
assert.deepEqual(normalizePersistedSessions([null, 'str', { title: 'no-id' }]), [])
{
  const entries = normalizePersistedSessions([
    { id: 'a', title: 'A', updatedAt: 300 },
    { id: 'b', source: 'local:b', updatedAt: '500' },
    { id: 'c', updatedAt: '2026-08-01T00:00:00Z' },
    { id: 'd', updatedAt: undefined },
    { id: 'e', updatedAt: 'not-a-date' },
    { id: 'f' },
  ])
  assert.equal(entries.length, 6)
  assert.equal(entries[0]?.updatedAt, 300)
  assert.equal(entries[1]?.updatedAt, 500, '字符串数字必须解析')
  assert.ok(entries[2]?.updatedAt > 0, 'ISO 日期必须解析')
  assert.equal(entries[3]?.updatedAt, 0, 'undefined 时间戳 fallback 0')
  assert.equal(entries[4]?.updatedAt, 0, '非法字符串 fallback 0')
  assert.equal(entries[5]?.updatedAt, 0)
}

// 2. 倒序取 5：按 updatedAt 倒序、截取 limit；缺失时间戳排最后
{
  const raw = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, updatedAt: i * 10 }))
  const recent = recentPersistedSessions(raw)
  assert.equal(recent.length, 5)
  assert.deepEqual(recent.map(r => r.id), ['s7', 's6', 's5', 's4', 's3'])
  assert.equal(recentPersistedSessions([]).length, 0)
  // 缺 updatedAt 的排最后（不 NaN）
  const mixed = recentPersistedSessions([
    { id: 'old', updatedAt: 1 },
    { id: 'no-time' },
    { id: 'new', updatedAt: 2 },
  ])
  assert.deepEqual(mixed.map(r => r.id), ['new', 'old', 'no-time'])
  assert.ok(mixed.every(r => Number.isFinite(r.updatedAt)), '排序不得产生 NaN')
}

// 3. Overview 接线：list_persisted_sessions → recentPersistedSessions；不直接 load
const overview = readFileSync(new URL('../src/sheets/OverviewSheetView.tsx', import.meta.url), 'utf8')
assert.match(overview, /invoke\('list_persisted_sessions'\)/, '必须调 list_persisted_sessions')
assert.match(overview, /recentPersistedSessions\(raw\)/, '必须经纯函数取最近')
assert.equal(overview.includes("invoke('load_persisted_session'"), false, 'overview 不得直接 load（由 ChatView 挂载后 lifecycle 承担，listener 就绪）')
assert.match(overview, /ctx\.selectSession\(id\)/, '恢复必须 selectSession')
assert.match(overview, /ctx\.openSheet\(\{ kind: 'agent'/, '恢复必须 open agent sheet')
assert.match(overview, /updateSession\(created\.id, \{/, '创建 row 必须纠正 source/periId')
assert.match(overview, /recent\.length === 0/, '无最近会话显示空态')

console.log('overview sessions 守卫通过')
