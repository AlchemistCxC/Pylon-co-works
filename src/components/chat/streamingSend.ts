import { invoke, type Channel } from '@tauri-apps/api/core'
import { createChatClient, type SendMessagePayload } from '../../infrastructure/acp/chatClient.ts'
import { getChatController, type ChatControllerHandle } from './chatEventController.ts'
import { closeStreamChannel, openStreamChannel, type StreamFrame, type StreamFrameHandler } from './streamChannel.ts'

export interface StreamingSendDependencies {
  invoke(command: string, args?: unknown): Promise<unknown>
  open(source: string, handler: StreamFrameHandler): Channel<StreamFrame> | undefined
  close(source: string): void
  controller(): ChatControllerHandle | null
}

const productionDependencies: StreamingSendDependencies = {
  invoke: (command, args) => invoke(command, args as Record<string, unknown> | undefined),
  open: openStreamChannel,
  close: closeStreamChannel,
  controller: getChatController,
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
  const channel = dependencies.open(source, frame => {
    const controller = dependencies.controller()
    if (controller) void controller.handleStreamFrame(frame)
    if (frame.event === 'pylon:done' || frame.event === 'pylon:error') dependencies.close(source)
  })
  const client = createChatClient({ invoke: dependencies.invoke })
  if (!channel) return client.sendMessage(payload)
  return client.sendMessageStreaming(payload, channel).catch(error => {
    dependencies.close(source)
    throw error
  })
}
