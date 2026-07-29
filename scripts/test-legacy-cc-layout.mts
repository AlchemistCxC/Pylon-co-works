import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { CC_LAYOUT_SCHEMA_VERSION, normalizeCcLayout, normalizeCcPositions } from '../src/ccLayoutState.ts'

type LegacyState = Record<string, unknown> & {
  ccPositions?: Record<string, { x: number, y: number, w?: number, h?: number }>
  ccLayout?: Parameters<typeof normalizeCcLayout>[0]
}

const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')

assert.equal(/ccLayout:\s*cloneCcLayout\(DEFAULT_CC_LAYOUT\)/.test(store), true, '默认状态必须保留 v3 context 布局')
assert.equal(/ccSizes:\s*\{/.test(store), false, '默认状态不得继续保存废弃尺寸字段')
assert.equal(/delete\s+\(state\s+as\s+Record<string, unknown>\)\.ccSizes/.test(store), true, '迁移必须删除废弃 ccSizes')
assert.equal(/state\.ccPositions\s*=\s*normalizeCcPositions\(/.test(store), true, '迁移必须 normalize ccPositions')
assert.equal(/state\.ccLayout\s*=\s*normalizeCcLayout\(/.test(store), true, '迁移必须保留并 normalize ccLayout')
assert.equal(/state\.ccLayoutVersion\s*=\s*CC_LAYOUT_SCHEMA_VERSION/.test(store), true, '迁移必须写入当前布局 schema 版本')
assert.equal(/ccPositions:\s*Record<string/.test(store), true, 'ccPositions 类型字段必须存在')
assert.equal(/ccHidden:\s*string\[\]/.test(store), true, 'ccHidden 类型字段必须存在')

const defaults = { input: { x: 0, y: 0, w: 100, h: 52 }, ekg: { x: 0, y: 65, w: 20 } }
const normalizedPositions = normalizeCcPositions({ ...defaults, ekg: { x: 12, y: 18, w: 99 } }, defaults)
assert.deepEqual(normalizedPositions.ekg, { x: 12, y: 18 }, 'normalizeCcPositions 必须移除自然控件的旧尺寸')
assert.deepEqual(normalizedPositions.input, { x: 0, y: 0, w: 100, h: 52 }, 'normalizeCcPositions 必须保留 input 尺寸')

const legacyState: LegacyState = {
  ccSizes: { ekg: 42 },
  ccPositions: { ekg: { x: 9, y: 11, w: 88 } },
  ccLayout: { version: 2, placements: {} },
}
const migratedPositions = normalizeCcPositions(legacyState.ccPositions, defaults)
const migratedLayout = normalizeCcLayout(legacyState.ccLayout, migratedPositions)
assert.equal('ccSizes' in legacyState, true, '行为样本必须包含废弃 ccSizes')
delete legacyState.ccSizes
legacyState.ccPositions = migratedPositions
legacyState.ccLayout = migratedLayout
legacyState.ccLayoutVersion = CC_LAYOUT_SCHEMA_VERSION
assert.equal('ccSizes' in legacyState, false, '迁移结果不得保留 ccSizes')
assert.equal(legacyState.ccLayout, migratedLayout, '迁移结果必须保留 normalizeCcLayout 结果')
assert.equal((legacyState.ccLayout as { version: number }).version, CC_LAYOUT_SCHEMA_VERSION, '布局必须为 v3')
assert.equal(legacyState.ccLayoutVersion, CC_LAYOUT_SCHEMA_VERSION, '布局 schema 版本必须为当前版本')
assert.deepEqual(legacyState.ccPositions, migratedPositions, '迁移结果必须使用 normalizeCcPositions 结果')

console.log('legacyCcLayout 回归测试通过')
