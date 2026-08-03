import type { Message } from './messageTypes.ts'
import { applyCancelEvent, beginCancel, createCancelState, rejectCancelCommand, type CancelState } from './cancelState.ts'
import {
  normalizeToolId,
  resolveReplayEventMode,
  shouldAcceptToolCall,
} from './replayState.ts'
import { getToolSummary } from './toolPresentation.ts'

/**
 * sessionRuntimeStore — Chat 会话运行时状态（阶段 2：Chat 状态收敛）。
 *
 * 目标：把 ChatView/chatEventController 的 10+ useRef 集合收敛为"每 source 一份状态 + 纯 reducer"。
 * 本文件为纯函数层（无 React/zustand 依赖），可直接单测。
 *
 * 语义等价源：chatEventController.ts 的 peri:user / peri:update / peri:done / peri:error
 * 与 ChatView 的 cancel 链路、flushStreaming、clear。
 *
 * 约定：
 * - 本层只负责 chat 域（messages/streaming/generating/cancel/replay/seq/tokenCount/summary）；
 *   usage 的 sessionLiveStats、config/mode 仍由接线层直调主 store action（行为不变路径）。
 * - 副作用（localStorage 写盘、渲染 setState、frames 计算）留在接线层。
 * - 消息目标数组：live 事件写 `messages`；replay/buffer 事件写 `replaying`（与
 *   messagesBySourceRef / replayingSourcesRef 的分离语义一致）。
 */

export interface ChatSummary {
  elapsedMs: number
  tokenCount: number
  reason: 'done' | 'cancelled' | 'error'
}

export interface SourceChatRuntime {
  messages: Message[]
  /** replay 缓冲（loadInProgress 或显式 replay 期间的事件目标） */
  replaying?: Message[]
  streamingText: string
  streamingThinking: string
  thinkingStart?: number
  generating: boolean
  generationStart?: number
  /** 接线层在 user 事件后写入（依赖主题域 spinner 预设） */
  generationFrames: string[]
  cancelState: CancelState
  replayToolIds: string[]
  /** 单调消息 ID 序列（'user-N'/'msg-N'/'thought-N'/'err-N'/'tool-missing-N' 共享） */
  seq: number
  tokenCount: number
  lastSummary?: ChatSummary
}

export type ChatRuntimeState = Record<string, SourceChatRuntime>

export interface ChatRuntimeContext {
  knownSources: readonly string[]
  renderedSource: string | null
  now: number
}

export type ChatEvent =
  | { type: 'user'; source: string; content: string; eventReplay?: boolean; loadInProgress?: boolean }
  | { type: 'message-chunk'; source: string; text: string; replay?: boolean }
  | { type: 'thought-chunk'; source: string; text: string; replay?: boolean }
  | { type: 'tool-call'; source: string; toolCallId?: string; title?: string; rawInput?: unknown; replay?: boolean }
  | { type: 'tool-call-update'; source: string; toolCallId?: string; rawOutput?: unknown; status?: string; replay?: boolean }
  | { type: 'usage-update'; source: string; tokensUsed: number }
  | { type: 'done'; source: string; replay?: boolean; explicitReplay?: boolean }
  | { type: 'error'; source: string; error: string; cancelled?: boolean; replay?: boolean; explicitReplay?: boolean }
  | { type: 'begin-cancel'; source: string }
  | { type: 'cancel-success'; source: string }
  | { type: 'cancel-rejected'; source: string; error: string }
  | { type: 'clear'; source: string }

export function createSourceChatRuntime(source: string): SourceChatRuntime {
  return {
    messages: [],
    replaying: undefined,
    streamingText: '',
    streamingThinking: '',
    thinkingStart: undefined,
    generating: false,
    generationStart: undefined,
    generationFrames: [],
    cancelState: createCancelState(source),
    replayToolIds: [],
    seq: 0,
    tokenCount: 0,
  }
}

export function clearChatSource(state: ChatRuntimeState, source: string): ChatRuntimeState {
  if (!state[source]) return state
  const next = { ...state }
  delete next[source]
  return next
}

function nowTime(now: number): string {
  return new Date(now).toLocaleTimeString()
}

