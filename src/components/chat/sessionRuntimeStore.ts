import type { Message } from './messageTypes.ts'
import { applyCancelEvent, beginCancel, createCancelState, rejectCancelCommand, type CancelState } from './cancelState.ts'
import {
  normalizeToolId,
  shouldAcceptToolCall,
} from './replayState.ts'
import { getToolSummary } from '../../domains/tool/toolPresentation.ts'
import { resolveChunkAppend } from '../../domains/events/chunkMerge.ts'
import { applyPlanEntries } from '../../domains/tasks/taskStatusMachine.ts'
import type { PlanEntry } from '../../domains/tasks/planTypes.ts'
import type { ContentBlock, OptionalChatEventIdentity } from '../../infrastructure/acp/chatContracts.ts'
import type { AgentContextKey } from '../../agentContext.ts'
import { toAgentContextKey } from '../../agentContext.ts'
import type { GenerationPhase } from '../../domains/workbench/generationFooterContracts.ts'

/**
 * sessionRuntimeStore — Chat 会话运行时状态（阶段 2：Chat 状态收敛）。
 *
 * 目标：把 ChatView/chatEventController 的 10+ useRef 集合收敛为"每 source 一份状态 + 纯 reducer"。
 * 本文件为纯函数层（无 React/zustand 依赖），可直接单测。
 *
 * 语义等价源：chatEventController.ts 的 pylon:user / pylon:update / pylon:done / pylon:error
 * 与 ChatView 的 cancel 链路、flushStreaming、clear。
 *
 * 约定：
 * - 本层只负责 chat 域（messages/streaming/generating/cancel/replay/seq/tokenCount/summary）；
 *   usage 的 sessionLiveStats、config/mode 仍由接线层直调主 store action（行为不变路径）。
 * - 副作用（localStorage 写盘、渲染 setState、frames 计算）留在接线层。
 * - 消息目标数组：live 与 replay 事件统一写 `messages`（U2-C 单一路径）。
 *   replay 语义由事件标志承载；`commitReplaySnapshot` 在隔离 runtime 内重放后原子替换。
 */

export interface ChatSummary {
  elapsedMs: number
  tokenCount: number
  reason: 'done' | 'cancelled' | 'error'
}

export interface SourceChatRuntime {
  messages: Message[]
  streamingText: string
  streamingThinking: string
  streamingIdentity?: OptionalChatEventIdentity
  thinkingStart?: number
  generating: boolean
  generationStart?: number
  lastActivityAt?: number
  generationPhase?: GenerationPhase
  /** 接线层在 user 事件后写入（依赖主题域 spinner 预设） */
  generationFrames: string[]
  cancelState: CancelState
  replayToolIds: string[]
  /** 单调消息 ID 序列（'user-N'/'msg-N'/'thought-N'/'err-N'/'tool-missing-N' 共享） */
  seq: number
  /** load 开始时已有消息 ID 集合。commit 只允许合并本轮之后新增的 live 消息，
   * 不再依赖数字 seq，也不会把已有缓存/上轮 replay 重新拼回权威 snapshot。 */
  loadBaseMessageIds?: string[]
  /** base 是否来自本地缓存快照（true）还是内存态（false）。空 replay 时据此决定
   * 是清空陈旧缓存，还是保留 in-flight 内存态。 */
  loadBaseFromCache?: boolean
  /** base 是否来自 canonical 首屏占位（true）。canonical 是唯一历史权威，
   * 此时 replay 只补 config，不覆盖消息内容。 */
  loadBaseFromCanonical?: boolean
  tokenCount: number
  lastSummary?: ChatSummary
  /** P1-04：plan 任务快照（横向，不持久化；D1 全量替换，D4 会话生命周期） */
  planEntries: PlanEntry[]
}

export type ChatRuntimeState = Record<string, SourceChatRuntime>

export interface ChatRuntimeContext {
  knownSources: readonly string[]
  renderedSource: string | null
  now: number
}

