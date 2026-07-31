import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveConnectorColor } from '../src/components/chat/toolPresentation.ts'

const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const connector = readFileSync(new URL('../src/components/chat/ToolConnector.tsx', import.meta.url), 'utf8')
const preview = readFileSync(new URL('../src/components/SettingsPreview.tsx', import.meta.url), 'utf8')

// ── 连接线颜色纯函数 ──
assert.equal(resolveConnectorColor('none', 'ok', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), 'transparent')
assert.equal(resolveConnectorColor('fixed', 'err', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#f')
assert.equal(resolveConnectorColor('follow', 'ok', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#a')
assert.equal(resolveConnectorColor('follow', 'run', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#b')
assert.equal(resolveConnectorColor('follow', 'err', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#c')

// ── 线色跟随本行工具状态（与旧伪元素 --tool-conn 继承本行语义一致） ──
assert.match(chatView, /<ToolConnector status=\{currentVisualState === 'failed' \? 'err' : currentVisualState === 'completed' \? 'ok' : 'run'\} \/>/, '线色必须跟随本行工具状态')
assert.match(connector, /resolveConnectorColor\(connectorMode, status, \{ toolOk, toolRun, toolErr \}, connectorColor\)/, '连接线组件必须用状态色')

// ── 真实 DOM 连接线元素 ──
assert.match(chatView, /hasPreviousTool && <ToolConnector/, '仅前一行也是 tool 时渲染连接线')
assert.match(chatView, /React\.Fragment key=\{renderMessage\.message\.id\}/, '行与连接线共享稳定 key')

// ── 测量：展开的工具下方无线（截断） ──
assert.match(chatView, /previousRow\.querySelector\('\.term-tool-body'\) !== null/, '必须检测前一行 body 展开')
assert.match(chatView, /connector\.style\.display = 'none'/, '展开时截断连接线')
assert.match(chatView, /connector\.style\.display = 'block'/, '收起时恢复连接线')
assert.match(chatView, /connector\.previousElementSibling/, '上一行 = 连接线前兄弟')
assert.match(chatView, /const previousCenter = previousRow\.offsetTop \+ previousRow\.offsetHeight - 2 - headHeight \/ 2/, '线起点 = 上一 head 中心')
assert.match(chatView, /observer\.observe\(row\)/, '必须观察行元素')
assert.match(chatView, /}, \[messages\]\)/, 'messages 变化必须重跑绑定')

// ── 预览骨架必须渲染连接线（CSS 公式，无测量） ──
assert.match(preview, /i > 0 && <ToolConnector status=\{tl\.done \? 'ok' : 'run'\} \/>/, '预览必须渲染连接线')
assert.match(preview, /import ToolConnector from '\.\/chat\/ToolConnector'/, '预览复用共享连接线组件')
assert.match(css, /\.pv-app \.term-tool-connector \{[\s\S]*?top:calc\(-1 \* var\(--chat-line-height,1\.4\) \* 1em \/ 2 - 2px\);[\s\S]*?height:calc\(var\(--chat-line-height,1\.4\) \* 1em \+ 4px\);/, '预览连接线用行高公式')

// ── CSS：层叠与定位 ──
assert.match(css, /\.term \{[\s\S]*?position:relative;/, '.term 必须是连接线定位包含块')
assert.match(css, /\.term-tool-connector \{[\s\S]*?position:absolute;[\s\S]*?z-index:1;/, '线在 body 背景之上')
assert.match(css, /\.term-tool-head \{ position:relative; z-index:2;/, 'head 在线之上（指示器覆盖线）')
assert.equal(css.includes('term-tool::before'), false, '伪元素连接线必须移除')
assert.equal(css.includes('--conn-gap'), false, 'gap 变量方案必须移除')

// 工具名随状态着色
assert.match(css, /\.term-tool\[data-status="ok"\] \.term-tool-name \{ color:var\(--tool-ok,#1e9646\); \}/)
assert.match(css, /\.term-tool\[data-status="err"\] \.term-tool-name \{ color:var\(--tool-err,#be2828\); \}/)
assert.match(css, /\.term-tool\[data-status="run"\] \.term-tool-name \{ color:var\(--tool-run,#3b82f6\); \}/)

console.log('toolConnector 验收修复回归测试通过')
