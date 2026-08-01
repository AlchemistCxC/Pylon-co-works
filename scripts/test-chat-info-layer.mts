import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const tsx = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')

assert.equal(app.includes('data-message-layout={s.messageLayout'), true)
assert.equal(app.includes('data-active-preset='), false)
assert.equal(app.includes('activeVisualPreset'), false)
assert.equal(tsx.includes("running ? 'Thinking…' : `Thought for ${characterCount} chars`"), false)
assert.equal(tsx.includes('∴ Thinking…'), false)
assert.equal(tsx.includes('formatThoughtDuration'), true)
assert.equal(tsx.includes('thoughtDurationMs'), true)
assert.equal(tsx.includes('startedAt={msg.thoughtStartedAt}'), true)
assert.equal(tsx.includes('aria-expanded={open}'), true)
assert.equal(tsx.includes('aria-controls={bodyId}'), true)
assert.equal(tsx.includes('useReducedMotion()'), true)
assert.equal(css.includes('.app[data-message-layout="claude"] .term-row { margin:0 0 1em; }'), true)
assert.equal(css.includes('background:var(--user-tag-bg, #373737)'), true)
assert.match(css, /\.app\[data-message-layout="claude"\] \.term-assistant,\s*\.app\[data-message-layout="claude"\] \.term-reasoning,\s*\.app\[data-message-layout="claude"\] \.term-tool \{/)
assert.equal(css.includes('.app[data-message-layout="claude"] .term-reasoning-body'), true)
assert.equal(css.includes('data-active-preset'), false)
assert.equal(css.includes('font-style:italic'), true)
assert.equal(css.includes('margin-top:1em'), true)
assert.equal(css.includes('@media (prefers-reduced-motion:reduce)'), true)

console.log('chatInfoLayer 回归测试通过')