export type ChatEvent =
  | { type: 'user'; source: string; agentId?: string; content: string; eventReplay?: boolean; externalIdentity?: OptionalChatEventIdentity }
  | { type: 'optimistic-user'; source: string; agentId?: string; content: string; clientMsgId: string }
  | { type: 'confirm-user'; source: string; agentId?: string; clientMsgId: string }
  | { type: 'reject-optimistic-user'; source: string; agentId?: string; clientMsgId: string }
  | { type: 'message-chunk'; source: string; agentId?: string; text: string; replay?: boolean; externalIdentity?: OptionalChatEventIdentity }
  | { type: 'thought-chunk'; source: string; agentId?: string; text: string; replay?: boolean; externalIdentity?: OptionalChatEventIdentity }
  | { type: 'tool-call'; source: string; agentId?: string; toolCallId?: string; title?: string; toolKind?: string; contentBlocks?: ContentBlock[]; rawInput?: unknown; clientGeneration?: number; replay?: boolean }
  | { type: 'tool-call-update'; source: string; agentId?: string; toolCallId?: string; toolKind?: string; contentBlocks?: ContentBlock[]; rawOutput?: unknown; status?: string; clientGeneration?: number; replay?: boolean }
  | { type: 'usage-update'; source: string; agentId?: string; tokensUsed: number }
  | { type: 'done'; source: string; agentId?: string; replay?: boolean; explicitReplay?: boolean }
  | { type: 'error'; source: string; agentId?: string; error: string; cancelled?: boolean; replay?: boolean; explicitReplay?: boolean }
  | { type: 'begin-cancel'; source: string; agentId?: string }
  | { type: 'cancel-success'; source: string; agentId?: string }
  | { type: 'cancel-rejected'; source: string; agentId?: string; error: string }
  | { type: 'plan'; source: string; agentId?: string; entries: unknown; replay?: boolean }
  | { type: 'clear'; source: string; agentId?: string }

export function createSourceChatRuntime(source: string): SourceChatRuntime {
  return {
    messages: [],
    streamingText: '',
    streamingThinking: '',
    streamingIdentity: undefined,
    thinkingStart: undefined,
    generating: false,
    generationStart: undefined,
    lastActivityAt: undefined,
    generationPhase: undefined,
    generationFrames: [],
    cancelState: createCancelState(source),
    replayToolIds: [],
    seq: 0,
    tokenCount: 0,
    planEntries: [],
  }
}

export function clearChatSource(state: ChatRuntimeState, key: AgentContextKey): ChatRuntimeState {
  if (!state[key]) return state
  const next = { ...state }
  delete next[key]
  return next
}

function nowTime(now: number): string {
  return new Date(now).toLocaleTimeString()
}

function appendMessage(runtime: SourceChatRuntime, message: Message, seq: number): SourceChatRuntime {
  return { ...runtime, seq, messages: [...runtime.messages, message] }
}

function mapMessages(runtime: SourceChatRuntime, mapper: (m: Message, index: number, arr: Message[]) => Message): SourceChatRuntime {
  return { ...runtime, messages: runtime.messages.map(mapper) }
}

/**
 * Copy-on-write update for a known message position.  Streaming chunks and
 * tool updates already locate their target (the tail or a unique tool id), so
 * mapping the whole history needlessly invokes a callback for every message
 * on each event.  The array is still copied to preserve reducer immutability,
 * but untouched message references remain stable for memoized rows.
 */
function updateMessageAt(
  runtime: SourceChatRuntime,
  index: number,
  mapper: (message: Message) => Message,
): SourceChatRuntime {
  if (index < 0 || index >= runtime.messages.length) return runtime
  const messages = runtime.messages.slice()
  messages[index] = mapper(messages[index])
  return { ...runtime, messages }
}

function updateLastMessage(
  runtime: SourceChatRuntime,
  mapper: (message: Message) => Message,
): SourceChatRuntime {
  return updateMessageAt(runtime, runtime.messages.length - 1, mapper)
}

/**
 * settle：running 消息收敛（reasoning 补 thoughtDurationMs；tool 补 completed），
 * 语义同 chatEventController::settleMessages（tool/reasoning 终态收敛）。
 * U2-C：live/replay 统一 settle `messages`。
 */
