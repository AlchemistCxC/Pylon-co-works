import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const tsx = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')

assert.equal(app.includes("s.activePreset?.[zone] === 'claude' && !s.dirty?.[zone]"), true)
assert.equal(app.includes('data-active-preset={activeVisualPreset}'), true)
assert.equal(tsx.includes("running ? 'Thinking…' : `Thought for ${characterCount} chars`"), true)
assert.equal(tsx.includes('∴ Thinking…'), false)
assert.equal(tsx.includes('Array.from(text).length'), true)
assert.equal(tsx.includes('<ReasoningBlock text={msg.content} running={msg.running === true} />'), true)
assert.equal(tsx.includes('aria-expanded={open}'), true)
assert.equal(css.includes('.app[data-active-preset="claude"] .term-row { margin:0 0 1em; }'), true)
assert.equal(css.includes('background:var(--user-tag-bg, #373737)'), true)
assert.equal(css.includes('.app[data-active-preset="claude"] .term-assistant { padding:0 0 0 2ch; }'), true)
assert.equal(css.includes('.app[data-active-preset="claude"] .term-reasoning-body'), true)
assert.equal(css.includes('font-style:italic'), true)
assert.equal(css.includes('margin-top:1em'), true)

console.log('chatInfoLayer 回归测试通过')
