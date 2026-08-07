/**
 * chatClient — 聊天域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * send_message / approve_tool_call / set_config_option / set_mode 的
 * command/payload 收口；不吞业务错误。
 */
import { ClientTransport } from './agentClient'

export interface SendMessagePayload {
  source: string
  content: string
  persona: string
  sessionPrompt: string
  attachments: string[]
}

export function createChatClient(transport: ClientTransport) {
  return {
    sendMessage: (payload: SendMessagePayload): Promise<unknown> => transport.invoke('send_message', payload),
    cancelPrompt: (source: string): Promise<unknown> => transport.invoke('cancel_prompt', { source }),
    approveToolCall: (payload: Record<string, unknown>): Promise<unknown> => transport.invoke('approve_tool_call', payload),
    setConfigOption: (payload: Record<string, unknown>): Promise<unknown> => transport.invoke('set_config_option', payload),
    setMode: (payload: Record<string, unknown>): Promise<unknown> => transport.invoke('set_mode', payload),
  }
}

export type ChatClient = ReturnType<typeof createChatClient>
