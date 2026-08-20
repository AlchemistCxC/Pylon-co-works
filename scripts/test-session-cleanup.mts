/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// 阶段 2 收敛：clearChatSourceRefs/sessionCleanup 已删除（controller.pruneSources 取代）。
// 接线断言：ChatView 统一走 controller.pruneSources，controller 内部按 sessions source 集合清理。
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const lifecycleHook = readFileSync(new URL('../src/components/chat/useSessionLifecycle.ts', import.meta.url), 'utf8')
const controller = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')
assert.match(lifecycleHook, /pruneSources\(activeSources\)/, 'hook 必须调用统一 source 清理入口')
assert.match(lifecycleHook, /const activeSources = sessions\.map\(session => session\.source\)/, '清理必须以当前 sessions source 集合为准')
assert.match(controller, /pruneSources = \(activeSources: readonly string\[\]\) => \{/, 'controller 必须提供按 source 集合清理')
assert.match(controller, /const activeKeys = new Set<AgentContextKey>\(\)/, '清理必须按 AgentContextKey 集合（I01-W2）')
assert.match(controller, /activeKeys\.has\(key as AgentContextKey\)/, '活跃 context 判定必须按 key 集合')
assert.match(controller, /next\[key\] = runtime/, '活跃 context 状态必须保留')
assert.equal(lifecycleHook.includes('clearChatSourceRefs'), false, 'ChatView 不得再手工清 refs 集合')

console.log('session cleanup regression tests passed')
