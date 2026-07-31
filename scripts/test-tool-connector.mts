import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveConnectorColor } from '../src/components/chat/toolPresentation.ts'

const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')

// ── 连接线颜色纯函数 ──
assert.equal(resolveConnectorColor('none', 'ok', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), 'transparent')
assert.equal(resolveConnectorColor('fixed', 'err', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#f')
assert.equal(resolveConnectorColor('follow', 'ok', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#a')
assert.equal(resolveConnectorColor('follow', 'run', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#b')
assert.equal(resolveConnectorColor('follow', 'err', { toolOk: '#a', toolRun: '#b', toolErr: '#c' }, '#f'), '#c')
assert.equal(resolveConnectorColor('follow', 'ok', { toolOk: '', toolRun: '#b', toolErr: '#c' }, '#f'), '#f', '缺色回退 fixed 色')
assert.equal(resolveConnectorColor('unknown-mode', 'ok', { toolOk: '#a' }, '#f'), '#f')

// ── 真实 DOM 连接线元素（替代伪元素方案） ──
assert.match(chatView, /<ToolConnector status=/, '连续 tool 行之间必须渲染连接线元素')
assert.match(chatView, /hasPreviousTool && <ToolConnector/, '仅前一行也是 tool 时渲染连接线')
assert.match(chatView, /React\.Fragment key=\{renderMessage\.message\.id\}/, '行与连接线共享稳定 key')
assert.match(chatView, /className="term-tool-connector" style=\{\{ background: color \}\}/, '连接线颜色由组件 inline 写入')

// ── 测量：连接线前后兄弟即相邻行，写 top/height ──
assert.match(chatView, /connector\.previousElementSibling/, '上一行 = 连接线前兄弟')
assert.match(chatView, /connector\.nextElementSibling/, '本行 = 连接线后兄弟')
assert.match(chatView, /const previousCenter = previousRow\.offsetTop \+ previousRow\.offsetHeight - 2 - headHeight \/ 2/, '线起点 = 上一 head 中心')
assert.match(chatView, /connector\.style\.height = `\$\{gap \+ 4 \+ headHeight\}px`/, '线长 = gap + padding + head 高')
assert.match(chatView, /observer\.observe\(row\)/, '必须观察行元素（容器 content-box 固定高不触发 RO）')
assert.match(chatView, /}, \[messages\]\)/, 'messages 变化必须重跑绑定')
assert.match(chatView, /requestAnimationFrame\(measure\)/, '测量必须 rAF 节流')
assert.equal(chatView.includes("--conn-gap"), false, '伪元素变量方案必须移除')

// ── CSS：层叠与定位 ──
assert.match(css, /\.term \{[\s\S]*?position:relative;/, '.term 必须是连接线定位包含块')
assert.match(css, /\.term-tool-connector \{[\s\S]*?position:absolute;[\s\S]*?z-index:1;/, '线在 body 背景之上（展开不被截断）')
assert.match(css, /\.term-tool-head \{ position:relative; z-index:2;/, 'head 在线之上（指示器覆盖线）')
assert.equal(css.includes('term-tool::before'), false, '伪元素连接线必须移除')
assert.equal(css.includes('--conn-gap'), false, 'gap 变量方案必须移除')
assert.equal(css.includes('.term-tool { min-width:0; padding:2px 0; position:relative; }'), true, '.term-tool 不再创建 stacking context（避免隔离 head 层级）')

// 工具名随状态着色（主题变量驱动）
assert.match(css, /\.term-tool\[data-status="ok"\] \.term-tool-name \{ color:var\(--tool-ok,#1e9646\); \}/)
assert.match(css, /\.term-tool\[data-status="err"\] \.term-tool-name \{ color:var\(--tool-err,#be2828\); \}/)
assert.match(css, /\.term-tool\[data-status="run"\] \.term-tool-name \{ color:var\(--tool-run,#3b82f6\); \}/)

console.log('toolConnector DOM 元素方案回归测试通过')
