import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const colors = readFileSync(new URL('../src/components/ColorPopover.tsx', import.meta.url), 'utf8')
const sidebarCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css', import.meta.url), 'utf8')

assert.equal(settings.includes('<div className="set-group-title"'), false)
assert.equal(settings.includes('<button type="button" className="set-group-title"'), true)
assert.match(settings, /<button type="button"\s*\n\s*className=\{`set-nav-btn/, '设置分区导航必须使用 button')
assert.match(colors, /aria-label=\{ariaLabel \?\? "打开颜色选择器"\}/)
assert.equal(colors.includes('className="set-color-backdrop"'), true)
assert.equal(sidebarCss.includes('.session-item:focus-within .session-gear'), true)
assert.equal(sidebarCss.includes('.session-gear:focus-visible'), true)

console.log('accessibility 回归测试通过')
