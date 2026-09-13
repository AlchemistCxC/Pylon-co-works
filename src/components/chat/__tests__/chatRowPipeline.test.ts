// 迁移自 scripts/test-chat-row-pipeline.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { buildChatRowDescriptors, isToolRenderMessage, resolveRowToolConnectorStatus } from '../chatRowPipeline.ts'
import { buildMessageLookups } from '../messageLookups.ts'
import { toRenderMessage, type Message } from '../messageTypes.ts'

function toolMessage(id: string, status: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'tool', sender: 'tool:Read', content: '', toolName: 'Read', toolInput: '', toolOutput: 'out', toolOutputLines: 1, toolStatus: status, time: 't', ...extra }
}

const user: Message = { id: 'u1', role: 'user', sender: 'local', content: 'hi', time: 't' }
const assistant: Message = { id: 'a1', role: 'assistant', sender: 'peri', content: 'reply', time: 't' }
const reasoning: Message = { id: 'r1', role: 'reasoning', sender: 'peri', content: 'think', time: 't' }
const toolRunning: Message = toolMessage('tool-1', 'in_progress', { running: true })
const toolDone: Message = toolMessage('tool-2', 'completed')

describe('chatRowPipeline 纯辅助函数', () => {
  it('isToolRenderMessage 只认 tool_call/tool_result 包装', () => {
    expect(isToolRenderMessage(toRenderMessage(toolRunning))).toBe(true)
    expect(isToolRenderMessage(toRenderMessage(user))).toBe(false)
    expect(isToolRenderMessage(undefined)).toBe(false)
  })

  it('resolveRowToolConnectorStatus：completed → ok，非 tool → run', () => {
    expect(resolveRowToolConnectorStatus(toolDone)).toBe('ok')
    expect(resolveRowToolConnectorStatus(user)).toBe('run')
  })
})

describe('chatRowPipeline 编排：连续 Tool 连接线 + 视觉状态 + 搜索命中', () => {
  const messages = [user, reasoning, toolRunning, toolDone, assistant]
  const prepared = messages.map(toRenderMessage)
  const lookups = buildMessageLookups(messages)
  const descs = buildChatRowDescriptors(prepared, lookups, 'a1')

  it('描述符数量 = 消息数，key = 消息 id（稳定）', () => {
    expect(descs.length).toBe(5)
    expect(descs.map(d => d.key)).toEqual(messages.map(m => m.id))
  })

  it('连续 Tool 渲染连接线，状态取上一个 tool，当前 tool 视觉状态独立', () => {
    // tool-2 前一行是 tool-1 → 显示连接线，状态取上一个 tool（running）
    expect(descs[3].showConnector).toBe(true)
    expect(descs[3].connectorStatus).toBe('run')
    expect(descs[3].toolVisualState).toBe('completed')
    // tool-1 前一行是 reasoning → 无连接线
    expect(descs[2].showConnector).toBe(false)
  })

  it('搜索命中只落在命中 id 的行', () => {
    expect(descs[4].isSearchMatch).toBe(true)
    expect(descs[0].isSearchMatch).toBe(false)
  })

  it('纯函数不变性：同输入同输出（深等）', () => {
    const again = buildChatRowDescriptors(prepared, lookups, 'a1')
    expect(again).toEqual(descs)
  })

  it('无搜索命中：所有行 isSearchMatch 为 false', () => {
    const noMatch = buildChatRowDescriptors(prepared, lookups, undefined)
    expect(noMatch.every(d => d.isSearchMatch === false)).toBe(true)
  })
})
