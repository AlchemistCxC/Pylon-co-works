import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const agentSheet = readFileSync(new URL('../src/sheets/AgentSheetView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url), 'utf8')
const controlCenter = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')
const controlCenterCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css', import.meta.url), 'utf8')
const pet = readFileSync(new URL('../src/components/PetCompanion.tsx', import.meta.url), 'utf8')
const petCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/PetCompanion.css', import.meta.url), 'utf8')

assert.equal(agentSheet.includes('AgentRendererSuiteWorkbench'), true)
assert.equal(agentSheet.includes('activeSessionId: ctx.activeSession'), true)
assert.equal(agentSheet.includes('workspaceMode'), true)
assert.equal(css.includes('right:calc(8px + var(--right-panel-inset, 0px))'), true)
assert.equal(controlCenter.includes('--cc-right-inset'), false)
assert.equal(controlCenterCss.includes('var(--right-panel-inset, 0px)'), true)
// Pet and right-panel inset ownership moved into the renderer-suite host.
assert.equal(css.includes('.scroll-bottom-btn'), true)
assert.equal(/\.scroll-bottom-btn\s*\{[^}]*z-index:\s*([4-9][0-9]|[1-9][0-9]{2,})/.test(css), false, '回底按钮不得用高 z-index 穿透右栏')

console.log('scrollBottomOffset 回归测试通过')
