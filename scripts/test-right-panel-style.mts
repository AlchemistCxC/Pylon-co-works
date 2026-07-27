import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/components/RightPanel.css', import.meta.url), 'utf8')

assert.equal(css.includes('.right-panel::before'), true)
assert.equal(css.includes('opacity:var(--right-transparency,1)'), true)
assert.equal(css.includes('blur(var(--right-blur,0px))'), true)
assert.equal(/\.right-panel \{[^}]*opacity:var\(--right-transparency/.test(css), false, '透明度不得作用于内容容器')

console.log('rightPanelStyle 回归测试通过')