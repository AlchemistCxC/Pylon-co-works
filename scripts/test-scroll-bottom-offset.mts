import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const chat = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')

assert.equal(app.includes('<ChatView sessionId={activeSession} rightOpen={rightOpen} rightWidth={s.rightWidth} />'), true)
assert.equal(chat.includes('rightOpen?: boolean; rightWidth?: number'), true)
assert.equal(chat.includes("'--chat-right-offset': rightOpen ? `${rightWidth + 8}px` : '0px'"), true)
assert.equal(css.includes('right:calc(8px + var(--chat-right-offset, 0px))'), true)
assert.equal(css.includes('.scroll-bottom-btn'), true)
assert.equal(/\.scroll-bottom-btn\s*\{[^}]*z-index:\s*([4-9][0-9]|[1-9][0-9]{2,})/.test(css), false, '回底按钮不得用高 z-index 穿透右栏')

console.log('scrollBottomOffset 回归测试通过')