/** 目标数组：live 写 messages，replay 写 replaying（不存在则初始化） */
function targetMessages(runtime: SourceChatRuntime, replay: boolean): { runtime: SourceChatRuntime; messages: Message[] } {
  if (!replay) return { runtime, messages: runtime.messages }
  return { runtime: { ...runtime, replaying: runtime.replaying ?? [] }, messages: runtime.replaying ?? [] }
}

function withMessages(runtime: SourceChatRuntime, replay: boolean, messages: Message[]): SourceChatRuntime {
  return replay ? { ...runtime, replaying: messages } : { ...runtime, messages }
}

function appendMessage(runtime: SourceChatRuntime, replay: boolean, message: Message, seq: number): SourceChatRuntime {
  const { runtime: next, messages } = targetMessages(runtime, replay)
  return withMessages({ ...next, seq }, replay, [...messages, message])
}

function mapMessages(runtime: SourceChatRuntime, replay: boolean, mapper: (m: Message, index: number, arr: Message[]) => Message): SourceChatRuntime {
  const { runtime: next, messages } = targetMessages(runtime, replay)
  return withMessages({ ...next }, replay, messages.map(mapper))
}

/**
 * settle：running 消息收敛（reasoning 补 thoughtDurationMs；tool 补 completed），
 * 语义同 chatEventController::settleMessages + settleReplayToolMessages。
 */
function settleMessages(runtime: SourceChatRuntime, replay: boolean, completedAt: number): SourceChatRuntime {
  return mapMessages(runtime, replay, message => {
    if (message.role === 'reasoning' && message.running) {
      return {
        ...message,
        running: false,
        thoughtDurationMs: message.thoughtStartedAt ? Math.max(0, completedAt - message.thoughtStartedAt) : message.thoughtDurationMs,
      }
    }
    if (message.role === 'tool' && message.running) {
      return { ...message, running: false, toolStatus: message.toolStatus || 'completed' }
    }
    return { ...message, running: false }
  })
}

/**
 * flushStreaming：把 streaming 缓冲落为消息（thought + assistant 各一条，按存在性消耗 seq），
 * 并清空缓冲。语义同 chatEventController::flushStreaming。
 */
function flushStreaming(runtime: SourceChatRuntime, replay: boolean, now: number): SourceChatRuntime {
  const text = runtime.streamingText
  const thinking = runtime.streamingThinking
  const thoughtStartedAt = runtime.thinkingStart
  const thoughtDurationMs = thoughtStartedAt ? Math.max(0, now - thoughtStartedAt) : undefined
  let next = runtime
  let seq = next.seq
  if (thinking) {
    seq += 1
    next = appendMessage(next, replay, {
      id: `thought-${seq}`,
      role: 'reasoning',
      sender: 'peri',
      content: thinking,
      time: nowTime(now),
      running: false,
      thoughtStartedAt,
      thoughtDurationMs,
    }, seq)
  }
  if (text) {
    seq += 1
    next = appendMessage(next, replay, {
      id: `msg-${seq}`,
      role: 'assistant',
      sender: 'peri',
      content: text,
      time: nowTime(now),
      running: false,
    }, seq)
  }
  return {
    ...next,
    seq,
    streamingText: '',
    streamingThinking: '',
    thinkingStart: undefined,
  }
}

function isRenderedSource(source: string, renderedSource: string | null): boolean {
  return source.length > 0 && renderedSource === source
}

/**
 * 纯 reducer：翻译自 chatEventController 的事件处理逻辑。
 * 事件语义与现状一致；不包含 UI 副作用（summary 落进 lastSummary，由接线层映射）。
 */
