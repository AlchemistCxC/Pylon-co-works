import type React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useStore } from '../../store'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { resolveSpinnerFrames } from './spinnerFrames'
import { extractModelConfig, extractUsage, extractPlanEntries, type PeriDonePayload, type PeriUpdatePayload } from '../../infrastructure/acp/chatContracts'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { clearMessageStorage } from './messagePersistence'
import { messagePersistScheduler } from './messagePersistScheduler'
import { addGeneratingSource, removeGeneratingSource } from './sessionEventState'
import { reportRuntimeError } from '../../runtimeError'
import { applyChatEvent, createSourceChatRuntime, type ChatEvent, type ChatRuntimeState, type SourceChatRuntime } from './sessionRuntimeStore.ts'
import type { Message } from './messageTypes.ts'
import type { GenerationPhase, GenerationSummary } from './GenerationFooter'
import type { PlanEntry } from '../../domains/tasks/planTypes.ts'
import { createHorizontalSubscription } from './horizontalSubscription.ts'
import { extractTouchedPath } from '../../infrastructure/acp/touchedFiles.ts'
import { useWorkspaceStore } from '../../workspaceStore'

export interface ChatEventControllerRefs {
  sessionRef: React.RefObject<string | null>
  messageOwnerRef: React.RefObject<string | null>
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
  setStreamingThinking: React.Dispatch<React.SetStateAction<string>>
  setGenerating: React.Dispatch<React.SetStateAction<boolean>>
  setGenerationPhase: React.Dispatch<React.SetStateAction<GenerationPhase | null>>
  setSummary: React.Dispatch<React.SetStateAction<GenerationSummary | null>>
  setLastTokenAt: React.Dispatch<React.SetStateAction<number>>
}

export interface ChatControllerHandle {
  /** 取消当前生成（footer 停止按钮）：begin-cancel → invoke → cancel-success/rejected */
  requestCancel: (source: string) => void
  /** 乐观渲染（方案 B）：发送即把用户消息写入 Chat runtime 并启动生成态；
   * 返回 clientMsgId 供去重。InputBar 发送时先调本方法再发 IPC。 */
  sendOptimisticUser: (source: string, content: string, clientMsgId: string) => void
  /** 后端 pylon:user 到达：按 clientMsgId 确认乐观消息（去重）。 */
  confirmUser: (source: string, clientMsgId: string) => void
  /** 会话切换/恢复：注入本地缓存消息，返回当前有效消息（controller 内已有则优先） */
  initSource: (source: string, cached: Message[]) => Message[]
  /** load_persisted_session 返回的完整 replay snapshot：解析并原子提交 */
  commitReplaySnapshot: (source: string, replay: unknown[], cached: Message[]) => Message[]
  /** load 失败 fallback：清 replay 状态，后续事件按 live 处理 */
  clearReplay: (source: string) => void
  /** 渲染期读取该 source 的 spinner 帧（user 事件后由接线层写入）；空时返回 undefined 让调用方回退主题帧 */
  getFrames: (source: string) => string[] | undefined
  /** 渲染期读取该 source 的 token 计数（usage-update 维护） */
  getTokenCount: (source: string) => number
  /** 渲染期读取该 source 的生成起点（elapsed 显示用） */
  getStartTime: (source: string) => number
  /** 横向订阅（D23）：订阅 source 状态变化，返回退订函数 */
  subscribe: (source: string, listener: () => void) => () => void
  /** 横向版本戳（useSyncExternalStore getSnapshot；source 状态变化即递增） */
  getSnapshot: (source: string) => number
  /** 横向读取：任务快照（planEntries） */
  getTasks: (source: string) => PlanEntry[]
  /** W2-12：消息快照访问器（右栏搜索消费；hook 行为不变） */
  getMessages: (source: string) => Message[]
  /** 横向读取：思考开始时间戳（thinking 时长显示用） */
  getThinkingStart: (source: string) => number | undefined
  /** G1：重试注册失败的 listener，返回是否有新成功项（报告 8.5） */
  retryListeners: () => Promise<boolean>
  /** 会话集合变化后清理孤儿 source 状态（替代 clearChatSourceRefs） */
  pruneSources: (activeSources: readonly string[]) => void
  dispose: () => void
}

