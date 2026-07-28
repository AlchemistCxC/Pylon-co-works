import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/components/SessionSettings.css', import.meta.url), 'utf8')
const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

assert.match(css, /\.app\[data-ui-scheme="dark"\] \.session-settings \{/,
  '暗色模式应为 SessionSettings 建立独立可读性 token')
assert.match(css, /--session-settings-surface:\s*#[0-9a-fA-F]{6}/,
  '暗色 Dialog 应使用不透明实色表面')
assert.match(css, /\.app\[data-ui-scheme="dark"\] \.session-settings \.sess-field (?:input|select|textarea)/,
  '暗色输入控件应使用实底高对比样式')
assert.match(css, /color:\s*var\(--session-settings-text\)/,
  '主要文字应使用会话设置专用高对比 token')
assert.match(indexCss, /body\[data-ui-scheme="dark"\] \.dialog-content/,
  'Portal Dialog 的暗色样式必须支持 body data-ui-scheme')

console.log('session settings dark theme tests passed')
