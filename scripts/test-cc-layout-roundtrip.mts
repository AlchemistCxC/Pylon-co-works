import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  CC_LAYOUT_SCHEMA_VERSION,
  DEFAULT_CC_LAYOUT,
  normalizeCcLayout,
  updateCcPlacementState,
} from '../src/ccLayoutState.ts'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const store = source('../src/store.ts')
const controlCenter = source('../src/components/ControlCenter.tsx')
const presets = source('../src/themeFieldDefs.ts')

// Missing persisted layout falls back to the current placement schema.
const legacy = normalizeCcLayout(undefined)
assert.equal(legacy.version, CC_LAYOUT_SCHEMA_VERSION)
assert.equal(legacy.version, 6)
assert.deepEqual(legacy.placements, DEFAULT_CC_LAYOUT.placements)
assert.equal('x' in (legacy.placements.input as object), false)
assert.equal('y' in (legacy.placements.input as object), false)

const staleV2 = normalizeCcLayout({
  version: 2 as 3,
  placements: { model: { slot: 'actions', order: 7, offsetX: 9, offsetY: 4 } },
})
assert.deepEqual(staleV2, DEFAULT_CC_LAYOUT, '旧版布局不得把非 v3 placement 当作当前真值')

// Action round-trip: update -> persist-shaped JSON round-trip -> normalize.
const moved = updateCcPlacementState(DEFAULT_CC_LAYOUT, 'model', {
  slot: 'status-primary',
  order: 9,
  offsetX: 100,
  offsetY: -100,
})
assert.deepEqual(moved.placements.model, {
  slot: 'status-primary',
  order: 9,
  offsetX: 48,
  offsetY: -16,
})
const roundTripped = normalizeCcLayout(JSON.parse(JSON.stringify(moved)))
assert.deepEqual(roundTripped, moved)
assert.notEqual(roundTripped, moved)
assert.equal(updateCcPlacementState(DEFAULT_CC_LAYOUT, 'unknown', { order: 1 }), DEFAULT_CC_LAYOUT)

// Store actions must all read/write the same ccLayout placement source of truth.
assert.match(store, /updateCcPlacement:\s*\(id, partial\) =>[\s\S]*?ccLayout:\s*updateCcPlacementState\(state\.ccLayout, id, partial\)/)
assert.match(store, /resetCcLayout:\s*\(\) => set\(state => \(\{[\s\S]*?ccLayout:\s*cloneCcLayout\(DEFAULT_CC_LAYOUT\)/)
assert.match(store, /setGlobalPreset:[\s\S]*?ccLayout:\s*normalizeCcLayout\(theme\.ccLayout\)/)
assert.match(store, /applyCustomPreset:[\s\S]*?ccLayout:\s*normalizeCcLayout\(theme\.ccLayout\)/)
assert.equal(controlCenter.includes('const layout = useStore(s => s.ccLayout)'), true)
assert.equal(controlCenter.includes('useStore.getState().ccLayout'), true)
assert.equal(controlCenter.includes('updateCcPlacement(id, {'), true)

// Every preset must remain valid against the declared ThemeSettings schema and carry
// ccLayout only as the canonical v3 field when it is present.
assert.match(presets, /\bccLayout\b/)
assert.equal(presets.includes("'ccPositions'"), false)
assert.equal(presets.includes("'ccCliCustomized'"), false)
assert.equal(presets.includes("'ccLayoutVersion'"), false)
assert.match(presets, /\bccLayout\b[\s\S]*?\bccHidden\b[\s\S]*?\bccScale\b/)
assert.equal(presets.includes("'responsiveLayout'"), false)

console.log('ccLayout action round-trip 回归测试通过')
