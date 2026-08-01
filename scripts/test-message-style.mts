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
assert.equal(css.includes('[data-message-layout="claude"] .term-tool'), true)
assert.match(css, /\.app\[data-message-layout="claude"\] \.term-user \{[\s\S]*?padding:8px 0;/)
assert.match(css, /\.app\[data-message-layout="claude"\] \.term-assistant,[\s\S]*?\.term-reasoning,[\s\S]*?\.term-tool \{[\s\S]*?padding-left:0;/)
assert.equal(css.includes('padding:0 0 0 2ch'), false)

console.log('messageStyle 回归测试通过')