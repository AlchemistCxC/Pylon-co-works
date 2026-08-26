import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { BUILTIN_CC_WIDGET_CONTRIBUTIONS } from '../src/domains/cc/widgetCatalog.ts'
import { DEFAULT_CC_LAYOUT } from '../src/ccLayoutState.ts'

const root = new URL('../src/components/', import.meta.url)
const preview = await readFile(new URL('SettingsPreview.tsx', root), 'utf8')
const widgetRegistry = await readFile(new URL('cc/widgetRegistry.tsx', root), 'utf8')

assert.match(preview, /<ControlCenter sessionId=\{null\} \/>/)
assert.match(widgetRegistry, /useSessionLiveStats\(sessionId: string \| null\)/)
assert.match(widgetRegistry, /useIdentityStore\(state =>\s*sessionId \? state\.sessions\.find\(item => item\.id === sessionId\) : undefined/, 'null session selector 返回稳定引用')
assert.match(widgetRegistry, /\?\? NO_HIDDEN_IDS|EMPTY_SESSION_LIVE_STATS/, '缺省值必须稳定引用')
assert.match(widgetRegistry, /state\.sessionLiveStats\[toAgentContextKey\(context\)\] \?\? EMPTY_SESSION_LIVE_STATS/)
// input 注册表不持 render（ControlCenter 特判渲染——InputBar 需 ref/split 等参数）
assert.equal(BUILTIN_CC_WIDGET_CONTRIBUTIONS.find(item => item.id === 'input')?.naturalSize, false)
assert.deepEqual(DEFAULT_CC_LAYOUT.placements.input, BUILTIN_CC_WIDGET_CONTRIBUTIONS.find(item => item.id === 'input')?.defaultPlacement)
assert.doesNotMatch(widgetRegistry, /defaultPlacement|renderPreview/, 'registry 不得持有布局或 preview 字段')
assert.match(preview, /style=\{\{ pointerEvents: 'none' \}\}/)

console.log('ControlCenter null-session Preview degradation contract: PASS')
