import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/components/ControlCenter.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')

assert.equal(css.includes('.cc-input-slot { display:flex; align-items:flex-end;'), true)
assert.equal(css.includes('.cc-input-slot .cc-widget { position:relative; inset:auto; width:100%; height:auto;'), true)
assert.equal(css.includes('justify-content:flex-start;'), true)
assert.equal(css.includes('.cc-status-secondary { order:1;'), true)
assert.equal(css.includes('.cc-status-primary { order:2;'), true)
assert.equal(css.includes('.cc-actions { order:3;'), true)
const statusRow = css.match(/\.cc-status-row\s*\{[^}]*\}/s)?.[0] ?? ''
assert.equal(css.includes('--cc-status-font-size'), true)
assert.match(statusRow, /font-size:\s*var\(--cc-status-font-size\s*,\s*[^)]+\)/)
assert.equal(source.includes("ccStyle === 'numeric' && id === 'ekg' && !hidden.includes('pct')"), true, 'numeric 模式不得同时显示两份百分比')

console.log('controlCenterPeriStyle 回归测试通过')
