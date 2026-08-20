import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/components/', import.meta.url)
const preview = await readFile(new URL('SettingsPreview.tsx', root), 'utf8')
const widgetRegistry = await readFile(new URL('cc/widgetRegistry.tsx', root), 'utf8')

assert.match(preview, /<ControlCenter sessionId=\{null\} \/>/)
assert.match(widgetRegistry, /useSessionLiveStats\(sessionId: string \| null\)/)
assert.match(widgetRegistry, /useIdentityStore\(state =>\s*sessionId \? state\.sessions\.find\(item => item\.id === sessionId\) : undefined/, 'null session selector 返回稳定引用')
assert.match(widgetRegistry, /\?\? NO_HIDDEN_IDS|EMPTY_SESSION_LIVE_STATS/, '缺省值必须稳定引用')
assert.match(widgetRegistry, /state\.sessionLiveStats\[toAgentContextKey\(context\)\] \?\? EMPTY_SESSION_LIVE_STATS/)
// input 注册表不持 render（ControlCenter 特判渲染——InputBar 需 ref/split 等参数）
assert.match(widgetRegistry, /id: 'input', label: '输入栏', category: 'input', defaultPlacement: placement\('input', 0\), naturalSize: false \}/)
assert.doesNotMatch(widgetRegistry, /id: 'input'[^\n]*render:/, 'input 不得在注册表持有 render')
assert.match(preview, /style=\{\{ pointerEvents: 'none' \}\}/)

console.log('ControlCenter null-session Preview degradation contract: PASS')
