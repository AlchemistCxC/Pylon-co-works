import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/InputBar.css', import.meta.url), 'utf8')

assert.match(source, /historyBySourceRef/)
assert.match(source, /recordHistory\(text\)/)
assert.match(source, /historyIndex < 0/)
assert.match(source, /historyDraftRef\.current/)
assert.match(source, /历史记录 \{historyIndex \+ 1\}\/\{historyLength\}/)
assert.match(css, /\.input-history-hint/)

console.log('Input history UI 接线回归测试通过')