import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/components/ControlCenter.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')

assert.match(css, /\.cc-input-slot\s*\{[^}]*display:flex;[^}]*align-items:flex-end;/s)
assert.match(css, /\.cc-input-slot \.cc-widget\s*\{[^}]*position:relative;[^}]*width:100%;[^}]*height:auto;/s)
assert.match(css, /\.cc-status-row\s*\{[^}]*justify-content:flex-start;/s)
assert.match(css, /\.cc-status-secondary\s*\{[^}]*order:1;/s)
assert.match(css, /\.cc-status-primary\s*\{[^}]*order:2;/s)
assert.match(css, /\.cc-actions\s*\{[^}]*order:3;/s)
const statusRow = css.match(/\.cc-status-row\s*\{[^}]*\}/s)?.[0] ?? ''
assert.equal(css.includes('--cc-status-font-size'), true)
assert.match(statusRow, /font-size:\s*max\(/)
assert.equal(source.includes("ccStyle === 'numeric' && id === 'ekg' && !hidden.includes('pct')"), true, 'numeric 模式不得同时显示两份百分比')

console.log('controlCenterPeriStyle 回归测试通过')
