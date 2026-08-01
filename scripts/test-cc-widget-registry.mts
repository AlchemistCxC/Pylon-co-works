import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { DEFAULT_CC_LAYOUT, normalizeCcLayout } from '../src/ccLayoutState.ts'

const registry = readFileSync(new URL('../src/components/cc/widgetRegistry.tsx', import.meta.url), 'utf8')
const controlCenter = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')

for (const id of ['input', 'ekg', 'pct', 'tokens', 'model', 'mode', 'send', 'attach']) {
  assert.match(registry, new RegExp(`id: '${id}'`), `${id} 必须注册`)
  assert.ok(DEFAULT_CC_LAYOUT.placements[id as keyof typeof DEFAULT_CC_LAYOUT.placements], `${id} 必须有默认布局`)
}
assert.match(registry, /category: 'input'/)
assert.match(registry, /category: 'context'/)
assert.match(registry, /category: 'runtime'/)
assert.match(registry, /category: 'action'/)
assert.match(registry, /id: 'input'[\s\S]*?naturalSize: false/, 'input 不应使用自然尺寸')
assert.match(registry, /id: 'tokens'[\s\S]*?naturalSize: true/, 'tokens 应使用自然尺寸')
assert.match(registry, /ccStyle === 'ring'/, 'ring 必须是用量条的一个渲染类型')
assert.match(registry, /cc-context-ring/, 'ring 类型必须复用环形视觉')
assert.equal(registry.includes("id: 'context-ring'"), false, '不得保留独立 context-ring 控件')
assert.equal(registry.includes("id: 'runtime-status'"), false, '不得保留常态 runtime-status 控件')
assert.match(registry, /defaultPlacement: placement\('status-primary', 0\)/, 'registry 必须声明默认位置')
assert.match(registry, /renderPreview\?:/, 'registry 必须预留 Preview renderer')

const normalized = normalizeCcLayout({ version: 3, placements: {
  input: { slot: 'input', order: 0, offsetX: 6, offsetY: -3 },
  tokens: { slot: 'status-secondary', order: 4, offsetX: -8, offsetY: 5 },
} })
assert.deepEqual(normalized.placements.input, { slot: 'input', order: 0, offsetX: 6, offsetY: -3 })
assert.deepEqual(normalized.placements.tokens, { slot: 'status-secondary', order: 4, offsetX: -8, offsetY: 5 })
assert.deepEqual(normalized.placements['context-ring'], DEFAULT_CC_LAYOUT.placements['context-ring'])
assert.match(controlCenter, /from '\.\/cc\/widgetRegistry'/, 'ControlCenter 必须消费外置 registry')
assert.match(controlCenter, /const isNatural = def\.naturalSize/, '自然尺寸必须由 registry metadata 决定')
assert.match(controlCenter, /body = def\.render\(\{ sessionId \}\)/, 'renderer 必须使用统一 render props')
assert.match(controlCenter, /WIDGET_REGISTRY\s*\.filter/, 'slot 渲染必须来自 registry')
assert.match(controlCenter, /WIDGET_REGISTRY\.map/, 'toolbar 必须来自 registry')

console.log('cc widget registry v2 契约测试通过')
