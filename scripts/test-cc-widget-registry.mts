/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { DEFAULT_CC_LAYOUT, normalizeCcLayout } from '../src/ccLayoutState.ts'
import { BUILTIN_CC_WIDGET_CONTRIBUTIONS, CC_WIDGET_IDS } from '../src/domains/cc/widgetCatalog.ts'

const registry = readFileSync(new URL('../src/components/cc/widgetRegistry.tsx', import.meta.url), 'utf8')
const catalog = readFileSync(new URL('../src/domains/cc/widgetCatalog.ts', import.meta.url), 'utf8')
const controlCenter = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')

// 守门：registry 注册的 id 集合必须精确等于 CC_WIDGET_IDS 单一真值
// （新增 widget 到 domain 漏注册、或 registry 多余 id 均红）
const catalogIds = BUILTIN_CC_WIDGET_CONTRIBUTIONS.map(item => item.id).sort()
const sourceCatalogIds = [...catalog.matchAll(/id: '([a-z-]+)'/g)].map(m => m[1]).sort()
assert.deepEqual(sourceCatalogIds, catalogIds, 'catalog 源码 ID 集合必须完整')
assert.match(registry, /BUILTIN_CC_WIDGET_CONTRIBUTIONS\.map/, 'registry 必须由 catalog 派生')
assert.match(registry, /id: entry\.id/, 'registry 必须透传 catalog id')
assert.deepEqual([...CC_WIDGET_IDS].sort(), catalogIds, 'CC_WIDGET_IDS 必须来自 catalog')

for (const id of CC_WIDGET_IDS) {
  assert.ok(catalogIds.includes(id), `${id} 必须注册`)
  assert.ok(DEFAULT_CC_LAYOUT.placements[id as keyof typeof DEFAULT_CC_LAYOUT.placements], `${id} 必须有默认布局`)
}
for (const category of ['input', 'context', 'runtime', 'action'] as const) {
  assert.match(catalog, new RegExp(`category: '${category}'`), `${category} category 必须存在`)
}
assert.match(catalog, /id: 'input'[\s\S]*?naturalSize: false/, 'input 不应使用自然尺寸')
assert.match(catalog, /id: 'tokens'[\s\S]*?naturalSize: true/, 'tokens 应使用自然尺寸')
assert.match(registry, /ccStyle === 'ring'/, 'ring 必须是用量条的一个渲染类型')
assert.match(registry, /cc-context-ring/, 'ring 类型必须复用环形视觉')
assert.equal(registry.includes("id: 'context-ring'"), false, '不得保留独立 context-ring 控件')
assert.equal(registry.includes("id: 'runtime-status'"), false, '不得保留常态 runtime-status 控件')
assert.equal(registry.includes('defaultPlacement'), false, 'registry 不应包含 defaultPlacement')
assert.equal(registry.includes('renderPreview'), false, 'registry 不应包含 renderPreview')

const normalized = normalizeCcLayout({ version: 3, placements: {
  input: { slot: 'input', order: 0, offsetX: 6, offsetY: -3 },
  tokens: { slot: 'status-secondary', order: 4, offsetX: -8, offsetY: 5 },
} })
assert.deepEqual(normalized.placements.input, { slot: 'input', order: 0, offsetX: 6, offsetY: -3 })
assert.deepEqual(normalized.placements.tokens, { slot: 'status-secondary', order: 4, offsetX: -8, offsetY: 5 })
assert.equal('context-ring' in normalized.placements, false, '废弃 context-ring 必须被归一化丢弃')
assert.match(controlCenter, /from '\.\/cc\/widgetRegistry'/, 'ControlCenter 必须消费外置 registry')
assert.match(controlCenter, /const isNatural = def\.naturalSize/, '自然尺寸必须由 registry metadata 决定')
assert.match(controlCenter, /body = def\.render\?\.\(\{ sessionId \}\)/, 'renderer 必须使用统一 render props（render 可选：input/send/attach 由特判渲染）')
assert.match(controlCenter, /WIDGET_REGISTRY\s*\.filter/, 'slot 渲染必须来自 registry')
assert.match(controlCenter, /WIDGET_REGISTRY\.map/, 'toolbar 必须来自 registry')

console.log('cc widget registry v2 契约测试通过')
