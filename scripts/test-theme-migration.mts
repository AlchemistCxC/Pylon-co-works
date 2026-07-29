import assert from 'node:assert/strict'
import { normalizeThemeMigrationState } from '../src/themeMigration.ts'
import { DEFAULT_CC_LAYOUT } from '../src/ccLayoutState.ts'

const defaults = {
  transparency: 0.85,
  ccLayoutVersion: 3,
  ccPositions: {
    input: { x: 0, y: 0, w: 100, h: 52 },
    ekg: { x: 0, y: 65 },
    pct: { x: 32, y: 69 },
    tokens: { x: 41, y: 69 },
    model: { x: 58, y: 69 },
    mode: { x: 77, y: 69 },
    send: { x: 89, y: 69 },
    attach: { x: 95, y: 69 },
  },
  ccLayout: DEFAULT_CC_LAYOUT,
  activePreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
  dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
} as const

const migrated = normalizeThemeMigrationState({
  transparency: 0.5,
  ccSizes: { stale: true },
  activePreset: { global: 'glass', sidebar: 42, unknown: 'leak' },
  dirty: { global: true, chat: 'yes' },
  ccPositions: { ekg: { x: 12, y: 18, w: 999 }, bogus: { x: 1, y: 2 } },
  ccLayout: { version: 99, placements: {} },
  customPresets: [
    { id: 'ok', name: ' Valid ', theme: { transparency: 0.7 }, createdAt: 10, updatedAt: 11 },
    null,
    { id: '', name: 'bad', theme: {} },
    { id: 'missing-theme', name: 'bad' },
  ],
  sessions: [{ id: 'must remain outside theme conclusion' }],
}, defaults)

assert.equal(migrated.transparency, 0.5)
assert.equal('ccSizes' in migrated, false)
assert.deepEqual(migrated.activePreset, { ...defaults.activePreset, global: 'glass' })
assert.deepEqual(migrated.dirty, { ...defaults.dirty, global: true })
assert.equal(typeof migrated.activePreset.global, 'string')
assert.equal(typeof migrated.dirty.global, 'boolean')
assert.deepEqual(migrated.ccPositions, {
  ...defaults.ccPositions,
  ekg: { x: 12, y: 18 },
  bogus: { x: 1, y: 2 },
})
assert.deepEqual(migrated.ccLayout, DEFAULT_CC_LAYOUT)
assert.equal(migrated.ccLayoutVersion, 3)
assert.deepEqual(migrated.customPresets, [
  { id: 'ok', name: 'Valid', theme: { transparency: 0.7 }, createdAt: 10, updatedAt: 11 },
])
assert.deepEqual(migrated.sessions, [{ id: 'must remain outside theme conclusion' }])

const empty = normalizeThemeMigrationState({}, defaults)
assert.deepEqual(empty.activePreset, defaults.activePreset)
assert.deepEqual(empty.dirty, defaults.dirty)
assert.deepEqual(empty.customPresets, [])
assert.deepEqual(empty.ccPositions, defaults.ccPositions)
assert.deepEqual(empty.ccLayout, DEFAULT_CC_LAYOUT)

console.log('theme migration 回归测试通过')
