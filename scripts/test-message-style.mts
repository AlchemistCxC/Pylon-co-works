import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')

for (const variable of ['--msg-font', '--msg-text', '--msg-line-height']) {
  assert.equal(app.includes(variable), true, `${variable} 必须由 App 注入`)
  assert.equal(css.includes(variable), true, `${variable} 必须由消息渲染消费`)
}
assert.equal(app.includes('data-msg-style={s.msgStyle'), true)
assert.equal(css.includes('[data-msg-style="bubble"]'), true)

console.log('messageStyle 回归测试通过')