/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveConnectorColor } from '../src/domains/tool/toolPresentation.ts'

const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url), 'utf8')
const connectorHook = readFileSync(new URL('../src/components/chat/useToolConnectors.ts', import.meta.url), 'utf8')
const pipeline = readFileSync(new URL('../src/components/chat/chatRowPipeline.ts', import.meta.url), 'utf8')
const connector = readFileSync(new URL('../src/components/chat/ToolConnector.tsx', import.meta.url), 'utf8')
const preview = readFileSync(new URL('../src/components/SettingsPreview.tsx', import.meta.url), 'utf8')

// ── 连接线颜色纯函数 ──
assert.equal(resolveConnectorColor('none', 'ok', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), 'transparent')
assert.equal(resolveConnectorColor('fixed', 'err', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#f')
assert.equal(resolveConnectorColor('follow', 'ok', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#a')
assert.equal(resolveConnectorColor('follow', 'run', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#b')
assert.equal(resolveConnectorColor('follow', 'err', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#c')

// ── 线色跟随连续调用中的上一个 Tool 状态（编排在 chatRowPipeline 纯模块）──
assert.match(pipeline, /const previousConnectorStatus = hasPreviousTool\s*\? resolveRowToolConnectorStatus\(previous\.message\)/, '必须由上一个工具消息直接解析连接线状态')
assert.match(pipeline, /function resolveRowToolVisualState[\s\S]*?if \(!message \|\| message\.role !== 'tool'\) return undefined[\s\S]*?return normalizeToolStatus\(message\.toolStatus\)/, '状态动画必须兼容真实 tool-* id 与浏览器 mock id')
assert.match(pipeline, /return resolveToolPresentationState\(message\.toolStatus, message\.toolOutput !== undefined\)\.tone/, '连接线状态必须兼容无 tool- 前缀的 mock/真实消息 id（B2 唯一 API）')
assert.match(connector, /resolveConnectorColor\(connectorMode, status, \{ toolOk, toolRun, toolErr \}, connectorColor\)/, '连接线组件必须用状态色')

// ── 测量：展开的工具仍保持连接 ──
assert.match(connectorHook, /connector\.style\.display = 'block'/, '连接线始终保持显示')
assert.match(connectorHook, /connector\.previousElementSibling/, '上一行 = 连接线前兄弟')
assert.match(connectorHook, /const connectorParent = connector\.offsetParent as HTMLElement \| null/, '连接线必须相对自身实际定位父级测量')
assert.match(connectorHook, /const previousCenter = previousRect\.top - parentRect\.top \+ previousRect\.height \/ 2/, '线起点必须是上一个 head 的真实中心')
assert.match(connectorHook, /const currentCenter = currentRect\.top - parentRect\.top \+ currentRect\.height \/ 2/, '线终点必须是当前 head 的真实中心')
assert.match(connectorHook, /indicatorRect\.left - parentRect\.left \+ indicatorRect\.width \/ 2/, '线横坐标必须使用真实指示器中心')
assert.match(connectorHook, /for \(const row of container\.querySelectorAll\('\.term-row'\)\)/, '必须观察所有消息行，reasoning 展开后才能触发后续 connector 重测')
assert.match(connectorHook, /observer\.observe\(row\)/, '必须观察消息行')
assert.match(connectorHook, /Tool 或 reasoning body 展开、字号变化由行 RO 触发重测/, '注释必须明确 reasoning 展开会触发重测')
assert.match(connectorHook, /}, \[messages, containerRef\]\)/, 'messages 变化必须重跑绑定')

// ── Preview 独立渲染：由行伪元素读取真实主题状态颜色 ──
assert.match(preview, /const connectorStatus = previous\?\.status/, '预览连接线必须取上一个工具状态')
assert.match(preview, /resolveConnectorColor\([\s\S]*?connectorMode,[\s\S]*?\{ toolOk, toolRun, toolErr \},[\s\S]*?connectorColor/, '预览必须用真实连接线颜色解析函数')
assert.match(preview, /data-has-connector=\{connectorStatus \? 'true' : undefined\}/, '仅连续 Tool 时标记预览连接线')
assert.match(preview, /'--pv-connector-color': connectorStatus \? previewConnectorColor\(connectorStatus\) : 'transparent'/, '预览连接线色必须绑定解析结果')
assert.match(css, /\.pv-app \.pv-tool-row\[data-has-connector="true"\]::before \{[\s\S]*?background:var\(--pv-connector-color,transparent\);/, '预览必须由行伪元素实际绘制连接线')
assert.equal(preview.includes("import ToolConnector from './chat/ToolConnector'"), false, '预览不可复用主界面测量型连接线节点')

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
