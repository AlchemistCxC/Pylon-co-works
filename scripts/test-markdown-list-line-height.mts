import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')

assert.equal(css.includes('.term-row-assistant .term-assistant,'), true)
assert.equal(css.includes('.term-row-assistant .term-assistant ol,'), true)
assert.equal(css.includes('.term-row-assistant .term-assistant li'), true)
assert.equal(css.includes('line-height:var(--msg-line-height,var(--chat-line-height,1.4));'), true)
assert.equal(css.includes('.term-assistant ol { padding-left:2em; margin:0; }'), true)
assert.equal(css.includes('.term-assistant ul { padding-left:1.5em; margin:0; }'), true)
assert.equal(css.includes('.term-assistant li { margin:0; }'), true)
assert.equal(css.includes('.term-assistant ol { padding-left:2em; margin:4px 0; }'), false)
assert.equal(css.includes('.term-assistant li { margin:2px 0; }'), false)

console.log('markdownListLineHeight 回归测试通过')
