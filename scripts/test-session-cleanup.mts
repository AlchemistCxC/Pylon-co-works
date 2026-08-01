import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// 阶段 2 收敛：clearChatSourceRefs/sessionCleanup 已删除（controller.pruneSources 取代）。
// 接线断言：ChatView 统一走 controller.pruneSources，controller 内部按 sessions source 集合清理。
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const controller = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')
assert.match(chatView, /pruneSources\(activeSources\)/, 'ChatView 必须调用统一 source 清理入口')
assert.match(chatView, /const activeSources = sessions\.map\(session => session\.source\)/, '清理必须以当前 sessions source 集合为准')
assert.match(controller, /pruneSources = \(activeSources: readonly string\[\]\) => \{/, 'controller 必须提供按 source 集合清理')
assert.match(controller, /const active = new Set\(activeSources\)/, '清理必须以 sessions source 集合为准')
assert.match(controller, /if \(active\.has\(source\)\) next\[source\] = runtime/, '活跃 source 状态必须保留')
assert.equal(chatView.includes('clearChatSourceRefs'), false, 'ChatView 不得再手工清 refs 集合')

console.log('session cleanup regression tests passed')
