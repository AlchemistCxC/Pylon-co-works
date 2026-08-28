import { describe, expect, it } from 'vitest'
import { createMockMessages } from '../chatMockData.ts'
import { buildMessageLookups } from '../messageLookups.ts'
import { buildChatRowDescriptors } from '../chatRowPipeline.ts'
import { toRenderMessage, type Message } from '../messageTypes.ts'
import { resolveRowToolVisualState } from '../chatRowPipeline.ts'

function cancelledMessage(id: string, status: string): Message {
  return {
    id,
    role: 'tool',
    sender: 'tool:Shell',
    content: '',
    toolName: 'Shell',
    toolInput: 'long-running command',
    toolOutput: 'cancelled by user',
    toolOutputLines: 1,
    toolStatus: status,
    time: '10:25',
  }
}

describe('B-18 cancelled tool presentation mapping', () => {
  it('keeps the fixture with output in cancelled state', () => {
    const messages = createMockMessages()
    const target = messages.find(message => message.id === 'mock-tool-cancelled')
    expect(target).toBeDefined()

    const lookups = buildMessageLookups(messages)
    expect(lookups.resolvedToolIds.has(target!.id)).toBe(false)
    expect(resolveRowToolVisualState(target, lookups)).toBe('cancelled')

    const row = buildChatRowDescriptors(messages.map(toRenderMessage), lookups, undefined)
      .find(descriptor => descriptor.key === target!.id)
    expect(row?.toolVisualState).toBe('cancelled')
  })

  it.each(['cancelled', 'canceled'])('keeps %s alias with output out of completed lookup', status => {
    const target = cancelledMessage(`tool-${status}`, status)
    const lookups = buildMessageLookups([target])

    expect(lookups.resolvedToolIds.has(target.id)).toBe(false)
    expect(resolveRowToolVisualState(target, lookups)).toBe('cancelled')
  })
})
