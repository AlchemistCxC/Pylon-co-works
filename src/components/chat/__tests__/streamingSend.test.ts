import type { Channel } from '@tauri-apps/api/core'
import { describe, expect, it, vi } from 'vitest'
import type { SendMessagePayload } from '../../../infrastructure/acp/chatClient.ts'
import { sendMessageWithStream, StreamingPromptFailure, type StreamingSendDependencies } from '../streamingSend.ts'
import type { StreamFrame, StreamFrameHandler } from '../streamChannel.ts'
import type { CanonicalEventFeed } from '../../../infrastructure/events/canonicalEventFeed.ts'

const payload: SendMessagePayload = {
  agentId: 'peri', profileId: 'profile-a', source: 'local:a', content: 'hello',
  persona: '', sessionPrompt: '', attachments: [],
}

function fakeFeed(events: string[]): CanonicalEventFeed {
  return {
    acceptFrame: async (frame: StreamFrame) => { events.push(frame.event) },
  } as unknown as CanonicalEventFeed
}

describe('sendMessageWithStream', () => {
  it('routes every channel frame into the canonical feed and closes only on done', async () => {
    let handler: StreamFrameHandler | undefined
    const fakeChannel = {} as Channel<StreamFrame>
    const invoke = vi.fn(async () => undefined)
    const close = vi.fn()
    const acceptedEvents: string[] = []
    const feed = vi.fn(() => fakeFeed(acceptedEvents))
    const dependencies: StreamingSendDependencies = {
      invoke,
      open: (_source, next) => { handler = next; return fakeChannel },
      close,
      feed,
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
    // P52 D2：帧唯一入口是 canonicalEventFeed（cursor/publish 后才转发 legacy 面）
    expect(acceptedEvents).toEqual([
      'pylon:user', 'pylon:update', 'pylon:done',
    ])
  })

  it('falls back to the legacy command outside Tauri', async () => {
    const invoke = vi.fn(async () => undefined)
    await sendMessageWithStream(payload, {
      invoke, open: () => undefined, close: vi.fn(), feed: () => fakeFeed([]),
    })
    expect(invoke).toHaveBeenCalledWith('send_message', payload)
  })

  it('preserves terminal failure provenance when the streaming command rejects after pylon:error', async () => {
    let handler: StreamFrameHandler | undefined
    const raw = 'ACP protocol: timed out after 180s (provider error)'
    const failure = {
      source: 'provider', configuredTimeoutSecs: 180, actualElapsedMs: 24_000,
      providerMessage: raw,
    } as const
    const dependencies: StreamingSendDependencies = {
      invoke: vi.fn(async () => {
        handler?.({ event: 'pylon:error', payload: { source: payload.source, error: raw, failure } })
        throw new Error(raw)
      }),
      open: (_source, next) => { handler = next; return {} as Channel<StreamFrame> },
      close: vi.fn(),
      feed: () => fakeFeed([]),
    }

    const error = await sendMessageWithStream(payload, dependencies).catch(value => value)
    expect(error).toBeInstanceOf(StreamingPromptFailure)
    expect(error).toMatchObject({ message: 'Provider 返回错误', failure })
    expect(String(error)).toBe('Provider 返回错误')
    expect((error as StreamingPromptFailure).technicalMessage).toBe(raw)
  })
})
