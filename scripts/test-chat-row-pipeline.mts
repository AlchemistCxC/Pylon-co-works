import { strict as assert } from 'node:assert'
import { buildChatRowDescriptors, isToolRenderMessage, resolveRowToolConnectorStatus, resolveRowToolVisualState } from '../src/components/chat/chatRowPipeline.ts'
import { buildMessageLookups } from '../src/components/chat/messageLookups.ts'
import { toRenderMessage, type Message } from '../src/components/chat/messageTypes.ts'

function toolMessage(id: string, status: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'tool', sender: 'tool:Read', content: '', toolName: 'Read', toolInput: '', toolOutput: 'out', toolOutputLines: 1, toolStatus: status, time: 't', ...extra }
}

const user: Message = { id: 'u1', role: 'user', sender: 'local', content: 'hi', time: 't' }
const assistant: Message = { id: 'a1', role: 'assistant', sender: 'peri', content: 'reply', time: 't' }
const reasoning: Message = { id: 'r1', role: 'reasoning', sender: 'peri', content: 'think', time: 't' }
const toolRunning: Message = toolMessage('tool-1', 'in_progress', { running: true })
const toolDone: Message = toolMessage('tool-2', 'completed')

// ── 纯辅助函数 ──
assert.equal(isToolRenderMessage(toRenderMessage(toolRunning)), true)
assert.equal(isToolRenderMessage(toRenderMessage(user)), false)
assert.equal(isToolRenderMessage(undefined), false)
assert.equal(resolveRowToolConnectorStatus(toolDone), 'ok')
assert.equal(resolveRowToolConnectorStatus(user), 'run')

// ── 编排：连续 Tool 连接线 + 视觉状态 + 搜索命中 ──
const messages = [user, reasoning, toolRunning, toolDone, assistant]
const prepared = messages.map(toRenderMessage)
const lookups = buildMessageLookups(messages)
const descs = buildChatRowDescriptors(prepared, lookups, 'a1')

assert.equal(descs.length, 5, '描述符数量 = 消息数')
assert.deepEqual(descs.map(d => d.key), messages.map(m => m.id), 'key = 消息 id（稳定）')
// tool-2 前一行是 tool-1 → 显示连接线，状态取上一个 tool（running）
assert.equal(descs[3].showConnector, true, '连续 Tool 必须渲染连接线')
assert.equal(descs[3].connectorStatus, 'run', '连接线状态取上一个 tool（running）')
assert.equal(descs[3].toolVisualState, 'completed', '当前 tool 视觉状态 = completed')
// tool-1 前一行是 reasoning → 无连接线
assert.equal(descs[2].showConnector, false, '非连续 Tool 不渲染连接线')
// 搜索命中
assert.equal(descs[4].isSearchMatch, true, 'assistant 命中搜索')
assert.equal(descs[0].isSearchMatch, false, 'user 未命中')

// ── 纯函数不变性：同输入同输出（引用相等）──
const again = buildChatRowDescriptors(prepared, lookups, 'a1')
assert.deepEqual(again, descs, '同输入必须产生相同描述符')

// ── 无搜索命中 ──
const noMatch = buildChatRowDescriptors(prepared, lookups, undefined)
assert.equal(noMatch.every(d => d.isSearchMatch === false), true)

console.log('chatRowPipeline 渲染编排回归测试通过')
