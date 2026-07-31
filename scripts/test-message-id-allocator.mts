import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createMessageIdAllocator } from '../src/components/chat/messageIdAllocator.ts'

// 固定时间下连续事件必须唯一：同一毫秒内多个 chunk/event 不再碰撞
const allocator = createMessageIdAllocator()
const ids = new Set<string>()
for (let i = 0; i < 10000; i += 1) {
  ids.add(allocator.next('msg'))
}
assert.equal(ids.size, 10000, '同一 allocator 连续 msg ID 必须全部唯一')

// 不同前缀（user/msg/thought/err/tool-missing）共享同一单调序列，互不冲突
const prefixed = [
  allocator.next('user'),
  allocator.next('thought'),
  allocator.next('err'),
  allocator.next('tool-missing'),
  allocator.next('user'),
]
assert.equal(new Set(prefixed).size, prefixed.length, '跨前缀 ID 必须全部唯一')

// 格式：prefix-序号，符合既有 messageTypes/toolLookups 的 `tool-` 前缀解析约定
assert.match(allocator.next('tool-missing'), /^tool-missing-\d+$/, '缺失 toolCallId 兜底 stub 使用 allocator 序号')
assert.match(allocator.next('msg'), /^msg-\d+$/)

// 两个实例互不影响（每 ChatView 独立 allocator，跨 Sheet 不共享序列）
const other = createMessageIdAllocator()
assert.equal(other.next('msg'), 'msg-1')

// replay 与 live 共用同一 allocator：本地 sequence 单调，两者不可能冲突
const replay = createMessageIdAllocator()
const replayIds = [replay.next('user'), replay.next('msg'), replay.next('thought'), replay.next('tool-missing')]
const liveIds = [replay.next('user'), replay.next('msg'), replay.next('err')]
assert.equal(new Set([...replayIds, ...liveIds]).size, 7, 'replay/live 共享 allocator 不得冲突')

// 接线断言：ChatView 与事件控制器不再用 Date.now() 构造消息 key；tool_call 仍用事件稳定 ID
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const controller = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')
assert.equal(controller.includes("createMessageIdAllocator()"), true, '事件控制器必须拥有自己的 allocator')
assert.equal(chatView.includes("createMessageIdAllocator"), false, 'ChatView 不再直接持有 allocator')
assert.equal(chatView.includes("'msg-' + Date.now()"), false)
assert.equal(chatView.includes("'user-' + Date.now()"), false)
assert.equal(chatView.includes("'thought-' + Date.now()"), false)
assert.equal(chatView.includes("'err-' + Date.now()"), false)
assert.equal(controller.includes("'msg-' + Date.now()"), false)
assert.equal(controller.includes("'user-' + Date.now()"), false)
assert.equal(controller.includes("'thought-' + Date.now()"), false)
assert.equal(controller.includes("'err-' + Date.now()"), false)
assert.equal(controller.includes('`missing-${prev.length}`'), false, '缺失 toolCallId 不得再用数组 index 兜底')
assert.match(controller, /'tool-' \+ \(toolId \|\| messageIds\.next\('tool-missing'\)\)/)
assert.match(chatView, /key=\{renderMessage\.message\.id\}/, 'React key 仍使用 message.id 单一真值')

console.log('messageIdAllocator 回归测试通过')
