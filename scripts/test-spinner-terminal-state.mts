/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const footer = readFileSync(new URL('../src/components/chat/GenerationFooter.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url), 'utf8')

const summaryBlock = footer.match(/if \(!summary\) return null[\s\S]*?term-summary-frame[\s\S]*?\n  \)\n}/)?.[0] ?? ''
assert.ok(summaryBlock, '应存在终止态 summary 渲染分支')
assert.doesNotMatch(summaryBlock, /term-summary-frame[^\n]*style=\{\{[^}]*color:/,
  '终止态 marker 不得继承运行态 spinnerColor')
assert.match(summaryBlock, /summary\.reason === 'cancelled'/, '终止态必须区分 cancelled')
assert.match(summaryBlock, /summary\.reason === 'error'/, '终止态必须区分 error')
assert.match(css, /\.term-summary\s*\{[^}]*color:\s*var\(--text-dim\)/s,
  '终止态 summary 必须使用 muted 文本色')
assert.match(css, /\.term-summary-frame\s*\{[^}]*color:\s*inherit/s,
  '终止态 marker 必须继承 muted summary 颜色')

console.log('spinner terminal-state 回归测试通过')
