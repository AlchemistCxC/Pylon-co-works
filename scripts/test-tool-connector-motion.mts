/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { toolConnectorMotionClass } from '../src/components/chat/toolIndicatorMotion.ts'

const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const pipeline = readFileSync(new URL('../src/components/chat/chatRowPipeline.ts', import.meta.url), 'utf8')
const connector = readFileSync(new URL('../src/components/chat/ToolConnector.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url), 'utf8')

assert.equal(toolConnectorMotionClass('queued'), 'term-tool-connector--static')
assert.equal(toolConnectorMotionClass('running'), 'term-tool-connector--breathe')
assert.equal(toolConnectorMotionClass('waiting'), 'term-tool-connector--pulse')
assert.equal(toolConnectorMotionClass('completed'), 'term-tool-connector--settle')
assert.equal(toolConnectorMotionClass('failed'), 'term-tool-connector--flash')
assert.equal(toolConnectorMotionClass('cancelled'), 'term-tool-connector--static')

assert.match(pipeline, /const previousConnectorVisualState = hasPreviousTool[\s\S]*?resolveRowToolVisualState\(previous\.message, messageLookups\)/, '连接线必须读取上一个 Tool 的视觉状态')
assert.match(chatView, /<ToolConnector[\s\S]*?status=\{desc\.connectorStatus \|\| 'run'\}[\s\S]*?visualState=\{normalizeToolStatus\(desc\.connectorVisualState\)\}/, '连接线颜色与动画必须都继承上一个 Tool')
assert.match(connector, /toolConnectorMotionClass\(visualState\)/, 'ToolConnector 必须生成动画 class')
assert.match(connector, /className=\{`term-tool-connector term-tool-connector-style--\$\{connectorStyle \|\| 'solid'\} \$\{toolConnectorMotionClass\(visualState\)\}`\}/, '动画与样式 class 必须挂在 connector 元素')
assert.match(connector, /const connectorStyle = useStore/, 'connector 必须消费持久化样式')
assert.match(connector, /const connectorWidth = useStore/, 'connector 必须消费持久化宽度')
assert.match(connector, /const connectorOpacity = useStore/, 'connector 必须消费持久化透明度')
assert.match(connector, /--tool-connector-color/, 'dotted connector 必须使用解析后的主题颜色')
assert.match(css, /\.term-tool-connector-style--dotted/, '必须支持 dotted connector')
assert.match(css, /\.term-tool-connector-style--pulse/, '必须支持 pulse connector')
assert.match(css, /\.term-tool-connector--pulse \{ animation:tool-connector-pulse 1\.8s ease-in-out infinite; \}/)
assert.match(css, /\.term-tool-connector--settle \{ animation:tool-connector-settle 360ms ease-out 1 both; \}/)
assert.match(css, /\.term-tool-connector\[data-tool-state="failed"\] \{ filter:blur\(0\.65px\); \}/, 'failed connector 必须同步错误指示物的模糊表现')
assert.match(css, /\.term-tool-connector--flash \{ animation:tool-connector-flash 320ms ease-out 1 both; \}/)
assert.match(css, /\.term-tool-connector--static \{ animation:none; \}/)
assert.match(css, /@media \(prefers-reduced-motion:reduce\)[\s\S]*?\.term-tool-connector--breathe,[\s\S]*?\.term-tool-connector--flash \{ animation:none; filter:none; \}/)

console.log('toolConnector 状态动画契约测试通过')
