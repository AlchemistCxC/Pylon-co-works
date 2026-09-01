/**
 * B-03：legacy Message projection 的纯语义规则。
 *
 * 这里只描述 canonical event → Message[] 的状态变换，不拥有 load/generation、
 * cancel、usage 或任何 renderer/store/sink 依赖。adapter 通过 `toolInputSummary`
 * 注入工具摘要策略，保证规则本身可在 live、replay、restart 三条路径复用。
 */
import type { Message } from '../../components/chat/messageTypes'
import type { OptionalChatEventIdentity } from '../../infrastructure/acp/chatContracts'
import { resolveChunkAppend } from './chunkMerge.ts'
import type { CanonicalConversationEvent } from './eventSchema.ts'
import { toolFieldsFromCanonical } from './toolProjection.ts'

export interface MessageProjectionState {
  messages: Message[]
  /** user/assistant/reasoning 消息 id 使用的逻辑序号；工具卡不消耗序号。 */
  sequence: number
}

export interface MessageProjectionRulesOptions {
  /** 将 canonical tool input 转成 legacy Message.toolInput 的展示摘要。 */
  toolInputSummary?: (title: string, rawInput: unknown, toolKind?: string) => string
  /** 默认保留既有时间格式；测试或其它 adapter 可注入稳定格式化。 */
  timeFormatter?: (event: CanonicalConversationEvent) => string
}

function textOf(event: CanonicalConversationEvent): string | undefined {
  const payload = event.typedPayload as { text?: string } | undefined
  return typeof payload?.text === 'string' ? payload.text : undefined
}

function identityOf(event: CanonicalConversationEvent): OptionalChatEventIdentity | undefined {
  const identity = event.identity
  if (!identity) return undefined
  const mapped: OptionalChatEventIdentity = {}
  if (identity.messageId !== undefined) mapped.messageId = identity.messageId
  if (identity.turnId !== undefined) mapped.turnId = identity.turnId
  if (identity.toolCallId !== undefined) mapped.toolCallId = identity.toolCallId
  return Object.keys(mapped).length > 0 ? mapped : undefined
}

function timeOf(event: CanonicalConversationEvent): string {
  const value = event.receivedAt ?? event.occurredAt
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleTimeString()
}

/** 终态事件统一清除 running；running tool 没有 status 时补 completed。 */
export function settleMessages(messages: readonly Message[]): Message[] {
  return messages.map(message => {
    if (message.role === 'tool' && message.running) {
      return { ...message, running: false, toolStatus: message.toolStatus || 'completed' }
    }
    return message.running ? { ...message, running: false } : message
  })
}

export function stringifyToolOutput(rawOutput: unknown): string {
  if (typeof rawOutput === 'string') return rawOutput
  const json = JSON.stringify(rawOutput, null, 2)
  return json ?? ''
}

function fallbackToolInput(rawInput: unknown): string {
  return typeof rawInput === 'string' ? rawInput.slice(0, 80) : ''
}

function toolInputSummary(
  title: string,
  rawInput: unknown,
  toolKind: string | undefined,
  options: MessageProjectionRulesOptions,
): string {
  return options.toolInputSummary?.(title, rawInput, toolKind) || fallbackToolInput(rawInput)
}

function appendMessage(
  state: MessageProjectionState,
  message: Message,
  sequence: number = state.sequence,
): MessageProjectionState {
  return {
    messages: [...state.messages, message],
    sequence,
  }
}

