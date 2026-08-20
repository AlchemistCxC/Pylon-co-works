/**
 * STYLE GUARD（样式守卫）：收拢原 17 个纯正则守卫中的 CSS token 断言。
 * 这些是纯视觉/主题契约，行为测试无法等价验证，故集中保留为样式守卫。
 * 每项注释溯源原守卫名。来源守卫删除后，本文件继续保护样式防回归。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const chatCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url), 'utf8')
const inputCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css', import.meta.url), 'utf8')
const sessionCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionSettings.css', import.meta.url), 'utf8')
const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

// 来源：test-message-render-boundary.mts
assert.match(chatCss, /\.term-row-error\s*\{/, '消息渲染失败行必须有错误样式')

// 来源：test-browser-mock-spinner.mts
assert.match(chatCss, /\.term-user code \{ font-family:var\(--mono\); font-size:inherit; \}/, '用户代码块保持等宽字体')

// 来源：test-queued-message-ui.mts
assert.match(inputCss, /\.queued-message-list/, '待发送队列必须声明列表样式')

// 来源：test-input-variants.mts
assert.match(inputCss, /\.input-bar\.input-variant-compact/, 'compact 变体必须有样式')
assert.match(inputCss, /\.input-bar\.input-variant-command/, 'command 变体必须有样式')

// 来源：test-session-settings-dark-theme.mts
assert.match(sessionCss, /\.app\[data-ui-scheme="dark"\] \.session-settings \{/, '暗色模式应为 SessionSettings 建立独立可读性 token')
assert.match(sessionCss, /--session-settings-surface:\s*#[0-9a-fA-F]{6}/, '暗色 Dialog 应使用不透明实色表面')
assert.match(sessionCss, /\.app\[data-ui-scheme="dark"\] \.session-settings \.sess-field (?:input|select|textarea)/, '暗色输入控件应使用实底高对比样式')
assert.match(sessionCss, /color:\s*var\(--session-settings-text\)/, '主要文字应使用会话设置专用高对比 token')
assert.match(indexCss, /body\[data-ui-scheme="dark"\] \.dialog-content/, 'Portal Dialog 的暗色样式必须支持 body data-ui-scheme')

console.log('Style guards passed')
