import type React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
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
import { resolveLoadedMessages } from './replayState.ts'
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
  /** 会话切换/恢复：注入本地缓存消息，返回当前有效消息（controller 内已有则优先） */
  initSource: (source: string, cached: Message[]) => Message[]
  /** load_persisted_session 成功后：replay 缓冲与缓存合并，清 replay 状态，返回最终消息 */
  commitReplay: (source: string, cached: Message[]) => Message[]
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
export function settleListeners<T>(
  listeners: Array<Promise<T>>,
  onRejected: (reason: unknown, index: number) => void,
): Promise<T[]> {
  return Promise.allSettled(listeners).then(results =>
    results.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value]
      onRejected(result.reason, index)
      return []
    }))
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
    if (existing) return existing.messages
    // seq 从缓存推进：load 期间 live 消息与 replay 共用同一单调 seq，id 不撞缓存旧 id
    const maxSeq = cached.reduce((max, message) => {
      const n = /-(\d+)$/.exec(message.id)?.[1]
      return n ? Math.max(max, Number(n)) : max
    }, 0)
    runtimeState = {
      ...runtimeState,
      [source]: {
        ...createSourceChatRuntime(source),
        messages: cached.map(message => ({ ...message, running: false })),
        seq: maxSeq,
      },
    }
    return runtimeState[source].messages
  }

  const commitReplay = (source: string, cached: Message[]): Message[] => {
    const existing = runtimeState[source]
    const replayed = existing?.replaying ?? []
    const resolved = resolveLoadedMessages({ loadSucceeded: true, cached, replayed })
    // 保留 load 期间 live 到达的消息：existing.messages = initSource 的 cached 前缀 + live 增量，
    // 按位置取前缀之后部分（id 经 initSource seq 推进保证单调不撞），与 replay 权威历史合并。
    // 覆盖旧实现"resolved 非空即整体覆盖"——load 期间用户发消息/agent 已回话会被丢弃。
    const liveAdditions = existing ? existing.messages.slice(cached.length) : []
    const merged = liveAdditions.length > 0 ? [...resolved, ...liveAdditions] : resolved
    const base = existing
      ? { ...existing, replaying: undefined, replayToolIds: [], messages: merged }
      : { ...createSourceChatRuntime(source), messages: resolved }
    runtimeState = { ...runtimeState, [source]: base }
    return merged
  }

  const clearReplay = (source: string) => {
    const existing = runtimeState[source]
    if (!existing) return
    runtimeState = {
      ...runtimeState,
      [source]: { ...existing, replaying: undefined, replayToolIds: [] },
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
  const unlisten = settleListeners([
    listen<{ source: string; content: string; replay?: boolean }>('pylon:user', (event) => {
      const { source, content, replay: eventReplay = false } = event.payload
      if (!isActiveSource(source)) return
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
      const store = useIdentityStore.getState()
      const s = store.sessions.find(session => session.source === source)
      if (s?.name.startsWith('session-')) {
        const autoName = content.slice(0, 30)
        useIdentityStore.getState().updateSession(s.id, { autoName, name: autoName })
      }
    }),

    listen<PeriUpdatePayload>('pylon:update', (event) => {
      const source = event.payload.source
      const upd = event.payload?.update
      if (!isActiveSource(source) || !source || !upd) return
      const variant = upd.sessionUpdate
      const replay = upd._meta?.periReplay === true || isReplayScope(runtimeState[source])
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

    listen<PeriDonePayload>('pylon:done', (event) => {
      const source = event.payload.source
      if (!isActiveSource(source) || !source) return
      const replayScope = isReplayScope(runtimeState[source])
      const replay = replayScope || event.payload.replay === true
      dispatch({ type: 'done', source, replay, explicitReplay: replayScope ? undefined : event.payload.replay === true })
    }),

    listen<{ source: string; error: string; cancelled?: boolean; replay?: boolean }>('pylon:error', (event) => {
      const { source, error } = event.payload
      if (!isActiveSource(source) || !source) return
      const replayScope = isReplayScope(runtimeState[source])
      const replay = replayScope || event.payload.replay === true
      dispatch({ type: 'error', source, error, cancelled: event.payload.cancelled === true, replay, explicitReplay: replayScope ? undefined : event.payload.replay === true })
    }),
  ], (reason) => reportRuntimeError('注册聊天事件监听', reason))

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
    requestCancel,
    initSource,
    commitReplay,
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
      unlisten.then(fns => fns.forEach(f => f()))
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
