import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')

assert.equal(/ccLayout:\s*\[/.test(store), false, '默认状态不得继续保存旧 context 布局')
assert.equal(/ccSizes:\s*\{/.test(store), false, '默认状态不得继续保存废弃尺寸字段')
assert.equal(store.includes("delete (state as Record<string, unknown>).ccLayout"), true)
assert.equal(store.includes("delete (state as Record<string, unknown>).ccSizes"), true)
assert.equal(store.includes('ccPositions: Record<string'), true)
assert.equal(store.includes('ccHidden: string[]'), true)

console.log('legacyCcLayout 回归测试通过')