export function applyChatEvent(
  state: ChatRuntimeState,
  event: ChatEvent,
  context: ChatRuntimeContext,
): ChatRuntimeState {
  const { knownSources, renderedSource, now } = context
  const source = event.source

  if (event.type === 'clear') {
    // 与 peri:clear 现状一致：只清消息与 summary，不动 cancelState/generating/streaming 缓冲
    const existing = state[source]
    if (!existing) return state
    return {
      ...state,
      [source]: { ...existing, messages: [], lastSummary: undefined },
    }
  }
  if (!knownSources.includes(source)) {
    return state
  }

  const current = state[source] ?? createSourceChatRuntime(source)

  switch (event.type) {
    case 'user': {
      const replayMode = resolveReplayEventMode({
        eventReplay: event.eventReplay === true,
        loadInProgress: event.loadInProgress === true,
      })
      const replay = replayMode !== 'live'
      // 与现状一致：新 user 消息前清空所有 running 标记
      const { runtime: target, messages } = targetMessages(current, replay)
      const seq = current.seq + 1
      let runtime = withMessages({ ...target, seq }, replay, [
        ...messages.map(m => ({ ...m, running: false })),
        { id: `user-${seq}`, role: 'user' as const, sender: source, content: event.content, time: nowTime(now) },
      ])
      // shouldStartLiveGeneration({ replay })：buffer/late 模式不启动生成
      if (!replay) {
        runtime = {
          ...runtime,
          generating: true,
          generationStart: now,
          cancelState: { source, status: 'generating' },
        }
      }
      return { ...state, [source]: runtime }
    }

    case 'message-chunk': {
      const text = event.text
      if (!text) return state
      if (!event.replay && isRenderedSource(source, renderedSource)) {
        return { ...state, [source]: { ...current, streamingText: current.streamingText + text } }
      }
      const replay = event.replay === true
      const { messages } = targetMessages(current, replay)
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant' && last.running) {
        return { ...state, [source]: mapMessages(current, replay, (m, i, arr) => i === arr.length - 1 ? { ...m, content: m.content + text } : m) }
      }
      const seq = current.seq + 1
      return { ...state, [source]: appendMessage(current, replay, {
        id: `msg-${seq}`,
        role: 'assistant',
        sender: 'peri',
        content: text,
        time: nowTime(now),
        running: !replay,
      }, seq) }
    }

    case 'thought-chunk': {
      const text = event.text
      if (!text) return state
      // 与现状一致：thinkingStart 无条件记录（rendered 与否）
      const thoughtStartedAt = current.thinkingStart ?? now
      const withStart = { ...current, thinkingStart: thoughtStartedAt }
      if (!event.replay && isRenderedSource(source, renderedSource)) {
        return {
          ...state,
          [source]: { ...withStart, streamingThinking: current.streamingThinking + text },
        }
      }
      const replay = event.replay === true
      const { messages } = targetMessages(withStart, replay)
      const last = messages[messages.length - 1]
      if (last?.role === 'reasoning' && last.running) {
        return {
          ...state,
          [source]: mapMessages(withStart, replay, (m, i, arr) => i === arr.length - 1 ? { ...m, content: m.content + text } : m),
        }
      }
      const seq = withStart.seq + 1
      return { ...state, [source]: appendMessage(withStart, replay, {
        id: `thought-${seq}`,
        role: 'reasoning',
        sender: 'peri',
        content: text,
        time: nowTime(now),
        running: !replay,
        thoughtStartedAt,
      }, seq) }
    }

    case 'tool-call': {
      const replay = event.replay === true
      const toolId = normalizeToolId(event.toolCallId)
      if (replay) {
        if (!toolId || !shouldAcceptToolCall(toolId, current.replayToolIds)) return state
      }
      let runtime = current
      if (!replay) runtime = flushStreaming(runtime, false, now)
      const replayToolIds = replay && toolId ? [...runtime.replayToolIds, toolId] : runtime.replayToolIds
      const title = event.title || '?'
      const rawInput = event.rawInput
      const inputStr = getToolSummary(title, rawInput) || (typeof rawInput === 'string' ? rawInput.slice(0, 80) : '')
      const seq = toolId ? runtime.seq : runtime.seq + 1
      runtime = appendMessage({ ...runtime, replayToolIds }, replay, {
        id: 'tool-' + (toolId || `tool-missing-${seq}`),
        role: 'tool',
        sender: 'tool:' + title,
        content: '',
        time: nowTime(now),
        toolName: title,
        toolInput: inputStr,
        running: true,
      }, seq)
      return { ...state, [source]: runtime }
    }

    case 'tool-call-update': {
      const toolId = normalizeToolId(event.toolCallId)
      if (!toolId) return state
      const rawOutput = event.rawOutput
      const outputStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2)
      const lines = outputStr ? outputStr.split(/\n/).filter((l: string) => l.trim()).length : 0
      const replay = event.replay === true
      return {
        ...state,
        [source]: mapMessages(current, replay, m => m.id === 'tool-' + toolId && m.running
          ? { ...m, toolOutput: outputStr, toolOutputLines: lines, toolStatus: event.status, running: false }
          : m),
      }
    }

    case 'usage-update': {
      return { ...state, [source]: { ...current, tokenCount: event.tokensUsed } }
    }

    case 'done': {
      const replay = current.replaying !== undefined
      const terminationScope = replay || event.explicitReplay === true ? 'replay' : 'live'
      let runtime = settleMessages(current, replay, now)
      // 有流式缓冲（live 作用域，或 replay/live 交错时 load 期间已发消息）都要落盘
      if (terminationScope === 'live' || runtime.streamingText || runtime.streamingThinking) {
        runtime = flushStreaming(runtime, false, now)
      }
      // 终态收敛：无论作用域都复位 generating（replay/live 交错时 user 事件先置 true、
      // replay 作用域 done 不收敛会导致 spinner 常转）；summary 仅 live 作用域写
      runtime = {
        ...runtime,
        generating: false,
        generationStart: undefined,
        ...(terminationScope === 'live' ? {
          lastSummary: {
            elapsedMs: now - (current.generationStart ?? now),
            tokenCount: current.tokenCount,
            reason: 'done',
          },
        } : {}),
      }
      return { ...state, [source]: runtime }
    }

    case 'error': {
      const replay = current.replaying !== undefined
      const terminationScope = replay || event.explicitReplay === true ? 'replay' : 'live'
      let runtime = settleMessages(current, replay, now)
      runtime = {
        ...runtime,
        cancelState: terminationScope === 'live'
          ? applyCancelEvent(
              source,
              event.cancelled === true ? { kind: 'success' } : { kind: 'error', error: event.error },
              current.cancelState,
            )
          : runtime.cancelState,
      }
      // 与现状一致：streaming 落盘在 error 消息之前。cancellationFailed（cancel 在途但
      // cancelled!=true）也在此收敛：applyCancelEvent(error) 已把 cancelState 弹回
      // generating，后续 cancel-success/rejected 全部 no-op，若不收敛 generating 永不复位
      if (terminationScope === 'live') {
        runtime = flushStreaming(runtime, false, now)
      }
      const seq = runtime.seq + 1
      runtime = appendMessage(runtime, replay, {
        id: `err-${seq}`,
        role: 'assistant',
        sender: 'system',
        content: event.error,
        time: nowTime(now),
      }, seq)
      // 终态收敛：无论作用域都复位 generating（同 done 的交错防护）
      runtime = {
        ...runtime,
        generating: false,
        generationStart: undefined,
        ...(terminationScope === 'live' ? {
          lastSummary: {
            elapsedMs: now - (current.generationStart ?? now),
            tokenCount: current.tokenCount,
            reason: event.cancelled === true ? 'cancelled' : 'error',
          },
        } : {}),
      }
      return { ...state, [source]: runtime }
    }

    case 'begin-cancel': {
      const begun = beginCancel(source, current.cancelState)
      if (!begun.shouldInvoke) return state
      return { ...state, [source]: { ...current, cancelState: begun.state } }
    }

    case 'cancel-success': {
      if (current.cancelState.status !== 'canceling') return state
      let runtime = flushStreaming(current, false, now)
      runtime = {
        ...runtime,
        cancelState: applyCancelEvent(source, { kind: 'success' }, current.cancelState),
        generating: false,
        generationStart: undefined,
        lastSummary: {
          elapsedMs: now - (current.generationStart ?? now),
          tokenCount: current.tokenCount,
          reason: 'cancelled',
        },
      }
      return { ...state, [source]: runtime }
    }

    case 'cancel-rejected': {
      if (current.cancelState.status !== 'canceling') return state
      return {
        ...state,
        [source]: { ...current, cancelState: rejectCancelCommand(source, current.cancelState, new Error(event.error)) },
      }
    }

    default:
      return state
  }
}
