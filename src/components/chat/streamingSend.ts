import { invoke, type Channel } from '@tauri-apps/api/core'
import { createChatClient, type SendMessagePayload } from '../../infrastructure/acp/chatClient.ts'
import { getCanonicalEventFeed, type CanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'
import { closeStreamChannel, openStreamChannel, type StreamFrame, type StreamFrameHandler } from './streamChannel.ts'
import type { PromptFailureMetadata } from '../../infrastructure/acp/chatContracts.ts'
import { presentPromptFailure } from '../../domains/workbench/promptFailurePresentation.ts'

export interface StreamingSendDependencies {
  invoke(command: string, args?: unknown): Promise<unknown>
  open(source: string, handler: StreamFrameHandler): Channel<StreamFrame> | undefined
  close(source: string): void
  /** P52 D2：帧唯一入口 = canonicalEventFeed（canonical 处理后 onForward 回 legacy controller）。 */
  feed(): CanonicalEventFeed
}

/** Error returned when the streaming command rejects after publishing pylon:error. */
export class StreamingPromptFailure extends Error {
  readonly failure?: PromptFailureMetadata
  readonly technicalMessage: string

  constructor(message: string, failure?: PromptFailureMetadata) {
    const presentation = presentPromptFailure(message, failure)
    super(presentation.userSummary)
    this.name = 'StreamingPromptFailure'
    this.failure = failure
    this.technicalMessage = presentation.technicalMessage ?? message
  }

  /** InputBar's legacy String(error) path should show the safe summary only. */
  override toString(): string {
    return this.message
  }
}

const productionDependencies: StreamingSendDependencies = {
  invoke: (command, args) => invoke(command, args as Record<string, unknown> | undefined),
  open: openStreamChannel,
  close: closeStreamChannel,
  feed: getCanonicalEventFeed,
}

/**
 * Single production send seam for both React and Solid workbenches.
 *
 * Desktop sends register a per-session Channel before invoking the prompt. Browser
 * previews (where open returns undefined) retain the legacy command fallback.
 */
export function sendMessageWithStream(
  payload: SendMessagePayload,
  dependencies: StreamingSendDependencies = productionDependencies,
): Promise<unknown> {
  const source = payload.source
  let terminalFailure: { message?: string; failure?: PromptFailureMetadata } | undefined
  const channel = dependencies.open(source, frame => {
    if (frame.event === 'pylon:error' && frame.payload && typeof frame.payload === 'object' && !Array.isArray(frame.payload)) {
      const value = frame.payload as { error?: unknown; failure?: unknown }
      terminalFailure = {
        ...(typeof value.error === 'string' ? { message: value.error } : {}),
        ...(value.failure && typeof value.failure === 'object' && !Array.isArray(value.failure)
          ? { failure: value.failure as PromptFailureMetadata }
          : {}),
      }
    }
    // P52 D2：帧统一投 canonicalEventFeed——cursor/publish 在此发生，
    // legacy controller 经 feed.onForward 消费（kernelCommitted 随帧传递）。
    void dependencies.feed().acceptFrame(frame)
    if (frame.event === 'pylon:done' || frame.event === 'pylon:error') dependencies.close(source)
  })
  const client = createChatClient({ invoke: dependencies.invoke })
  if (!channel) return client.sendMessage(payload)
  return client.sendMessageStreaming(payload, channel).catch(error => {
    dependencies.close(source)
    if (terminalFailure) {
      const message = terminalFailure.message ?? (error instanceof Error ? error.message : String(error))
      throw new StreamingPromptFailure(message, terminalFailure.failure)
    }
    throw error
  })
}
