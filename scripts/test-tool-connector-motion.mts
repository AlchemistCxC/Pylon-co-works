import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { toolConnectorMotionClass } from '../src/components/chat/toolIndicatorMotion.ts'

const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const connector = readFileSync(new URL('../src/components/chat/ToolConnector.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')

assert.equal(toolConnectorMotionClass('queued'), 'term-tool-connector--static')
assert.equal(toolConnectorMotionClass('running'), 'term-tool-connector--breathe')
assert.equal(toolConnectorMotionClass('waiting'), 'term-tool-connector--pulse')
assert.equal(toolConnectorMotionClass('completed'), 'term-tool-connector--settle')
assert.equal(toolConnectorMotionClass('failed'), 'term-tool-connector--flash')
assert.equal(toolConnectorMotionClass('cancelled'), 'term-tool-connector--static')

assert.match(chatView, /const previousConnectorVisualState = hasPreviousTool[\s\S]*?resolveRowToolVisualState\(previous\.message, messageLookups\)/, '连接线必须读取上一个 Tool 的视觉状态')
assert.match(chatView, /<ToolConnector[\s\S]*?status=\{previousConnectorStatus \|\| 'run'\}[\s\S]*?visualState=\{normalizeToolStatus\(previousConnectorVisualState\)\}/, '连接线颜色与动画必须都继承上一个 Tool')
assert.match(connector, /toolConnectorMotionClass\(visualState\)/, 'ToolConnector 必须生成动画 class')
assert.match(connector, /className=\{`term-tool-connector \$\{toolConnectorMotionClass\(visualState\)\}`\}/, '动画仅挂在 connector 元素')
assert.match(css, /\.term-tool-connector--breathe \{ animation:tool-connector-breathe 1\.1s ease-in-out infinite; \}/)
assert.match(css, /\.term-tool-connector--pulse \{ animation:tool-connector-pulse 1\.8s ease-in-out infinite; \}/)
assert.match(css, /\.term-tool-connector--settle \{ animation:tool-connector-settle 360ms ease-out 1 both; \}/)
assert.match(css, /\.term-tool-connector\[data-tool-state="failed"\] \{ filter:blur\(0\.65px\); \}/, 'failed connector 必须同步错误指示物的模糊表现')
assert.match(css, /\.term-tool-connector--flash \{ animation:tool-connector-flash 320ms ease-out 1 both; \}/)
assert.match(css, /\.term-tool-connector--static \{ animation:none; \}/)
assert.match(css, /@media \(prefers-reduced-motion:reduce\)[\s\S]*?\.term-tool-connector--breathe,[\s\S]*?\.term-tool-connector--flash \{ animation:none; filter:none; \}/)

console.log('toolConnector 状态动画契约测试通过')
