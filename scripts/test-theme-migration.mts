import assert from 'node:assert/strict'
import { normalizeThemeMigrationState } from '../src/domains/theme/migration.ts'
import { DEFAULT_CC_LAYOUT } from '../src/ccLayoutState.ts'

const defaults = {
  transparency: 0.85,
  ccLayout: DEFAULT_CC_LAYOUT,
  appliedPreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
  custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
} as const

const migrated = normalizeThemeMigrationState({
  transparency: 0.5,
  ccSizes: { stale: true },
  // 旧模型输入：activePreset/dirty 键 + 'custom' 值（基准丢失）+ 非法值 + 越界 zone 键
  activePreset: { global: 'custom', sidebar: 42, unknown: 'leak' },
  dirty: { global: true, chat: 'yes' },
  ccPositions: { ekg: { x: 12, y: 18, w: 999 }, bogus: { x: 1, y: 2 } },
  ccCliCustomized: true,
  ccLayoutVersion: 2,
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
assert.equal('ccPositions' in migrated, false, '迁移结果不得保留 ccPositions')
assert.equal('ccCliCustomized' in migrated, false, '迁移结果不得保留 ccCliCustomized')
assert.equal('ccLayoutVersion' in migrated, false, '迁移结果不得保留 ccLayoutVersion')
// A1 映射：旧 activePreset.global='custom' → appliedPreset.global='' + custom.global=true
assert.deepEqual(migrated.appliedPreset, { ...defaults.appliedPreset, global: '' })
assert.deepEqual(migrated.custom, { ...defaults.custom, global: true })
assert.equal(migrated.appliedPreset.sidebar, '', 'sidebar:42 非法值回退默认')
assert.equal('unknown' in migrated.appliedPreset, false, '越界 zone 键被 PRESET_ZONES 白名单丢弃')
assert.equal(typeof migrated.appliedPreset.global, 'string')
assert.equal(typeof migrated.custom.global, 'boolean')
assert.deepEqual(migrated.ccLayout, DEFAULT_CC_LAYOUT)
// A1 命名空间：非 custom- 前缀 id 重前缀
assert.deepEqual(migrated.customPresets, [
  { id: 'custom-ok', name: 'Valid', theme: { transparency: 0.7 }, createdAt: 10, updatedAt: 11 },
])
assert.deepEqual(migrated.sessions, [{ id: 'must remain outside theme conclusion' }])

const empty = normalizeThemeMigrationState({}, defaults)
assert.deepEqual(empty.appliedPreset, defaults.appliedPreset)
assert.deepEqual(empty.custom, defaults.custom)
assert.deepEqual(empty.customPresets, [])
assert.equal('ccPositions' in empty, false, '空状态不得出现 ccPositions')
assert.deepEqual(empty.ccLayout, DEFAULT_CC_LAYOUT)

console.log('theme migration 回归测试通过（A1 模型：旧键映射 + custom 值 + id 命名空间）')
