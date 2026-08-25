import type { Channel } from '@tauri-apps/api/core'
import { describe, expect, it, vi } from 'vitest'
import type { SendMessagePayload } from '../../../infrastructure/acp/chatClient.ts'
import { sendMessageWithStream, type StreamingSendDependencies } from '../streamingSend.ts'
import type { StreamFrame, StreamFrameHandler } from '../streamChannel.ts'

const payload: SendMessagePayload = {
  agentId: 'peri', profileId: 'profile-a', source: 'local:a', content: 'hello',
  persona: '', sessionPrompt: '', attachments: [],
}

describe('sendMessageWithStream', () => {
  it('keeps the production channel alive through user/update and closes only on done', async () => {
    let handler: StreamFrameHandler | undefined
    const fakeChannel = {} as Channel<StreamFrame>
    const invoke = vi.fn(async () => undefined)
    const close = vi.fn()
    const handledEvents: string[] = []
    const handleStreamFrame = vi.fn(async (frame: StreamFrame) => { handledEvents.push(frame.event) })
    const dependencies: StreamingSendDependencies = {
      invoke,
      open: (_source, next) => { handler = next; return fakeChannel },
      close,
      controller: () => ({ handleStreamFrame } as never),
    }

    await sendMessageWithStream(payload, dependencies)
    expect(invoke).toHaveBeenCalledWith('send_message_streaming', expect.objectContaining({
      source: 'local:a', onUpdate: fakeChannel,
    }))

    handler?.({ event: 'pylon:user', payload: { source: 'local:a', content: 'hello' } })
    handler?.({ event: 'pylon:update', payload: { source: 'local:a' } })
    expect(close).not.toHaveBeenCalled()
    handler?.({ event: 'pylon:done', payload: { source: 'local:a' } })
    expect(close).toHaveBeenCalledOnce()
    expect(handledEvents).toEqual([
      'pylon:user', 'pylon:update', 'pylon:done',
    ])
  })

  it('falls back to the legacy command outside Tauri', async () => {
    const invoke = vi.fn(async () => undefined)
    await sendMessageWithStream(payload, {
      invoke, open: () => undefined, close: vi.fn(), controller: () => null,
    })
    expect(invoke).toHaveBeenCalledWith('send_message', payload)
  })
})
