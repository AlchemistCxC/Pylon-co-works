import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/components/', import.meta.url)
const preview = await readFile(new URL('SettingsPreview.tsx', root), 'utf8')
const controlCenter = await readFile(new URL('ControlCenter.tsx', root), 'utf8')

assert.match(preview, /<ControlCenter sessionId=\{null\} \/>/)
assert.match(controlCenter, /if \(!sessionId\) return EMPTY_SESSION_LIVE_STATS/)
assert.match(controlCenter, /const source = state\.sessions\.find\(session => session\.id === sessionId\)\?\.source/)
assert.match(controlCenter, /render: \(sid\) => <InputBar sessionId=\{sid\} \/>/)
assert.match(preview, /style=\{\{ pointerEvents: 'none' \}\}/)

console.log('ControlCenter null-session Preview degradation contract: PASS')
