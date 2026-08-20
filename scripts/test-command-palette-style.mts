import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css', import.meta.url), 'utf8')

assert.equal(css.includes('background:rgba(255,255,255,0.96)'), false)
assert.equal(css.includes('background:var(--command-bg,#fff)'), true)
assert.equal(css.includes('[data-ui-scheme="dark"] .command-palette'), true)

console.log('commandPaletteStyle 回归测试通过')