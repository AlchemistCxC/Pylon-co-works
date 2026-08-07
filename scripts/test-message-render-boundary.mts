/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const boundary = readFileSync(new URL('../src/components/chat/MessageRenderBoundary.tsx', import.meta.url), 'utf8')
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')

assert.match(boundary, /extends React\.Component<Props, State>/)
assert.match(boundary, /static getDerivedStateFromError/)
assert.match(boundary, /componentDidCatch\(error: unknown\)/)
assert.match(boundary, /reportRuntimeError\(`渲染消息 \$\{this\.props\.message\.id\}`/)
assert.match(boundary, /消息渲染失败/)
assert.match(chatView, /import \{ MessageRenderBoundary \} from ['"]\.\/MessageRenderBoundary['"]/, 'ChatView 必须接入消息错误边界')
assert.match(chatView, /<MessageRenderBoundary message=\{msg\}>/, 'MessageRow 必须包裹消息错误边界')
assert.match(chatView, /<\/MessageRenderBoundary>/, 'MessageRow 必须闭合消息错误边界')
assert.match(css, /\.term-row-error\s*\{/)

console.log('MessageRenderBoundary 回归测试通过')
