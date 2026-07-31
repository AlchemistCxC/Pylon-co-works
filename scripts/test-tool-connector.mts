import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')

const connectorBlock = css.match(/\.term-row-tool \+ \.term-row-tool \.term-tool::before \{([\s\S]*?)\n\}/)?.[1]
assert.ok(connectorBlock, '连续 Tool 连接线伪元素必须存在')

// 线长/起点必须随字号（em）、行高（--chat-line-height）与实测间距（--conn-gap）自适应，不得固定像素
assert.match(connectorBlock, /top:\s*calc\(-1 \* var\(--chat-line-height,1\.4\) \* 1em \/ 2 - 2px - var\(--conn-gap, 0px\)\)/, '起点必须按行高/字号/gap 计算')
assert.match(connectorBlock, /height:\s*calc\(var\(--chat-line-height,1\.4\) \* 1em \+ 4px \+ var\(--conn-gap, 0px\)\)/, '线长必须按行高/字号/gap 计算')
assert.match(connectorBlock, /left:\s*calc\(0\.3em - 1px\)/, '指示器中心必须随字号定位（mono 字符约 0.6em 宽）')
assert.equal(/\b(?:top|height):\s*(?:-?\d+px|\d+px)\b/.test(connectorBlock), false, '连接线不得再使用固定像素长度')

// claude 布局行间距 1em 必须纳入线长（CSS fallback；JS 测量会以 inline 覆盖）
const claudeRule = css.match(/\.app\[data-message-layout="claude"\] \.term-row-tool \+ \.term-row-tool \.term-tool::before \{([\s\S]*?)\n\}/)?.[1]
assert.ok(claudeRule?.includes('--conn-gap: 1em'), 'claude 布局必须补偿 1em 行间距')

// 实际间距必须由行级 ResizeObserver 测量写入（body 展开/字号变化时线仍贯通）
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
assert.match(chatView, /const gap = row\.offsetTop - \(previous\.offsetTop \+ previous\.offsetHeight\)/, '必须实测相邻 tool 行间距')
assert.match(chatView, /style\.setProperty\('--conn-gap', `\$\{Math\.max\(0, gap\)\}px`\)/, '实测间距必须写入 --conn-gap')
assert.match(chatView, /observer\.observe\(row\)/, '必须观察行元素（容器 content-box 固定高不触发 RO）')
assert.match(chatView, /}, \[messages\]\)/, 'messages 变化必须重跑行绑定')
assert.match(chatView, /requestAnimationFrame\(measure\)/, '测量必须 rAF 节流')

// 层叠：线在 body 背景之上（展开不被截断）、head 在线之上（指示器覆盖线）
assert.match(css, /\.term-tool \{[\s\S]*?position:relative; z-index:0;/, '.term-tool 必须创建 stacking context')
assert.match(connectorBlock, /z-index:1;/, '线必须位于 body 背景之上')
assert.match(css, /\.term-tool-head \{ position:relative; z-index:2;/, 'head 必须位于线之上')

// 工具名随状态着色（主题变量驱动，参考 CC 主题着色）
assert.match(css, /\.term-tool\[data-status="ok"\] \.term-tool-name \{ color:var\(--tool-ok,#1e9646\); \}/, '已完成工具名必须用 --tool-ok')
assert.match(css, /\.term-tool\[data-status="err"\] \.term-tool-name \{ color:var\(--tool-err,#be2828\); \}/, '失败工具名必须用 --tool-err')
assert.match(css, /\.term-tool\[data-status="run"\] \.term-tool-name \{ color:var\(--tool-run,#3b82f6\); \}/, '运行中工具名必须用 --tool-run')

console.log('toolConnector 自适应回归测试通过')
