/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/ControlCenter.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')

assert.match(css, /\.cc-input-slot\s*\{[^}]*display:flex;[^}]*align-items:flex-end;/s)
assert.match(css, /\.cc-input-slot \.cc-widget\s*\{[^}]*position:relative;[^}]*width:100%;[^}]*height:auto;/s)
assert.match(css, /\.cc-status-row\s*\{[^}]*justify-content:flex-start;/s)
assert.match(css, /\.cc-status-secondary\s*\{[^}]*order:1;/s)
assert.match(css, /\.cc-status-primary\s*\{[^}]*order:2;/s)
assert.match(css, /\.cc-actions\s*\{[^}]*order:3;/s)
const statusRow = css.match(/\.cc-status-row\s*\{[^}]*\}/s)?.[0] ?? ''
assert.equal(css.includes('--cc-status-font-size'), true)
assert.match(statusRow, /font-size:\s*max\(/)
// C2：可见性规则收敛到 domains/cc/widgetDefinitions.ts 的 isWidgetVisible 单一谓词
const widgetDefs = readFileSync(new URL('../src/domains/cc/widgetDefinitions.ts', import.meta.url), 'utf8')
assert.equal(widgetDefs.includes("ccStyle === 'numeric' && id === 'ekg' && !ctx.hidden.includes('pct')"), true, 'numeric 模式不得同时显示两份百分比')
assert.equal(source.includes('isWidgetVisible(id, { hidden, inputMode, submitButtonMode, ccStyle, editMode, presentationProfileId })'), true, 'renderWidget 必须消费单一可见性谓词及 Profile 约束')

console.log('controlCenterPeriStyle 回归测试通过')