// 模块级单例：CC 里的 InputBar（不在 ChatView 子树内）经此访问统一的取消入口，
// 避免 InputBar 另持一套 cancelState（阶段 6.1 收敛：去重由 reducer begin-cancel 承担）
let activeController: ChatControllerHandle | null = null

export function registerChatController(handle: ChatControllerHandle | null): void {
  activeController = handle
}

export function getChatController(): ChatControllerHandle | null {
  return activeController
}

// G0：ChatRuntimeBridge 应用级宿主——controller 全局单例（listener 只注册一次），
// 渲染 refs 可重绑定（ChatView 重挂载复用，卸载不销毁 controller）
let currentRefs: ChatEventControllerRefs | null = null
let singletonController: ChatControllerHandle | null = null

/** 重绑定当前渲染 refs（ChatView 重挂载时调用；controller 内部经此读最新 refs） */
export function bindChatControllerRefs(refs: ChatEventControllerRefs): void {
  currentRefs = refs
}


/**
 * FE-AUD-024：并行注册的 listener 用 allSettled 收敛——保留成功 stop handle
 * （不全丢弃），失败逐个回调报告（ErrorCenter），dispose 只清理成功项。
 */
export interface ListenerSettleResult<T> {
  fns: T[]
  /** G1：失败项（index/reason），供调用方重试注册（报告 8.5） */
  failures: Array<{ index: number; reason: unknown }>
}

/**
 * 回放合并（验收回归）：replay 权威历史 resolved + load 期间 live 增量。
 * live 增量按内容签名（role+sender+content）对 resolved 去重——replay 权威
 * 可能已包含该消息（乐观渲染的 user 消息在 load 完成前已写入 messages，
 * Hermes 回放历史也含它）。不能用 id 去重：reducer 的 live 与 replay 共用
 * 单调 seq，同一逻辑消息的两个副本 id 恒不同（user-3 vs user-7），id 去重
 * 是死代码。内容签名对 user/assistant 消息稳定，能消除"每次回到会话都
 * 复制一遍"。
 */
export function mergeReplayMessages<T extends { id: string; role?: string; sender?: string; content?: string }>(
  resolved: T[],
  liveAdditions: T[],
): T[] {
  const resolvedKeys = new Set(resolved.map(m => messageDedupKey(m)))
  const dedupedLive = liveAdditions.filter(m => !resolvedKeys.has(messageDedupKey(m)))
  return dedupedLive.length > 0 ? [...resolved, ...dedupedLive] : resolved
}

/**
 * 消息去重签名：user/assistant 用 (role,sender,content)；tool 用 id 内嵌的
 * toolCallId（reducer 的 tool 消息 id 恒为 `tool-<toolCallId>`，Message 上无
 * 独立 toolCallId 字段且 content 恒空——不能读字段，否则所有 tool 消息签名
 * 坍缩为 `tool:` 导致不同工具调用被误去重）。
 */
function messageDedupKey(m: { id: string; role?: string; sender?: string; content?: string }): string {
  const role = m.role || ''
  const sender = m.sender || ''
  const content = m.content || ''
  if (role === 'tool') {
    const toolId = m.id.startsWith('tool-') ? m.id.slice('tool-'.length) : ''
    return toolId ? `tool:${toolId}` : `tool:${content}`
  }
  return `${role}:${sender}:${content}`
}

export function settleListeners<T>(
  listeners: Array<Promise<T>>,
  onRejected: (reason: unknown, index: number) => void,
): Promise<ListenerSettleResult<T>> {
  return Promise.allSettled(listeners).then(results => {
    const fns: T[] = []
    const failures: Array<{ index: number; reason: unknown }> = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        fns.push(result.value)
      } else {
        failures.push({ index, reason: result.reason })
        onRejected(result.reason, index)
      }
    })
    return { fns, failures }
  })
}

