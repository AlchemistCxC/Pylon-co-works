import type React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '../../store'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { resolveSpinnerFrames } from './spinnerFrames'
import { extractModelConfig, extractUsage, type PeriDonePayload, type PeriUpdatePayload } from './acpTypes'
import { clearMessageStorage, persistMessageSnapshot } from './messagePersistence'
import { addGeneratingSource, removeGeneratingSource } from './sessionEventState'
import { reportRuntimeError } from '../../runtimeError'
import { applyChatEvent, createSourceChatRuntime, type ChatEvent, type ChatRuntimeState, type SourceChatRuntime } from './sessionRuntimeStore.ts'
import { resolveLoadedMessages } from './replayState.ts'
import type { Message } from './messageTypes.ts'
import type { GenerationPhase, GenerationSummary } from './GenerationFooter'

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
  let runtimeState: ChatRuntimeState = {}
  const knownSources = () => useIdentityStore.getState().sessions.map(session => session.source)
  const isActiveSource = (source: string) => source.length > 0 && knownSources().includes(source)
  const renderedSource = () => refs.sessionRef.current

  const dispatch = (event: ChatEvent) => {
    const before = runtimeState
    const after = applyChatEvent(before, event, {
      knownSources: knownSources(),
      renderedSource: renderedSource(),
      now: Date.now(),
    })
    if (after === before) return
    runtimeState = after
    syncSideEffects(before, after, event)
  }

  /** 渲染态同步：rendered source 的消息/流式/生成态/summary 变化 → setState */
  const syncRendered = (prev: SourceChatRuntime | undefined, next: SourceChatRuntime | undefined) => {
    if (!next) return
    if (prev?.messages !== next.messages) refs.setMessages(next.messages)
    if ((prev?.streamingText ?? '') !== next.streamingText) refs.setStreamingText(next.streamingText)
    if ((prev?.streamingThinking ?? '') !== next.streamingThinking) refs.setStreamingThinking(next.streamingThinking)
    if ((prev?.generating ?? false) !== next.generating) refs.setGenerating(next.generating)
    const prevSummary = prev?.lastSummary
    const nextSummary = next.lastSummary
    if (prevSummary !== nextSummary) {
      // 终态收敛（done/error/cancel-success 生成 summary）时同步清空阶段标记
      if (prevSummary === undefined && nextSummary !== undefined) refs.setGenerationPhase(null)
      refs.setSummary(nextSummary
        ? { elapsedMs: nextSummary.elapsedMs, tokenCount: nextSummary.tokenCount, completedFrame: '', reason: nextSummary.reason }
        : null)
    }
  }

  /** 持久化：live 路径（非 replay scope）且消息数组变化时写盘（失败静默，不中断事件流）。
   *  2026-08-02 收敛双写：rendered source 的消息由 ChatView 渲染 effect（messages 变化后）
   *  统一落盘（覆盖 initSource/commitReplay 等非事件注入路径），此处只负责后台会话
   *  （非 rendered source）的事件驱动写入——两处各司其职，不再同 key 重复 JSON.stringify。 */
  const syncPersistence = (source: string, prev: SourceChatRuntime | undefined, next: SourceChatRuntime | undefined) => {
    if (!next || isReplayScope(next)) return
    if (prev?.messages === next.messages) return
    if (isRenderedSource(source, renderedSource())) return
    const session = useIdentityStore.getState().sessions.find(item => item.source === source)
    if (!session) return
    try {
      persistMessageSnapshot(session.id, next.messages, localStorage)
    } catch { /* 跳过本次持久化，内存态不受影响 */ }
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
    syncPersistence(source, prev, next)
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
    invoke('cancel_prompt', { source }).then(() => {
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
  }

  // H1：listen 任一 reject（IPC 异常）不得产生 unhandled rejection；dispose 的
  // unlisten.then 也由此获得兜底（失败时解析为空数组，不泄漏已注册监听器）
  const unlisten = Promise.all([
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
          refs.setLastTokenAt(Date.now())
          refs.setGenerationPhase({ kind: 'thinking' })
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
          if (rendered) refs.setLastTokenAt(Date.now())
          if (!replay && rendered) refs.setGenerationPhase({ kind: 'responding' })
          dispatch({ type: 'message-chunk', source, text, replay })
          break
        }
        case 'agent_thought_chunk': {
          const text = upd.content?.text || ''
          if (!text) return
          if (rendered) refs.setLastTokenAt(Date.now())
          if (!replay && rendered) refs.setGenerationPhase({ kind: 'thinking' })
          dispatch({ type: 'thought-chunk', source, text, replay })
          break
        }
        case 'tool_call': {
          if (!replay && rendered) refs.setGenerationPhase({ kind: 'tool', name: upd.title || '?' })
          dispatch({ type: 'tool-call', source, toolCallId: upd.toolCallId, title: upd.title, rawInput: upd.rawInput, replay })
          break
        }
        case 'tool_call_update':
          dispatch({ type: 'tool-call-update', source, toolCallId: upd.toolCallId, rawOutput: upd.rawOutput, status: upd.status, replay })
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
  ]).catch(() => [])

  const handleClear = () => {
    const source = refs.sessionRef.current
    const ownerId = refs.messageOwnerRef.current
    if (!source || !ownerId) return
    const session = useIdentityStore.getState().sessions.find(item => item.id === ownerId && item.source === source)
    if (!session) return
    clearMessageStorage(session.id, localStorage)
    dispatch({ type: 'clear', source })
  }
  window.addEventListener('peri:clear', handleClear)

  return {
    requestCancel,
    initSource,
    commitReplay,
    clearReplay,
    getFrames,
    getTokenCount,
    getStartTime,
    pruneSources,
    dispose: () => {
      unlisten.then(fns => fns.forEach(f => f()))
      window.removeEventListener('peri:clear', handleClear)
    },
  }
}
