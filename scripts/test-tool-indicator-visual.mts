import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveToolVisualStatus } from '../src/components/chat/toolStatus.ts'
import { resolveToolIndicatorMotion, toolIndicatorMotionClass } from '../src/components/chat/toolIndicatorMotion.ts'

const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')

assert.equal(resolveToolIndicatorMotion('queued'), 'static')
assert.equal(resolveToolIndicatorMotion('running'), 'breathe')
assert.equal(resolveToolIndicatorMotion('waiting'), 'pulse')
assert.equal(resolveToolIndicatorMotion('completed'), 'settle')
assert.equal(resolveToolIndicatorMotion('failed'), 'flash')
assert.equal(resolveToolIndicatorMotion('cancelled'), 'static')
assert.equal(resolveToolIndicatorMotion('unknown'), 'static')
assert.equal(toolIndicatorMotionClass('running'), 'term-tool-indicator--breathe')

// 状态动画与颜色解析分离：相同的主题颜色 resolver 仍然负责状态颜色。
assert.equal(resolveToolVisualStatus('completed'), 'ok')
assert.equal(resolveToolVisualStatus('running'), 'run')
assert.equal(resolveToolVisualStatus('failed'), 'err')

assert.match(chatView, /toolIndicatorMotionClass\(model\.state\)/, 'ToolCard 必须按归一化状态接入动画 class')
assert.match(chatView, /term-tool-indicator \$\{status\} \$\{toolIndicatorMotionClass/, 'indicator 必须同时保留现有颜色 status class')
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
