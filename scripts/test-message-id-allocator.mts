/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// 阶段 2 收敛：messageIdAllocator 已删除，消息 ID 由 sessionRuntimeStore 的 per-source seq 分配。
// 接线断言：ChatView/controller 不再直接用 Date.now() 构造消息 key；tool_call 仍用事件稳定 ID。
const controller = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/components/chat/sessionRuntimeStore.ts', import.meta.url), 'utf8')
assert.equal(controller.includes('createMessageIdAllocator'), false, '事件控制器不再持有独立 allocator')
assert.match(store, /seq: number/, 'reducer 必须按 source 维护单调 seq')
assert.match(store, /const seq = (?:current|withStart|runtime)\.seq \+ 1/, '消息分配必须消耗 seq')
assert.equal(store.includes('toolId || `tool-missing-${seq}`'), true, '缺失 toolCallId 兜底 stub 使用 seq 序号')
assert.equal(controller.includes("'msg-' + Date.now()"), false)
assert.equal(controller.includes("'user-' + Date.now()"), false)
assert.equal(controller.includes("'thought-' + Date.now()"), false)
assert.equal(controller.includes("'err-' + Date.now()"), false)

console.log('messageIdAllocator 回归测试通过')
