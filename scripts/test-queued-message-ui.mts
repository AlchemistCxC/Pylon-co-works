/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/InputBar.css', import.meta.url), 'utf8')

assert.match(source, /interface QueuedMessage/)
assert.match(source, /if \(generating\) \{\s*enqueue\(text\)/)
assert.match(source, /sendQueued/)
assert.match(source, /编辑待发送消息/)
assert.match(source, /取消待发送消息/)
assert.match(source, /清空队列/)
assert.match(css, /\.queued-message-list/)

console.log('queued message UI 接线回归测试通过')