import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')

const connectorBlock = css.match(/\.term-row-tool \+ \.term-row-tool \.term-tool::before \{([\s\S]*?)\n\}/)?.[1]
assert.ok(connectorBlock, '连续 Tool 连接线伪元素必须存在')

// 线长/起点必须随字号（em）、行高（--chat-line-height）与布局 gap 自适应，不得固定像素
assert.match(connectorBlock, /top:\s*calc\(-1 \* var\(--chat-line-height,1\.4\) \* 1em \/ 2 - 2px - var\(--conn-gap, 0px\)\)/, '起点必须按行高/字号/gap 计算')
assert.match(connectorBlock, /height:\s*calc\(var\(--chat-line-height,1\.4\) \* 1em \+ 4px \+ var\(--conn-gap, 0px\)\)/, '线长必须按行高/字号/gap 计算')
assert.match(connectorBlock, /left:\s*calc\(0\.5em - 1px\)/, '指示器中心必须随字号定位')
assert.equal(/\b(?:top|height):\s*(?:-?\d+px|\d+px)\b/.test(connectorBlock), false, '连接线不得再使用固定像素长度')

// claude 布局行间距 1em 必须纳入线长
const claudeRule = css.match(/\.app\[data-message-layout="claude"\] \.term-row-tool \+ \.term-row-tool \.term-tool::before \{([\s\S]*?)\n\}/)?.[1]
assert.ok(claudeRule?.includes('--conn-gap: 1em'), 'claude 布局必须补偿 1em 行间距')

console.log('toolConnector 自适应回归测试通过')
