import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const right = readFileSync(new URL('../src/components/RightPanel.tsx', import.meta.url), 'utf8')
const tabs = readFileSync(new URL('../src/components/right-panel/RightPanelTabs.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/RightPanel.css', import.meta.url), 'utf8')

for (const tab of ['workspace', 'logs', 'activity', 'changes']) {
  assert.equal(tabs.includes(`id: '${tab}'`), true, `缺少 tab: ${tab}`)
}
assert.equal(right.includes('sessionId: string | null'), true)
assert.equal(right.includes('演示数据'), false)
assert.equal(right.includes('G:\\Project\\prism\\'), false)
assert.equal(right.includes('TRPG 战役'), false)
assert.equal(right.includes('panel-demo-notice'), false)
assert.equal(css.includes('.right-panel::before'), true)
assert.equal(css.includes('opacity:var(--right-transparency,1)'), true)
assert.equal(css.includes('blur(var(--right-blur,0px))'), true)
assert.equal(/\.right-panel \{[^}]*opacity:var\(--right-transparency/.test(css), false, '透明度不得作用于内容容器')

console.log('rightPanel contract 回归测试通过')
