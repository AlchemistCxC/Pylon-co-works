import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/ControlCenter.css', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')

assert.equal(source.includes('const responsiveLayout = !editMode && !cliCustomized'), true)
assert.equal(source.includes('className={`cc-body ${responsiveLayout ? \'cc-responsive\' : \'\'}`}'), true)
assert.equal(source.includes('<div className="cc-flow-row">'), true)
assert.equal(source.includes("WIDGET_REGISTRY.filter(w => w.id !== 'input')"), true)
assert.equal(source.includes("flow={flow}"), true)

assert.equal(css.includes('.cc-body.cc-responsive .cc-flow-row'), true)
assert.equal(css.includes('display:flex; align-items:center; align-content:center;'), true)
assert.equal(css.includes('flex-wrap:wrap; gap:6px 14px;'), true)
assert.equal(css.includes('.cc-widget.cc-flow-widget'), true)
assert.equal(css.includes('position:relative;'), true)

assert.equal(store.includes('ccCliCustomized: false,'), true, '应用预设后应回到响应式默认骨架')

console.log('controlCenterResponsive 回归测试通过')
