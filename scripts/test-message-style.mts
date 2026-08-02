import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')
const defs = readFileSync(new URL('../src/themeFieldDefs.ts', import.meta.url), 'utf8')

// --msg-font/--msg-text 由 App 手写注入（派生值）；--msg-line-height 由 defs 声明驱动循环注入
for (const variable of ['--msg-font', '--msg-text']) {
  assert.equal(app.includes(variable), true, `${variable} 必须由 App 注入`)
}
assert.equal(defs.includes('msgLineHeight'), true, '--msg-line-height 必须由 defs 声明（循环注入）')
for (const variable of ['--msg-font', '--msg-text', '--msg-line-height']) {
  assert.equal(css.includes(variable), true, `${variable} 必须由消息渲染消费`)
}
assert.equal(app.includes('data-msg-style={s.msgStyle'), true)
assert.equal(css.includes('[data-msg-style="bubble"]'), true)
assert.equal(css.includes('[data-message-layout="claude"] .term-tool'), true)
assert.match(css, /\.app\[data-message-layout="claude"\] \.term-user \{[\s\S]*?padding:8px 0;/)
assert.match(css, /\.app\[data-message-layout="claude"\] \.term-assistant,[\s\S]*?\.term-reasoning,[\s\S]*?\.term-tool \{[\s\S]*?padding-left:0;/)
assert.equal(css.includes('padding:0 0 0 2ch'), false)

console.log('messageStyle 回归测试通过')