/** 对单个 canonical event 应用 Message 语义；unknown/interaction 等事件保持 no-op。 */
export function reduceCanonicalMessageEvent(
  state: MessageProjectionState,
  event: CanonicalConversationEvent,
  options: MessageProjectionRulesOptions = {},
): MessageProjectionState {
  const formatTime = options.timeFormatter ?? timeOf

  switch (event.eventType) {
    case 'user.message': {
      const text = textOf(event)
      if (text === undefined) return state
      const messages = settleMessages(state.messages)
      const sequence = state.sequence + 1
      const identity = identityOf(event)
      return appendMessage({ messages, sequence: state.sequence }, {
        id: `user-${sequence}`,
        role: 'user',
        sender: event.owner.localSessionId,
        content: text,
        time: formatTime(event),
        agentId: event.owner.agentId,
        running: false,
        ...(identity ? { externalIdentity: identity } : {}),
      }, sequence)
    }

    case 'assistant.text.delta':
    case 'assistant.thinking.delta': {
      const text = textOf(event)
      if (text === undefined) return state
      const role = event.eventType === 'assistant.text.delta' ? 'assistant' : 'reasoning'
      const last = state.messages[state.messages.length - 1]
      const identity = identityOf(event)
      const append = resolveChunkAppend({
        lastRole: last?.role,
        incomingRole: role,
        lastIdentity: last?.externalIdentity,
        incomingIdentity: identity,
      })
      if (append.shouldAppend) {
        return {
          ...state,
          messages: state.messages.map((message, index) => index === state.messages.length - 1
            ? { ...message, content: message.content + text, ...(append.identity ? { externalIdentity: append.identity } : {}) }
            : message),
        }
      }
      const sequence = state.sequence + 1
      return appendMessage({ messages: state.messages, sequence: state.sequence }, {
        id: `${role === 'assistant' ? 'msg' : 'thought'}-${sequence}`,
        role,
        sender: 'peri',
        content: text,
        time: formatTime(event),
        running: false,
        agentId: event.owner.agentId,
        ...(identity ? { externalIdentity: identity } : {}),
      }, sequence)
    }

    case 'tool.call.started': {
      const toolCallId = event.identity?.toolCallId
      if (!toolCallId) return state
      const tool = toolFieldsFromCanonical(event)
      const title = tool.title || '?'
      const rawInput = tool.rawInput
      const inputStr = toolInputSummary(title, rawInput, tool.kind, options)
      const existing = state.messages.find(message => message.id === `tool-${toolCallId}`)
      if (existing) {
        return {
          ...state,
          messages: state.messages.map(message => message.id === existing.id ? {
            ...message,
            toolName: title,
            sender: `tool:${title}`,
            toolKind: tool.kind ?? message.toolKind,
            toolInput: inputStr,
            contentBlocks: tool.contentBlocks as Message['contentBlocks'],
            rawInput,
            clientGeneration: event.clientGeneration,
          } : message),
        }
      }
      return appendMessage(state, {
        id: `tool-${toolCallId}`,
        role: 'tool',
        sender: `tool:${title}`,
        content: '',
        time: formatTime(event),
        agentId: event.owner.agentId,
        toolName: title,
        toolInput: inputStr,
        toolKind: tool.kind,
        contentBlocks: tool.contentBlocks as Message['contentBlocks'],
        rawInput,
        clientGeneration: event.clientGeneration,
        running: true,
        externalIdentity: { toolCallId },
      })
    }

    case 'tool.call.updated':
    case 'tool.call.completed':
    case 'tool.call.failed': {
      const toolCallId = event.identity?.toolCallId
      if (!toolCallId) return state
      const tool = toolFieldsFromCanonical(event)
      const outputStr = stringifyToolOutput(tool.rawOutput)
      const lines = outputStr ? outputStr.split(/\n/).filter(line => line.trim()).length : 0
      const existing = state.messages.find(message => message.id === `tool-${toolCallId}`)
      if (!existing) {
        return appendMessage(state, {
          id: `tool-${toolCallId}`,
          role: 'tool',
          sender: 'tool:?',
          content: '',
          time: formatTime(event),
          agentId: event.owner.agentId,
          toolName: '?',
          toolOutput: outputStr,
          toolOutputLines: lines,
          toolKind: tool.kind,
          contentBlocks: tool.contentBlocks as Message['contentBlocks'],
          toolStatus: tool.status,
          rawOutput: tool.rawOutput,
          clientGeneration: event.clientGeneration,
          running: false,
          externalIdentity: { toolCallId },
        })
      }
      return {
        ...state,
        messages: state.messages.map(message => message.id === existing.id ? {
          ...message,
          toolOutput: outputStr,
          toolOutputLines: lines,
          toolStatus: tool.status,
          toolKind: tool.kind ?? message.toolKind,
          contentBlocks: (tool.contentBlocks ?? message.contentBlocks) as Message['contentBlocks'],
          rawOutput: tool.rawOutput !== undefined ? tool.rawOutput : message.rawOutput,
          clientGeneration: event.clientGeneration,
          running: false,
        } : message),
      }
    }

    case 'turn.completed':
    case 'turn.failed':
      return { ...state, messages: settleMessages(state.messages) }

    default:
      return state
  }
}

/** 从已排序/筛选的 canonical stream 生成 legacy Message[]。 */
export function projectCanonicalMessages(
  events: readonly CanonicalConversationEvent[],
  options: MessageProjectionRulesOptions = {},
): Message[] {
  let state: MessageProjectionState = { messages: [], sequence: 0 }
  for (const event of events) state = reduceCanonicalMessageEvent(state, event, options)
  return state.messages
}

function isOptimisticUserEvent(event: CanonicalConversationEvent): boolean {
  if (event.eventType !== 'user.message' || !event.rawPayload || typeof event.rawPayload !== 'object') return false
  const root = event.rawPayload as { update?: unknown; params?: { update?: unknown } }
  const update = root.update ?? root.params?.update
  if (!update || typeof update !== 'object') return false
  const meta = (update as { _meta?: unknown })._meta
  return Boolean(meta && typeof meta === 'object' && (meta as { pylonOptimisticUser?: unknown }).pylonOptimisticUser === true)
}

function userProjectionKey(event: CanonicalConversationEvent): string | undefined {
  if (event.eventType !== 'user.message') return undefined
  const text = (event.typedPayload as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : undefined
}

/** 保留 optimistic 行的原位置，隐藏随后到达的 kernel user echo。 */
export function reconcileOptimisticUserEvents(
  events: readonly CanonicalConversationEvent[],
): CanonicalConversationEvent[] {
  const optimisticCounts = new Map<string, number>()
  for (const event of events) {
    if (!isOptimisticUserEvent(event)) continue
    const key = userProjectionKey(event)
    if (key !== undefined) optimisticCounts.set(key, (optimisticCounts.get(key) ?? 0) + 1)
  }
  return events.filter(event => {
    if (isOptimisticUserEvent(event)) return true
    const key = userProjectionKey(event)
    if (key === undefined) return true
    const count = optimisticCounts.get(key) ?? 0
    if (count <= 0) return true
    optimisticCounts.set(key, count - 1)
    return false
  })
}

