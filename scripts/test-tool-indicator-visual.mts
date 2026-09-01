/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveToolPresentationState } from '../src/domains/tool/status.ts'
import { resolveToolIndicatorMotion, toolIndicatorMotionClass } from '../src/components/chat/toolIndicatorMotion.ts'

const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url), 'utf8')

assert.equal(resolveToolIndicatorMotion('queued'), 'static')
assert.equal(resolveToolIndicatorMotion('running'), 'breathe')
assert.equal(resolveToolIndicatorMotion('waiting'), 'pulse')
assert.equal(resolveToolIndicatorMotion('completed'), 'settle')
assert.equal(resolveToolIndicatorMotion('failed'), 'flash')
assert.equal(resolveToolIndicatorMotion('cancelled'), 'static')
assert.equal(resolveToolIndicatorMotion('unknown'), 'static')
assert.equal(toolIndicatorMotionClass('running'), 'term-tool-indicator--breathe')

// 状态动画与颜色解析分离：相同的主题颜色 resolver 仍然负责状态颜色（B2：唯一 API）。
assert.equal(resolveToolPresentationState('completed').tone, 'ok')
assert.equal(resolveToolPresentationState('running').tone, 'run')
assert.equal(resolveToolPresentationState('failed').tone, 'err')
assert.equal(resolveToolPresentationState(undefined, true).tone, 'ok', 'unknown+有输出 → ok')
assert.equal(resolveToolPresentationState(undefined, false).tone, 'run', 'unknown+无输出 → run')

assert.match(css, /\.term-tool-indicator\.ok \{ color:var\(--tool-ok/, '完成色仍使用现有 toolOk 变量')
assert.match(css, /\.term-tool-indicator\.err \{ color:var\(--tool-err/, '错误色仍使用现有 toolErr 变量')
assert.match(css, /\.term-tool-indicator\.run \{ color:var\(--tool-run/, '运行色仍使用现有 toolRun 变量')
assert.match(css, /\.term-tool-indicator--breathe \{ animation:/)
assert.match(css, /\.term-tool-indicator--pulse \{ animation:/)
assert.match(css, /\.term-tool-indicator--settle \{ animation:[^;]+ 1 /)
assert.match(css, /\.term-tool-indicator--flash \{ animation:[^;]+ 1 /)
assert.match(css, /@media \(prefers-reduced-motion:reduce\)[\s\S]*?\.term-tool-indicator--breathe,[\s\S]*?\.term-tool-indicator--flash,[\s\S]*?\.term-tool-connector--flash \{ animation:none; filter:none; \}/)
assert.doesNotMatch(css, /\.term-tool-(?:head|name|summary|body)[^{]*\{[^}]*animation:/, '动画不能挂在 Tool 行或正文')

console.log('toolIndicator 状态动画契约测试通过')
