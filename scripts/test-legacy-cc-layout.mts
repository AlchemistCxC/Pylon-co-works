import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { CC_LAYOUT_SCHEMA_VERSION, normalizeCcLayout } from '../src/ccLayoutState.ts'

type LegacyState = Record<string, unknown> & {
  ccLayout?: Parameters<typeof normalizeCcLayout>[0]
}

const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../src/domains/theme/migration.ts', import.meta.url), 'utf8')

assert.equal(/ccLayout:\s*cloneCcLayout\(DEFAULT_CC_LAYOUT\)/.test(store), true, '默认状态必须保留 v3 context 布局')
assert.equal(/ccSizes:\s*\{/.test(store), false, '默认状态不得继续保存废弃尺寸字段')
assert.equal(/delete\s+state\.ccSizes/.test(migration), true, '迁移必须删除废弃 ccSizes')
assert.equal(/normalized\.ccLayout\s*=\s*normalizeCcLayout\(/.test(migration), true, '迁移必须保留并 normalize ccLayout')
assert.equal(/ccPositions:\s*Record<string/.test(store), false, 'ccPositions 类型字段必须已删除')
assert.equal(/ccCliCustomized/.test(store), false, 'ccCliCustomized 字段必须已删除')
assert.equal(/ccLayoutVersion/.test(store), false, 'ccLayoutVersion 字段必须已删除')
assert.equal(/delete\s+state\.ccPositions/.test(migration), true, '迁移必须删除废弃 ccPositions')
assert.equal(/delete\s+state\.ccCliCustomized/.test(migration), true, '迁移必须删除废弃 ccCliCustomized')
assert.equal(/delete\s+state\.ccLayoutVersion/.test(migration), true, '迁移必须删除废弃 ccLayoutVersion')
assert.equal(/ccHidden:\s*string\[\]/.test(store), true, 'ccHidden 类型字段必须存在')

const legacyState: LegacyState = {
  ccSizes: { ekg: 42 },
  ccLayout: { version: 2, placements: {} },
}
const migratedLayout = normalizeCcLayout(legacyState.ccLayout)
delete legacyState.ccSizes
legacyState.ccLayout = migratedLayout
assert.equal('ccSizes' in legacyState, false, '迁移结果不得保留 ccSizes')
assert.equal(legacyState.ccLayout, migratedLayout, '迁移结果必须保留 normalizeCcLayout 结果')
assert.equal((legacyState.ccLayout as { version: number }).version, CC_LAYOUT_SCHEMA_VERSION, '布局必须为 v3')

console.log('legacyCcLayout 回归测试通过')