function stripReplayPersonaPrefix(content: string): string {
  const separator = '\n\n---\n\n'
  const index = content.indexOf(separator)
  if (index < 0) return content
  const stripped = content.slice(index + separator.length)
  return stripped || content
}

function isRenderedSource(source: string, renderedSource: string | null): boolean {
  return source.length > 0 && renderedSource === source
}

function isReplayScope(runtime: SourceChatRuntime | undefined): boolean {
  return runtime?.replaying !== undefined
}

/**
 * 事件控制器（阶段 2 收敛版）：Tauri listeners → sessionRuntimeStore 纯 reducer →
 * 副作用同步（渲染 setState / localStorage 持久化 / store live 状态 / frames / autoName）。
 * 行为等价源：收敛前的 refs 版控制器（commit 927f963 之前）。
 */
export function attachChatEventController(refs: ChatEventControllerRefs): ChatControllerHandle {
  // G0：首次创建（listener 注册一次）；重挂载复用并重绑定渲染 refs
  currentRefs = refs
  if (singletonController) return singletonController
  let runtimeState: ChatRuntimeState = {}
  const knownSources = () => useIdentityStore.getState().sessions.map(session => session.source)
  const isActiveSource = (source: string) => source.length > 0 && knownSources().includes(source)
  const renderedSource = () => currentRefs!.sessionRef.current
  // 横向订阅注册表（D23 方案 B）：dispatch 后对状态引用变化的 source 递增版本并通知
  const horizontal = createHorizontalSubscription()

  const dispatch = (event: ChatEvent) => {
    const before = runtimeState
    const after = applyChatEvent(before, event, {
      knownSources: knownSources(),
      renderedSource: renderedSource(),
      now: Date.now(),
    })
    if (after === before) return
    runtimeState = after
    // 仅该事件 source 的状态引用变化才递增版本并通知（source A 不影响 B）
    horizontal.bump(event.source, after[event.source] !== before[event.source])
    syncSideEffects(before, after, event)
  }

  /** 渲染态同步：rendered source 的消息/流式/生成态/summary 变化 → setState */
  const syncRendered = (prev: SourceChatRuntime | undefined, next: SourceChatRuntime | undefined) => {
    if (!next) return
    if (prev?.messages !== next.messages) currentRefs!.setMessages(next.messages)
    if ((prev?.streamingText ?? '') !== next.streamingText) currentRefs!.setStreamingText(next.streamingText)
    if ((prev?.streamingThinking ?? '') !== next.streamingThinking) currentRefs!.setStreamingThinking(next.streamingThinking)
    if ((prev?.generating ?? false) !== next.generating) currentRefs!.setGenerating(next.generating)
    const prevSummary = prev?.lastSummary
    const nextSummary = next.lastSummary
    if (prevSummary !== nextSummary) {
      // 终态收敛（done/error/cancel-success 生成 summary）时同步清空阶段标记
      if (prevSummary === undefined && nextSummary !== undefined) currentRefs!.setGenerationPhase(null)
      currentRefs!.setSummary(nextSummary
        ? { elapsedMs: nextSummary.elapsedMs, tokenCount: nextSummary.tokenCount, completedFrame: '', reason: nextSummary.reason }
        : null)
    }
  }

  /** 持久化：live 路径（非 replay scope）且消息数组变化时写盘（报告 6C/FE-AUD-014）。
   *  2026-08-02 收敛双写：rendered source 的消息由 ChatView 渲染 effect（messages 变化后）
   *  统一落盘（覆盖 initSource/commitReplay 等非事件注入路径），此处只负责后台会话
   *  （非 rendered source）的事件驱动写入——两处走统一 scheduler（trailing debounce）；
   *  终态事件（done/error）强制 flush，不丢尾。 */
  const syncPersistence = (source: string, prev: SourceChatRuntime | undefined, next: SourceChatRuntime | undefined, force = false) => {
    if (!next || isReplayScope(next)) return
    if (prev?.messages === next.messages) return
    if (isRenderedSource(source, renderedSource())) return
    const session = useIdentityStore.getState().sessions.find(item => item.source === source)
    if (!session) return
    messagePersistScheduler.markDirty(session.id, next.messages, force)
  }

  /** store 同步：generating 变化 → liveGeneratingSources 增删 */
  const syncGenerating = (source: string, prev: SourceChatRuntime | undefined, next: SourceChatRuntime | undefined) => {
    const prevGenerating = prev?.generating ?? false
    const nextGenerating = next?.generating ?? false
    if (prevGenerating === nextGenerating) return
    const store = useRuntimeStore.getState()
    if (nextGenerating) {
      const current = store.liveGeneratingSources || []
      const nextList = addGeneratingSource(current, source)
      if (nextList !== current) {
        store.setLiveStats({ liveGeneratingSources: nextList, liveGenerating: source })
      }
    } else {
      const nextList = removeGeneratingSource(store.liveGeneratingSources || [], source)
      store.setLiveStats({ liveGeneratingSources: nextList, liveGenerating: nextList[nextList.length - 1] || null })
    }
  }

  const syncSideEffects = (before: ChatRuntimeState, after: ChatRuntimeState, event: ChatEvent) => {
    const source = event.source
    const prev = before[source]
    const next = after[source]
    if (isRenderedSource(source, renderedSource())) syncRendered(prev, next)
    // 终态事件强制 flush（消息不丢尾，报告 6C.3）
    const terminal = event.type === 'done' || event.type === 'error' || event.type === 'cancel-success'
    syncPersistence(source, prev, next, terminal)
    syncGenerating(source, prev, next)
  }

  /** user 事件后接线层补充：spinner 帧（依赖主题域，reducer 不持有） */
  const resolveFrames = () => {
    const state = useStore.getState()
    return resolveSpinnerFrames(state.spinnerFramePreset, state.spinnerCustomFrames)
  }

  const requestCancel = (source: string) => {
    dispatch({ type: 'begin-cancel', source })
    // 2026-08-02 修复：begin-cancel 去重失败（非 generating/canceling 状态）时不白调后端。
    // 旧实现 dispatch 后无条件 invoke，footer 停止按钮/全局 Esc 在非生成态点击会发无效请求。
    if (runtimeState[source]?.cancelState.status !== 'canceling') return
    createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).cancelPrompt(source).then(() => {
      // 取消失败/成功均由 reducer 收敛；liveGenerating 清理走 syncGenerating
      dispatch({ type: 'cancel-success', source })
    }).catch(error => {
      dispatch({ type: 'cancel-rejected', source, error: error instanceof Error ? error.message : String(error) })
      reportRuntimeError('取消生成', error)
    })
  }

  const initSource = (source: string, cached: Message[]): Message[] => {
    const existing = runtimeState[source]
    const maxSeq = cached.reduce((max, message) => {
      const n = /-(\d+)$/.exec(message.id)?.[1]
      return n ? Math.max(max, Number(n)) : max
    }, 0)
    if (existing) {
      // 会话切换回 source：开启新一轮 load。
      // - 清空 replaying：上一轮 load 若未完成（切走了）会残留部分 replay 事件，
      //   新一轮 load 会重放完整历史，残留若不清会导致 replaying 重复累积。
      // - loadBaseSeq 推进到当前 seq：commitReplay 据此识别本轮 load 期间的新消息
      //   （seq > loadBaseSeq 的 live 消息：乐观 user/流式 assistant）。
      // - cached 与内存状态不同步（本地持久化被其他路径更新）时重置为 cached；
      //   同步则保留内存状态。
      const needsReset = existing.messages.length !== cached.length
      const nextSeq = needsReset ? maxSeq : existing.seq
      runtimeState = {
        ...runtimeState,
        [source]: {
          ...existing,
          messages: needsReset
            ? cached.map(message => ({ ...message, running: false }))
            : existing.messages,
          seq: nextSeq,
          loadBaseMessageIds: (needsReset ? cached : existing.messages).map(message => message.id),
          replaying: undefined,
          replayToolIds: [],
          loadBaseSeq: nextSeq,
        },
      }
      return runtimeState[source].messages
    }
    // seq 从缓存推进：load 期间 live 消息与 replay 共用同一单调 seq，id 不撞缓存旧 id
    runtimeState = {
      ...runtimeState,
      [source]: {
        ...createSourceChatRuntime(source),
        messages: cached.map(message => ({ ...message, running: false })),
        seq: maxSeq,
        loadBaseMessageIds: cached.map(message => message.id),
        // loadBaseSeq：兼容字段
        loadBaseSeq: maxSeq,
      },
    }
    return runtimeState[source].messages
  }

  const commitReplaySnapshot = (source: string, replay: unknown[], _cached: Message[]): Message[] => {
    const existing = runtimeState[source]
    if (!existing) return []

    let replayState: ChatRuntimeState = {
      [source]: {
        ...createSourceChatRuntime(source),
        replaying: [],
        seq: 0,
      },
    }
    const replayContext = { knownSources: [source], renderedSource: null, now: Date.now() }
    const replayDispatch = (event: ChatEvent) => {
      replayState = applyChatEvent(replayState, event, replayContext)
    }

    for (const raw of replay) {
      if (!raw || typeof raw !== 'object') continue
      const params = raw as { update?: PeriUpdatePayload['update'] }
      const upd = params.update
      if (!upd) continue
      switch (upd.sessionUpdate) {
        case 'user_message_chunk': {
          const content = typeof upd.content?.text === 'string' ? upd.content.text : ''
          if (content) replayDispatch({ type: 'user', source, content: stripReplayPersonaPrefix(content), eventReplay: true })
          break
        }
        case 'agent_message_chunk': {
          const text = upd.content?.text || ''
          if (text) replayDispatch({ type: 'message-chunk', source, text, replay: true })
          break
        }
        case 'agent_thought_chunk': {
          const text = upd.content?.text || ''
          if (text) replayDispatch({ type: 'thought-chunk', source, text, replay: true })
          break
        }
        case 'tool_call':
          replayDispatch({ type: 'tool-call', source, toolCallId: upd.toolCallId, title: upd.title, toolKind: upd.kind, contentBlocks: upd.content, rawInput: upd.rawInput, replay: true })
          break
        case 'tool_call_update':
          replayDispatch({ type: 'tool-call-update', source, toolCallId: upd.toolCallId, toolKind: upd.kind, contentBlocks: upd.content, rawOutput: upd.rawOutput, status: upd.status, replay: true })
          break
      }
    }
    replayDispatch({ type: 'done', source, replay: true, explicitReplay: true })
    const replayed = replayState[source]?.replaying ?? []
    const baseMessageIds = new Set(existing.loadBaseMessageIds ?? [])
    const liveAdditions = existing.messages.filter(message => !baseMessageIds.has(message.id))
    // 权威历史 + 本次 load 开始后新增的 live 消息；已有 cached/旧 replay 不再参与。
    const nextMessages = mergeReplayMessages(replayed, liveAdditions)
    runtimeState = {
      ...runtimeState,
      [source]: {
        ...existing,
        replaying: undefined,
        replayToolIds: [],
        loadBaseSeq: undefined,
        loadBaseMessageIds: undefined,
        messages: nextMessages,
      },
    }
    return nextMessages
  }

  const clearReplay = (source: string) => {
    // replay 已由 load_persisted_session command 收集并在 commitReplaySnapshot 原子提交。
    // 这里清理任何兼容旧路径残留，不再把 replay buffer 当权威历史。
    const existing = runtimeState[source]
    if (!existing) return
    runtimeState = {
      ...runtimeState,
      [source]: { ...existing, replaying: undefined, replayToolIds: [], loadBaseSeq: undefined, loadBaseMessageIds: undefined },
    }
  }

  const getFrames = (source: string): string[] | undefined => {
    const frames = runtimeState[source]?.generationFrames
    return frames && frames.length > 0 ? frames : undefined
  }

  const getTokenCount = (source: string): number => runtimeState[source]?.tokenCount ?? 0

  const getStartTime = (source: string): number => runtimeState[source]?.generationStart ?? Date.now()

  const pruneSources = (activeSources: readonly string[]) => {
    const active = new Set(activeSources)
    const next: ChatRuntimeState = {}
    let changed = false
    for (const [source, runtime] of Object.entries(runtimeState)) {
      if (active.has(source)) next[source] = runtime
      else changed = true
    }
    if (changed) runtimeState = next
    horizontal.prune(activeSources)
  }

  // H1 + FE-AUD-024：listen 任一 reject（IPC 异常）不得产生 unhandled rejection；
  // allSettled 保留已成功注册的 stop handle（不全丢弃），失败逐个报告（ErrorCenter），
  // dispose 只清理成功 handle，不泄漏未注册监听器
  // G1：listener 工厂数组（重试注册失败项，报告 8.5）
  const listenerFactories: Array<() => Promise<UnlistenFn>> = [
    () => listen<{ source: string; content: string; replay?: boolean }>('pylon:user', (event) => {
      const { source, content, replay: eventReplay = false } = event.payload
      if (!isActiveSource(source)) return
      // 自动命名（会话名仍为 session- 时）：无论乐观渲染是否已显示消息，
      // pylon:user 到达即命名（乐观路径 sendOptimisticUser 也走此确认点）。
      const store = useIdentityStore.getState()
      const session = store.sessions.find(s => s.source === source)
      if (session?.name.startsWith('session-')) {
        const autoName = content.slice(0, 30)
        useIdentityStore.getState().updateSession(session.id, { autoName, name: autoName })
      }
      // replay history 不再走全局 Tauri 事件；若兼容旧后端仍发 replay 标记则直接忽略，
      // 权威历史只由 load_persisted_session response 原子提交。
      if (eventReplay) return
      // 方案 B 去重：pylon:user 是乐观消息的回显（或重复投递）时不得重复追加。
      // 1) 匹配第一条同内容的未确认乐观消息 → 按 clientMsgId 确认转普通消息；
      // 2) 否则若尾部已有同内容普通 user 消息 → 后端重复投递，直接跳过。
      const pendingOptimistic = (runtimeState[source]?.messages ?? []).find(
        m => m.role === 'user' && m.clientMsgId !== undefined && m.content === content,
      )
      if (pendingOptimistic) {
        dispatch({ type: 'confirm-user', source, clientMsgId: pendingOptimistic.clientMsgId! })
        // 乐观消息已启动生成；确认后仍需补 frames/相位（与 user 分支一致）
        const next = runtimeState[source]
        if (next?.generating) {
          runtimeState = { ...runtimeState, [source]: { ...next, generationFrames: resolveFrames() } }
          if (isRenderedSource(source, renderedSource())) {
            currentRefs!.setLastTokenAt(Date.now())
            currentRefs!.setGenerationPhase({ kind: 'thinking' })
          }
        }
        return
      }
      // lastUser 去重只针对 **live** 回显/重复投递；replay（load 历史重放）不得跳过——
      // replay 的 user 消息必须进 replaying 缓冲，commitReplay 才能以回放权威合并。
      // 若对 replay 也去重（剥离 persona 后 content 与 cached 末条相同会命中），
      // replay user 丢失 → commitReplay 以不含它的 replaying 替换 cached → 用户消息消失。
      const lastUser = [...(runtimeState[source]?.messages ?? [])]
        .reverse()
        .find(m => m.role === 'user')
      if (!eventReplay && lastUser && lastUser.content === content && lastUser.clientMsgId === undefined) {
        return
      }
      dispatch({
        type: 'user',
        source,
        content,
        eventReplay,
        loadInProgress: isReplayScope(runtimeState[source]),
      })
      // reducer 已在 user 事件内启动生成（live）；接线层补 frames 与 UI 相位
      const next = runtimeState[source]
      if (next?.generating) {
        runtimeState = { ...runtimeState, [source]: { ...next, generationFrames: resolveFrames() } }
        if (isRenderedSource(source, renderedSource())) {
          currentRefs!.setLastTokenAt(Date.now())
          currentRefs!.setGenerationPhase({ kind: 'thinking' })
        }
      }
    }),

    () => listen<PeriUpdatePayload>('pylon:update', (event) => {
      const source = event.payload.source
      const upd = event.payload?.update
      if (!isActiveSource(source) || !source || !upd) return
      const variant = upd.sessionUpdate
      // load 回放期间禁止通过全局事件把 live 事件写入历史重建缓冲；live 事件仍可
      // 正常写 messages，但本次 commit 以 snapshot 原子替换，避免污染 replay。
      const replay = upd._meta?.periReplay === true
      if (replay) return
      const rendered = isRenderedSource(source, renderedSource())
      switch (variant) {
        case 'agent_message_chunk': {
          const text = upd.content?.text || ''
          if (!text) return
          if (rendered) currentRefs!.setLastTokenAt(Date.now())
          if (!replay && rendered) currentRefs!.setGenerationPhase({ kind: 'responding' })
          dispatch({ type: 'message-chunk', source, text, replay })
          break
        }
        case 'agent_thought_chunk': {
          const text = upd.content?.text || ''
          if (!text) return
          if (rendered) currentRefs!.setLastTokenAt(Date.now())
          if (!replay && rendered) currentRefs!.setGenerationPhase({ kind: 'thinking' })
          dispatch({ type: 'thought-chunk', source, text, replay })
          break
        }
        case 'tool_call': {
          if (!replay && rendered) currentRefs!.setGenerationPhase({ kind: 'tool', name: upd.title || '?' })
          // W2-09：touchedFiles 记录（kind 优先/工具名兼容；提取失败 null 不误记）——刷新跟随数据源
          const touchedSession = useIdentityStore.getState().sessions.find(session => session.source === source)
          const touchedPath = extractTouchedPath({ kind: upd.kind, title: upd.title, rawInput: upd.rawInput, cwd: touchedSession?.workdir })
          if (touchedPath) {
            useWorkspaceStore.getState().recordTouchedFile(source, { path: touchedPath, toolKind: upd.kind || upd.title || '', at: Date.now() })
          }
          dispatch({ type: 'tool-call', source, toolCallId: upd.toolCallId, title: upd.title, toolKind: upd.kind, contentBlocks: upd.content, rawInput: upd.rawInput, replay })
          break
        }
        case 'tool_call_update':
          dispatch({ type: 'tool-call-update', source, toolCallId: upd.toolCallId, toolKind: upd.kind, contentBlocks: upd.content, rawOutput: upd.rawOutput, status: upd.status, replay })
          break
        case 'usage_update': {
          const usage = extractUsage(upd)
          useRuntimeStore.getState().setSessionLiveStats(source, usage)
          dispatch({ type: 'usage-update', source, tokensUsed: usage.tokensUsed })
          break
        }
        case 'available_commands_update':
          useRuntimeStore.getState().setSessionLiveStats(source, { commands: upd.commands || [] })
          break
        case 'config_option_update': {
          if (Array.isArray(upd.configOptions)) {
            const cfg = extractModelConfig(upd.configOptions)
            if (cfg.model || cfg.models) useRuntimeStore.getState().setSessionConfig(source, { ...cfg, raw: upd.configOptions })
            const modeOption = upd.configOptions.find(option => (option.id || option.key) === 'mode')
            const mode = modeOption?.currentValue ?? modeOption?.value
            if (mode != null) useRuntimeStore.getState().setSessionMode(source, String(mode))
          } else {
            const key = upd.id ?? upd.key
            const val = upd.currentValue ?? upd.value
            if (key === 'model' && val != null) useRuntimeStore.getState().setSessionConfig(source, { model: String(val) })
            if (key === 'mode' && val != null) useRuntimeStore.getState().setSessionMode(source, String(val))
          }
          break
        }
        case 'plan': {
          // D1 全量快照替换；entries 缺失（undefined）与空快照（[]）区分，交由 reducer 处理
          const entries = extractPlanEntries(upd)
          if (entries === undefined) break
          dispatch({ type: 'plan', source, entries, replay })
          break
        }
      }
    }),

    () => listen<PeriDonePayload>('pylon:done', (event) => {
      const source = event.payload.source
      if (!isActiveSource(source) || !source || event.payload.replay === true) return
      dispatch({ type: 'done', source, replay: false })
    }),

    () => listen<{ source: string; error: string; cancelled?: boolean; replay?: boolean }>('pylon:error', (event) => {
      const { source, error } = event.payload
      if (!isActiveSource(source) || !source || event.payload.replay === true) return
      dispatch({ type: 'error', source, error, cancelled: event.payload.cancelled === true, replay: false })
    }),
  ]

  let stopFns: Array<() => void> = []
  let failedListenerFactories: Array<{ factory: () => Promise<UnlistenFn>; index: number }> = []
  void settleListeners(
    listenerFactories.map(factory => factory()),
    (reason, index) => {
      failedListenerFactories.push({ factory: listenerFactories[index], index })
      reportRuntimeError('注册聊天事件监听', reason)
    },
  ).then(result => {
    stopFns = result.fns
    return result.fns
  })

  // G1：重试注册失败的 listener；成功者并入 stopFns
  const retryListeners = async (): Promise<boolean> => {
    if (failedListenerFactories.length === 0) return false
    const pending = failedListenerFactories
    failedListenerFactories = []
    const result = await settleListeners(
      pending.map(p => p.factory()),
      (reason, index) => {
        failedListenerFactories.push(pending[index])
        reportRuntimeError('重试注册聊天事件监听', reason)
      },
    )
    stopFns.push(...result.fns)
    return result.fns.length > 0
  }

  const handleClear = () => {
    const source = currentRefs!.sessionRef.current
    const ownerId = currentRefs!.messageOwnerRef.current
    if (!source || !ownerId) return
    const session = useIdentityStore.getState().sessions.find(item => item.id === ownerId && item.source === source)
    if (!session) return
    clearMessageStorage(session.id, localStorage)
    dispatch({ type: 'clear', source })
  }
  window.addEventListener('peri:clear', handleClear)

  const handle: ChatControllerHandle = {
    retryListeners,
    requestCancel,
    sendOptimisticUser: (source, content, clientMsgId) => {
      if (!isActiveSource(source)) return
      // 乐观渲染也立即自动命名（与 pylon:user 确认点一致），首条消息即命名
      const store = useIdentityStore.getState()
      const session = store.sessions.find(s => s.source === source)
      if (session?.name.startsWith('session-')) {
        const autoName = content.slice(0, 30)
        useIdentityStore.getState().updateSession(session.id, { autoName, name: autoName })
      }
      dispatch({ type: 'optimistic-user', source, content, clientMsgId })
      const next = runtimeState[source]
      if (next?.generating) {
        runtimeState = { ...runtimeState, [source]: { ...next, generationFrames: resolveFrames() } }
        if (isRenderedSource(source, renderedSource())) {
          currentRefs!.setLastTokenAt(Date.now())
          currentRefs!.setGenerationPhase({ kind: 'thinking' })
        }
      }
    },
    confirmUser: (source, clientMsgId) => {
      if (!isActiveSource(source)) return
      dispatch({ type: 'confirm-user', source, clientMsgId })
    },
    initSource,
    commitReplaySnapshot,
    clearReplay,
    getFrames,
    getTokenCount,
    getStartTime,
    subscribe: horizontal.subscribe,
    getSnapshot: horizontal.getSnapshot,
    getTasks: (source) => runtimeState[source]?.planEntries ?? [],
    getMessages: (source) => runtimeState[source]?.messages ?? [],
    getThinkingStart: (source) => runtimeState[source]?.thinkingStart,
    pruneSources,
    dispose: () => {
      stopFns.forEach(f => f())
      stopFns = []
      window.removeEventListener('peri:clear', handleClear)
      horizontal.dispose()
      // G0：应用级 dispose 后重置单例，允许下次重新创建
      if (singletonController === handle) singletonController = null
      currentRefs = null
    },
  }
  singletonController = handle
  return handle
}
