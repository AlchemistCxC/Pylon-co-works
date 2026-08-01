import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  CC_LAYOUT_SCHEMA_VERSION,
  DEFAULT_CC_LAYOUT,
  normalizeCcLayout,
  updateCcPlacementState,
} from '../src/ccLayoutState.ts'

assert.equal(CC_LAYOUT_SCHEMA_VERSION, 6)

const migrated = normalizeCcLayout(undefined)
assert.deepEqual(migrated.placements.input, DEFAULT_CC_LAYOUT.placements.input)
assert.deepEqual(migrated.placements.ekg, DEFAULT_CC_LAYOUT.placements.ekg)
assert.deepEqual(migrated.placements.model, DEFAULT_CC_LAYOUT.placements.model)

const moved = updateCcPlacementState(DEFAULT_CC_LAYOUT, 'model', { offsetX: 100, offsetY: -100 })
assert.deepEqual(moved.placements.model, {
  ...DEFAULT_CC_LAYOUT.placements.model,
  offsetX: 48,
  offsetY: -16,
})
assert.notEqual(moved, DEFAULT_CC_LAYOUT)
assert.notEqual(moved.placements, DEFAULT_CC_LAYOUT.placements)

const reordered = updateCcPlacementState(moved, 'model', { slot: 'status-primary', order: 9 })
assert.equal(reordered.placements.model.slot, 'status-primary')
assert.equal(reordered.placements.model.order, 9)
assert.equal(updateCcPlacementState(DEFAULT_CC_LAYOUT, 'unknown', { order: 1 }), DEFAULT_CC_LAYOUT)

const source = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/ControlCenter.css', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')

assert.equal(source.includes('responsiveLayout'), false, '不得再按 dirty 状态切换布局模型')
assert.equal(source.includes('CLI_OVERRIDES'), false, '不得保留第二套坐标真值')
assert.equal(source.includes('cc-status-primary'), true)
assert.equal(source.includes('cc-status-secondary'), true)
assert.equal(source.includes('cc-actions'), true)
assert.equal(source.includes('data-widget-id={id}'), true)
assert.equal(source.includes('updateCcPlacement(id, {'), true)
assert.match(css, /grid-template-rows:minmax\([^,]+,\s*1fr\) auto/)
assert.equal(css.includes('.cc-status-row'), true)
assert.equal(css.includes('.cc-flow-row'), false)
assert.equal(store.includes('ccLayout: CcLayoutV3'), true)
assert.equal(store.includes('normalizeThemeMigrationState(state,'), true)

console.log('ccLayoutV3 回归测试通过')
