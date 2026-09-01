/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url), 'utf8')
const defs = readFileSync(new URL('../src/themeFieldDefs.ts', import.meta.url), 'utf8')

// --msg-font/--msg-text 由 themeCssSnapshot 派生（显式派生）；--msg-line-height 由 defs 声明驱动循环注入
const snapshot = readFileSync(new URL('../src/domains/theme/themeCssSnapshot.ts', import.meta.url), 'utf8')
for (const variable of ['--msg-font', '--msg-text']) {
  assert.equal(snapshot.includes(variable), true, `${variable} 必须由 CSS snapshot 派生`)
}
assert.equal(defs.includes('msgLineHeight'), true, '--msg-line-height 必须由 defs 声明（循环注入）')
for (const variable of ['--msg-font', '--msg-text', '--msg-line-height']) {
  assert.equal(css.includes(variable), true, `${variable} 必须由消息渲染消费`)
}
assert.equal(app.includes('{...resolved.dataAttributes}'), true)
const skinResolver = readFileSync(new URL('../src/plugin-runtime/skin/skinResolver.ts', import.meta.url), 'utf8')
assert.equal(skinResolver.includes("'data-msg-style'"), true)
assert.equal(css.includes('[data-msg-style="bubble"]'), true)
assert.equal(css.includes('[data-message-layout="claude"] .term-tool'), true)
assert.match(css, /\.app\[data-message-layout="claude"\] \.term-user \{[\s\S]*?padding:8px 0;/)
assert.match(css, /\.app\[data-message-layout="claude"\] \.term-assistant,[\s\S]*?\.term-reasoning,[\s\S]*?\.term-tool \{[\s\S]*?padding-left:0;/)
assert.equal(css.includes('padding:0 0 0 2ch'), false)
assert.match(css, /\.term-user \{ display:flex; align-items:baseline;/, '非 Claude 用户消息必须使用固定前缀列布局')
assert.match(css, /\.term-spinner-row \{[\s\S]*?padding: var\(--ui-space-1\) 0;/, 'spinner 行必须与消息左轨道对齐')

console.log('messageStyle 回归测试通过')