function settleMessages(runtime: SourceChatRuntime, completedAt: number): SourceChatRuntime {
  return mapMessages(runtime, message => {
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
function flushStreaming(runtime: SourceChatRuntime, now: number, agentId: string): SourceChatRuntime {
  const text = runtime.streamingText
  const thinking = runtime.streamingThinking
  const thoughtStartedAt = runtime.thinkingStart
  const thoughtDurationMs = thoughtStartedAt ? Math.max(0, now - thoughtStartedAt) : undefined
  let next = runtime
  let seq = next.seq
  if (thinking) {
    seq += 1
    next = appendMessage(next, {
      id: `thought-${seq}`,
      role: 'reasoning',
      sender: 'peri',
      content: thinking,
      time: nowTime(now),
      running: false,
      thoughtStartedAt,
      thoughtDurationMs,
      externalIdentity: runtime.streamingIdentity,
      agentId,
    }, seq)
  }
  if (text) {
    // 双路径修复：非 rendered 期间 message-chunk 已直写为 assistant 消息，
    // 缓冲文本并入该消息而不是新建——否则生成中切走 source 会把同一回复拆成两条。
    // 仅按 role 判定：flush 前 settleMessages 已清 running，且"末条 assistant + 有缓冲"
    // 只可能来自当前生成的直写续段（完成态 assistant 的缓冲必为空）
    const last = next.messages.at(-1)
    if (last?.role === 'assistant') {
      next = updateLastMessage(next, message => message.role === 'assistant'
        ? { ...message, content: message.content + text, running: false }
        : message)
    } else {
      seq += 1
      next = appendMessage(next, {
        id: `msg-${seq}`,
        role: 'assistant',
        sender: 'peri',
        content: text,
        time: nowTime(now),
        running: false,
        externalIdentity: runtime.streamingIdentity,
        agentId,
      }, seq)
    }
  }
  return {
    ...next,
    seq,
    streamingText: '',
    streamingThinking: '',
    streamingIdentity: undefined,
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
  // I01-W2：reducer 状态按 AgentContextKey（agentId+source）隔离；agentId 由接线层
  // dispatch 解析填充（缺失时以空串兜底——真实 agentId 恒非空，不与他键冲突）。
  // P0-2：agentId 一并落到构造的 Message，供 Tool render 解析 provider（旧消息回退名称解析）。
  const agentId = event.agentId ?? ''
  const key = toAgentContextKey({ agentId, source })

  if (event.type === 'clear') {
    // 与 peri:clear 现状一致：只清消息、summary 与 planEntries（D4 同生命周期），
    // 不动 cancelState/generating/streaming 缓冲
    const existing = state[key]
    if (!existing) return state
    return {
      ...state,
      [key]: { ...existing, messages: [], lastSummary: undefined, planEntries: [] },
    }
  }
  if (!knownSources.includes(source)) {
    return state
  }

  const current = state[key] ?? createSourceChatRuntime(source)
  const touch = (runtime: SourceChatRuntime, phase: GenerationPhase, replay = false): SourceChatRuntime => replay
    ? runtime
    : { ...runtime, lastActivityAt: now, generationPhase: phase }

  switch (event.type) {
    case 'user':
    case 'optimistic-user': {
      // U2-C：replay user 也写 messages（隔离 replay runtime 内）；事件标志只控制
      // 是否启动 live generating。
      const replay = event.type === 'user' && event.eventReplay === true
      // 与现状一致：新 user 消息前清空所有 running 标记
      const messages = current.messages
      const seq = current.seq + 1
      const optimistic = event.type === 'optimistic-user'
      // 乐观消息去重（方案 B）：若末尾已存在同 clientMsgId 的 user 消息（如
      // 迟到 pylon:user 又触发一次），直接返回不重复追加。
      if (optimistic && messages.some(m => m.role === 'user' && m.clientMsgId === event.clientMsgId)) {
        return state
      }
      let runtime: SourceChatRuntime = {
        ...current,
        seq,
        messages: [
          ...messages.map(m => ({ ...m, running: false })),
          {
            id: `user-${seq}`,
            role: 'user' as const,
            sender: source,
            content: event.content,
            time: nowTime(now),
            agentId,
            ...(optimistic ? { clientMsgId: event.clientMsgId } : {}),
            ...(event.type === 'user' && event.externalIdentity ? { externalIdentity: event.externalIdentity } : {}),
          },
        ],
      }
      if (!replay) {
        runtime = {
          ...runtime,
          generating: true,
          generationStart: now,
          lastActivityAt: now,
          generationPhase: { kind: 'thinking' },
          cancelState: { source, status: 'generating' },
        }
      }
      return { ...state, [key]: runtime }
    }

    case 'confirm-user': {
      // 后端 pylon:user 已到：按 clientMsgId 确认乐观消息（清除 clientMsgId，
      // 使其成为普通持久化消息）。找不到匹配（已被 clear/切换）则无操作。
      const matched = current.messages.some(
        m => m.role === 'user' && m.clientMsgId === event.clientMsgId,
      )
      if (!matched) return state
      return {
        ...state,
        [key]: mapMessages(current, m =>
          m.role === 'user' && m.clientMsgId === event.clientMsgId
            ? { ...m, clientMsgId: undefined }
            : m,
        ),
      }
    }

    case 'reject-optimistic-user': {
      const matched = current.messages.some(
        message => message.role === 'user' && message.clientMsgId === event.clientMsgId,
      )
      if (!matched) return state
      const messages = current.messages.filter(
        message => !(message.role === 'user' && message.clientMsgId === event.clientMsgId),
      )
      const hasInFlight = messages.some(message => message.clientMsgId !== undefined || message.running)
        || current.streamingText.length > 0
        || current.streamingThinking.length > 0
      return {
        ...state,
        [key]: {
          ...current,
          messages,
          generating: hasInFlight,
          generationStart: hasInFlight ? current.generationStart : undefined,
          generationPhase: hasInFlight ? current.generationPhase ?? { kind: 'thinking' } : undefined,
          cancelState: hasInFlight ? current.cancelState : createCancelState(source),
        },
      }
    }

    case 'message-chunk': {
      const text = event.text
      if (!text) return state
      if (!event.replay && isRenderedSource(source, renderedSource)) {
        return { ...state, [key]: touch({ ...current, streamingText: current.streamingText + text, streamingIdentity: event.externalIdentity ?? current.streamingIdentity }, { kind: 'responding' }) }
      }
      const replay = event.replay === true
      const messages = current.messages
      const last = messages[messages.length - 1]
      // 三路径投影深等：replay chunk 与 live flush / canonical projection 共用
      // 同一聚合判据——同角色即同一段流，identity 取最后出现者。
      const append = resolveChunkAppend({
        lastRole: last?.role,
        incomingRole: 'assistant',
        lastIdentity: last?.externalIdentity,
        incomingIdentity: event.externalIdentity,
      })
      const replayAppend = replay && last?.sender !== 'system' && append.shouldAppend
      if (last?.role === 'assistant' && (last.running || replayAppend)) {
        return {
          ...state,
          [key]: touch(updateLastMessage(current, message => ({
            ...message,
            content: message.content + text,
            ...(append.identity ? { externalIdentity: append.identity } : {}),
          })), { kind: 'responding' }, replay),
        }
      }
      const seq = current.seq + 1
      return { ...state, [key]: touch(appendMessage(current, {
        id: `msg-${seq}`,
        role: 'assistant',
        sender: 'peri',
        content: text,
        time: nowTime(now),
        running: !replay,
        externalIdentity: event.externalIdentity,
        agentId,
      }, seq), { kind: 'responding' }, replay) }
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
          [key]: touch({ ...withStart, streamingThinking: current.streamingThinking + text, streamingIdentity: event.externalIdentity ?? current.streamingIdentity }, { kind: 'thinking' }),
        }
      }
      const replay = event.replay === true
      const messages = withStart.messages
      const last = messages[messages.length - 1]
      // 三路径投影深等：与 message-chunk 同判据（见上方注释）。
      const append = resolveChunkAppend({
        lastRole: last?.role,
        incomingRole: 'reasoning',
        lastIdentity: last?.externalIdentity,
        incomingIdentity: event.externalIdentity,
      })
      const replayAppend = replay && append.shouldAppend
      if (last?.role === 'reasoning' && (last.running || replayAppend)) {
        return {
          ...state,
          [key]: touch(updateLastMessage(withStart, message => ({
            ...message,
            content: message.content + text,
            ...(append.identity ? { externalIdentity: append.identity } : {}),
          })), { kind: 'thinking' }, replay),
        }
      }
      const seq = withStart.seq + 1
      return { ...state, [key]: touch(appendMessage(withStart, {
        id: `thought-${seq}`,
        role: 'reasoning',
        sender: 'peri',
        content: text,
        time: nowTime(now),
        running: !replay,
        thoughtStartedAt,
        externalIdentity: event.externalIdentity,
        agentId,
      }, seq), { kind: 'thinking' }, replay) }
    }

    case 'tool-call': {
      const replay = event.replay === true
      const toolId = normalizeToolId(event.toolCallId)
      const target = current.messages
      const existingToolIndex = toolId
        ? target.findIndex(message => message.id === 'tool-' + toolId)
        : -1
      const existingTool = existingToolIndex >= 0 ? target[existingToolIndex] : undefined
      if (existingTool) {
        return {
          ...state,
          [key]: touch(updateMessageAt(current, existingToolIndex, message => ({
            ...message,
            toolName: event.title || message.toolName,
            sender: event.title ? 'tool:' + event.title : message.sender,
            toolKind: event.toolKind ?? message.toolKind,
            toolInput: event.rawInput === undefined
              ? message.toolInput
              : getToolSummary(event.title || message.toolName || '?', event.rawInput) || (typeof event.rawInput === 'string' ? event.rawInput.slice(0, 80) : message.toolInput),
            contentBlocks: event.contentBlocks ?? message.contentBlocks,
            // EVT-04：raw 字段不丢——re-dispatch 以新 rawInput 覆盖，缺失保留旧值
            rawInput: event.rawInput !== undefined ? event.rawInput : message.rawInput,
            clientGeneration: event.clientGeneration ?? message.clientGeneration,
          })), { kind: 'tool', name: event.title || existingTool.toolName || '?' }, replay),
        }
      }
      if (replay) {
        if (!toolId || !shouldAcceptToolCall(toolId, current.replayToolIds)) return state
      }
      let runtime = current
      if (!replay) runtime = flushStreaming(runtime, now, agentId)
      const replayToolIds = replay && toolId ? [...runtime.replayToolIds, toolId] : runtime.replayToolIds
      const title = event.title || '?'
      const rawInput = event.rawInput
      const inputStr = getToolSummary(title, rawInput) || (typeof rawInput === 'string' ? rawInput.slice(0, 80) : '')
      const seq = toolId ? runtime.seq : runtime.seq + 1
      runtime = appendMessage({ ...runtime, replayToolIds }, {
        id: 'tool-' + (toolId || `tool-missing-${seq}`),
        role: 'tool',
        sender: 'tool:' + title,
        content: '',
        time: nowTime(now),
        agentId,
        toolName: title,
        toolInput: inputStr,
        toolKind: event.toolKind,
        contentBlocks: event.contentBlocks,
        // EVT-04：raw 字段不丢（§5.11——ToolProjection 深等所需）
        rawInput: event.rawInput,
        clientGeneration: event.clientGeneration,
        running: true,
        externalIdentity: toolId ? { toolCallId: toolId } : undefined,
      }, seq)
      return { ...state, [key]: touch(runtime, { kind: 'tool', name: title }, replay) }
    }

    case 'tool-call-update': {
      const toolId = normalizeToolId(event.toolCallId)
      if (!toolId) return state
      const rawOutput = event.rawOutput
      const outputStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2)
      const lines = outputStr ? outputStr.split(/\n/).filter((l: string) => l.trim()).length : 0
      const replay = event.replay === true
      const target = current.messages
      const toolIndex = target.findIndex(message => message.id === 'tool-' + toolId)
      if (toolIndex < 0) {
        const seq = current.seq + 1
        return {
          ...state,
          [key]: touch(appendMessage({
            ...current,
            replayToolIds: replay && !current.replayToolIds.includes(toolId)
              ? [...current.replayToolIds, toolId]
              : current.replayToolIds,
          }, {
            id: 'tool-' + toolId,
            role: 'tool',
            sender: 'tool:?',
            content: '',
            time: nowTime(now),
            agentId,
            toolName: '?',
            toolOutput: outputStr,
            toolOutputLines: lines,
            toolKind: event.toolKind,
            contentBlocks: event.contentBlocks,
            toolStatus: event.status,
            // EVT-04：raw 字段不丢（§5.11）
            rawOutput: event.rawOutput,
            clientGeneration: event.clientGeneration,
            running: false,
            externalIdentity: { toolCallId: toolId },
          }, seq), { kind: 'tool', name: '?' }, replay),
        }
      }
      const existingTool = target[toolIndex]
      return {
        ...state,
        [key]: touch(updateMessageAt(current, toolIndex, message => ({
          ...message,
          toolOutput: outputStr,
          toolOutputLines: lines,
          toolStatus: event.status,
          toolKind: event.toolKind ?? message.toolKind,
          contentBlocks: event.contentBlocks ?? message.contentBlocks,
          // EVT-04：raw 字段不丢——缺失保留旧值，避免以 undefined 覆盖已完成调用
          rawOutput: event.rawOutput !== undefined ? event.rawOutput : message.rawOutput,
          clientGeneration: event.clientGeneration ?? message.clientGeneration,
          running: false,
        })), { kind: 'tool', name: existingTool.toolName || '?' }, replay),
      }
    }

    case 'plan': {
      // D1 全量替换语义（replay/live 一致——回放即重建任务树）；深等快照返回原引用
      const current = state[key] ?? createSourceChatRuntime(source)
      const planState = applyPlanEntries({ entries: current.planEntries }, event.entries)
      if (planState.entries === current.planEntries) return state
      return { ...state, [key]: { ...current, planEntries: planState.entries } }
    }

    case 'usage-update': {
      return { ...state, [key]: { ...current, tokenCount: event.tokensUsed } }
    }

    case 'done': {
      // U2-C：作用域由事件标志承载（隔离 replay runtime 的终态带 replay+explicitReplay）。
      const replay = event.replay === true || event.explicitReplay === true
      const terminationScope = replay ? 'replay' : 'live'
      let runtime = settleMessages(current, now)
      // 有流式缓冲（live 作用域，或 replay/live 交错时 load 期间已发消息）都要落盘
      if (terminationScope === 'live' || runtime.streamingText || runtime.streamingThinking) {
        runtime = flushStreaming(runtime, now, agentId)
      }
      // 终态收敛：无论作用域都复位 generating（replay/live 交错时 user 事件先置 true、
      // replay 作用域 done 不收敛会导致 spinner 常转）；summary 仅 live 作用域写。
      // cancelState 解析：cancel 在途时 done 到达 = 生成已实际完成 → 置 cancelled，
      // 后续 cancel-success 不再覆盖 summary/elapsed=0，cancel-rejected 不再弹回 generating
      runtime = {
        ...runtime,
        generating: false,
        generationStart: undefined,
        generationPhase: undefined,
        cancelState: terminationScope === 'live' && current.cancelState.status === 'canceling'
          ? { ...current.cancelState, status: 'cancelled' }
          : current.cancelState,
        ...(terminationScope === 'live' ? {
          lastSummary: {
            elapsedMs: now - (current.generationStart ?? now),
            tokenCount: current.tokenCount,
            reason: 'done',
          },
        } : {}),
      }
      return { ...state, [key]: runtime }
    }

    case 'error': {
      const replay = event.replay === true || event.explicitReplay === true
      const terminationScope = replay ? 'replay' : 'live'
      let runtime = settleMessages(current, now)
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
        runtime = flushStreaming(runtime, now, agentId)
      }
      const seq = runtime.seq + 1
      runtime = appendMessage(runtime, {
        id: `err-${seq}`,
        role: 'assistant',
        sender: 'system',
        content: event.error,
        time: nowTime(now),
        agentId,
      }, seq)
      // 终态收敛：无论作用域都复位 generating（同 done 的交错防护）
      runtime = {
        ...runtime,
        generating: false,
        generationStart: undefined,
        generationPhase: undefined,
        ...(terminationScope === 'live' ? {
          lastSummary: {
            elapsedMs: now - (current.generationStart ?? now),
            tokenCount: current.tokenCount,
            reason: event.cancelled === true ? 'cancelled' : 'error',
          },
        } : {}),
      }
      return { ...state, [key]: runtime }
    }

    case 'begin-cancel': {
      const begun = beginCancel(source, current.cancelState)
      if (!begun.shouldInvoke) return state
      return { ...state, [key]: { ...current, cancelState: begun.state } }
    }

    case 'cancel-success': {
      if (current.cancelState.status !== 'canceling') return state
      let runtime = flushStreaming(current, now, agentId)
      runtime = {
        ...runtime,
        cancelState: applyCancelEvent(source, { kind: 'success' }, current.cancelState),
        generating: false,
        generationStart: undefined,
        generationPhase: undefined,
        lastSummary: {
          elapsedMs: now - (current.generationStart ?? now),
          tokenCount: current.tokenCount,
          reason: 'cancelled',
        },
      }
      return { ...state, [key]: runtime }
    }

    case 'cancel-rejected': {
      if (current.cancelState.status !== 'canceling') return state
      return {
        ...state,
        [key]: { ...current, cancelState: rejectCancelCommand(source, current.cancelState, new Error(event.error)) },
      }
    }

    default:
      return state
  }
}
