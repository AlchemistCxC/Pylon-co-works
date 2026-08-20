/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const chatView = readFileSync('src/components/chat/ChatView.tsx', 'utf8')
const css = readFileSync('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', 'utf8')

assert.match(chatView, /const MOCK_GENERATION_PHASES: GenerationPhase\[\] = \[/)
assert.match(chatView, /setMockPhaseIndex\(index => \(index \+ 1\) % MOCK_GENERATION_PHASES\.length\)/)
assert.match(chatView, /running=\{generating \|\| browserMockPhase !== undefined\}/)
assert.match(chatView, /phase=\{browserMockPhase \|\| generationPhase \|\| undefined\}/)
assert.match(css, /\.term-user code \{ font-family:var\(--mono\); font-size:inherit; \}/)

console.log('浏览器 mock spinner 与行内代码字体回归测试通过')
