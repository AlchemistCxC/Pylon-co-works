import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/ControlCenter.css', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')

assert.equal(app.includes('ccStatusFontSize'), true)
assert.equal(app.includes("'--cc-status-font-size'"), true)
assert.equal(css.includes('font-size:var(--cc-status-font-size, 13px)'), true)
assert.equal(store.includes('ccStatusFontSize: 13'), true)
assert.equal(store.includes('ccStatusFontSize: number'), true)

console.log('controlCenterResponsive 回归测试通过')
