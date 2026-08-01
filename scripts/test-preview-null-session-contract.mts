import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/components/', import.meta.url)
const preview = await readFile(new URL('SettingsPreview.tsx', root), 'utf8')
const widgetRegistry = await readFile(new URL('cc/widgetRegistry.tsx', root), 'utf8')

assert.match(preview, /<ControlCenter sessionId=\{null\} \/>/)
assert.match(widgetRegistry, /useSessionLiveStats\(sessionId: string \| null\)/)
assert.match(widgetRegistry, /useIdentityStore\(state => sessionId \? state\.sessions\.find\(session => session\.id === sessionId\)\?\.source : undefined\)/)
assert.match(widgetRegistry, /useRuntimeStore\(state => source \? \(state\.sessionLiveStats\[source\] \?\? EMPTY_SESSION_LIVE_STATS\) : EMPTY_SESSION_LIVE_STATS\)/)
assert.match(widgetRegistry, /render: \(\{ sessionId \}\) => <InputBar sessionId=\{sessionId\} \/>/)
assert.match(preview, /style=\{\{ pointerEvents: 'none' \}\}/)

console.log('ControlCenter null-session Preview degradation contract: PASS')
