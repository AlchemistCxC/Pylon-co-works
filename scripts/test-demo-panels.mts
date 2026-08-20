import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const prism = readFileSync(new URL('../src/components/PrismSheet.tsx', import.meta.url), 'utf8')
const prismCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css', import.meta.url), 'utf8')

assert.equal(prism.includes('演示预览：尚未接入 Prism API'), true)
assert.equal(prismCss.includes('.prism-sheet .ps-btn, .prism-sheet .ps-toggle'), true)
assert.equal(prismCss.includes('pointer-events:none'), true)

console.log('demoPanels 回归测试通过')
