import type React from 'react'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '../../store'
import { resolveSpinnerFrames } from './spinnerFrames'
import {
  normalizeToolId,
  resolveReplayEventMode,
  resolveTerminationScope,
  settleReplayToolMessages,
  shouldAcceptToolCall,
  shouldStartLiveGeneration,
} from './replayState'
import { clearMessageStorage, persistMessageSnapshot } from './messagePersistence'
import { addGeneratingSource, isKnownSource, isRenderedSource, removeGeneratingSource, updateSourceState } from './sessionEventState'
import { extractModelConfig, extractUsage, type PeriDonePayload, type PeriUpdatePayload } from './acpTypes'
import { applyCancelEvent, createCancelState, type CancelState } from './cancelState'
import { getToolSummary } from './toolPresentation'
import { createMessageIdAllocator, type MessageIdAllocator } from './messageIdAllocator'
import type { Message } from './messageTypes'
import type { GenerationSummary } from './GenerationFooter'

export interface ChatEventControllerRefs {
  sessionRef: React.RefObject<string | null>
  messageOwnerRef: React.RefObject<string | null>
  messagesBySourceRef: React.RefObject<Record<string, Message[]>>
  generationStartRef: React.RefObject<Record<string, number>>
  generationFramesRef: React.RefObject<Record<string, string[]>>
  replayingSourcesRef: React.RefObject<Record<string, Message[]>>
  replayToolIdsRef: React.RefObject<Record<string, string[]>>
  cancelStateRef: React.RefObject<Record<string, CancelState>>
  streamingSourceRef: React.RefObject<string | null>
  streamingTextRef: React.RefObject<string>
  streamingThinkingRef: React.RefObject<string>
  flushStreamingRef: React.RefObject<((source: string) => void) | null>
  genStartRef: React.RefObject<number>
  tokenCountRef: React.RefObject<number>
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
  setStreamingThinking: React.Dispatch<React.SetStateAction<string>>
  setGenerating: React.Dispatch<React.SetStateAction<boolean>>
  setSummary: React.Dispatch<React.SetStateAction<GenerationSummary | null>>
  setLastTokenAt: React.Dispatch<React.SetStateAction<number>>
}

function formatToolInput(name: string, rawInput: unknown): string {
  return getToolSummary(name, rawInput)
}

/**
 * 事件控制器：Tauri listeners、事件路由、message reducer、replay 与后台持久化。
 * 从 ChatView 抽出，保持行为不变；调用方以 `useEffect(() => attachChatEventController(refs), [])`
 * 挂载，返回值即 effect cleanup。本模块拥有自己的单调消息 ID allocator。
 */
export function attachChatEventController(refs: ChatEventControllerRefs): () => void {
  const messageIds: MessageIdAllocator = createMessageIdAllocator()
  const isActiveSource = (source: string) => isKnownSource(source, useStore.getState().sessions.map(session => session.source))
  const updateSourceMessages = (source: string, updater: (prev: Message[]) => Message[], replay = false) => {
    if (!isActiveSource(source)) return
    const next = replay
      ? updateSourceState(refs.replayingSourcesRef.current, source, updater)
      : updateSourceState(refs.messagesBySourceRef.current, source, updater)
    if (replay) return
    const session = useStore.getState().sessions.find(item => item.source === source)
    if (session) {
      persistMessageSnapshot(session.id, next, localStorage)
    }
    if (isRenderedSource(source, refs.sessionRef.current)) refs.setMessages(next)
  }
  const flushStreaming = (source: string) => {
    if (refs.streamingSourceRef.current !== source) return
    const text = refs.streamingTextRef.current
    const thinking = refs.streamingThinkingRef.current
    if (text || thinking) {
      updateSourceMessages(source, previous => [
        ...previous,
        ...(thinking ? [{ id: messageIds.next('thought'), role: 'reasoning' as const, sender: 'peri', content: thinking, time: new Date().toLocaleTimeString(), running: false }] : []),
        ...(text ? [{ id: messageIds.next('msg'), role: 'assistant' as const, sender: 'peri', content: text, time: new Date().toLocaleTimeString(), running: false }] : []),
      ])
    }
    refs.streamingSourceRef.current = null
    refs.streamingTextRef.current = ''
    refs.streamingThinkingRef.current = ''
    if (isRenderedSource(source, refs.sessionRef.current)) {
      refs.setStreamingText('')
      refs.setStreamingThinking('')
    }
  }
  refs.flushStreamingRef.current = flushStreaming
  const startGenerating = (source: string) => {
    const current = useStore.getState().liveGeneratingSources || []
    const next = addGeneratingSource(current, source)
    if (next !== current) {
      useStore.getState().setLiveStats({
        liveGeneratingSources: next,
        liveGenerating: source,
      })
    }
  }
  const stopGenerating = (source: string) => {
    const next = removeGeneratingSource(useStore.getState().liveGeneratingSources || [], source)
    useStore.getState().setLiveStats({
      liveGeneratingSources: next,
      liveGenerating: next[next.length - 1] || null,
    })
  }

  const unlisten = Promise.all([
    listen<{ source: string; content: string; replay?: boolean }>('peri:user', (event) => {
      const { source, content, replay: eventReplay = false } = event.payload
      if (!isActiveSource(source)) return
      const replayMode = resolveReplayEventMode({
        eventReplay,
        loadInProgress: refs.replayingSourcesRef.current[source] !== undefined,
      })
      const replay = replayMode !== 'live'
      const update = (prev: Message[]) => [
        ...prev.map(m => ({ ...m, running: false })),
        { id: messageIds.next('user'), role: 'user' as const, sender: source, content, time: new Date().toLocaleTimeString() },
      ]
      if (replay && !refs.replayingSourcesRef.current[source]) refs.replayingSourcesRef.current[source] = []
      updateSourceMessages(source, update, replay)
      if (!shouldStartLiveGeneration({ replay })) return
      refs.generationStartRef.current[source] = Date.now()
      const spinnerState = useStore.getState()
      refs.generationFramesRef.current[source] = resolveSpinnerFrames(spinnerState.spinnerFramePreset, spinnerState.spinnerCustomFrames)
      startGenerating(source)
      refs.cancelStateRef.current[source] = { source, status: 'generating' }
      if (isRenderedSource(source, refs.sessionRef.current)) {
        refs.genStartRef.current = refs.generationStartRef.current[source]
        refs.tokenCountRef.current = 0
        refs.setGenerating(true)
        refs.setLastTokenAt(Date.now())
        refs.setSummary(null)
        refs.streamingSourceRef.current = source
        refs.streamingTextRef.current = ''
        refs.streamingThinkingRef.current = ''
        refs.setStreamingText('')
        refs.setStreamingThinking('')
      }

      const store = useStore.getState()
      const sessions = store.sessions
      const s = sessions.find(s => s.source === source)
      if (s?.name.startsWith('session-')) {
        const autoName = content.slice(0, 30)
        store.updateSession(s.id, { autoName, name: autoName })
      }
    }),

    listen<PeriUpdatePayload>('peri:update', (event) => {
      const source = event.payload.source
      if (!isActiveSource(source)) return
      const upd = event.payload?.update
      if (!source || !upd) return
      const variant = upd.sessionUpdate
      const replayMode = resolveReplayEventMode({
        eventReplay: upd._meta?.periReplay === true,
        loadInProgress: refs.replayingSourcesRef.current[source] !== undefined,
      })
      const replay = replayMode !== 'live'
      if (replay && !refs.replayingSourcesRef.current[source]) refs.replayingSourcesRef.current[source] = []
      switch (variant) {
        case 'agent_message_chunk': {
          const text = upd.content?.text || ''
          if (!text) return
          if (!replay && isRenderedSource(source, refs.sessionRef.current)) {
            refs.streamingSourceRef.current = source
            refs.streamingTextRef.current += text
            refs.setLastTokenAt(Date.now())
            refs.setStreamingText(refs.streamingTextRef.current)
            break
          }
          updateSourceMessages(source, prev => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant' && last.running) {
              return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: m.content + text } : m)
            }
            return [...prev, { id: messageIds.next('msg'), role: 'assistant', sender: 'peri', content: text, time: new Date().toLocaleTimeString(), running: !replay }]
          }, replay)
          break
        }
        case 'agent_thought_chunk': {
          const text = upd.content?.text || ''
          if (!text) return
          if (!replay && isRenderedSource(source, refs.sessionRef.current)) {
            refs.streamingSourceRef.current = source
            refs.streamingThinkingRef.current += text
            refs.setLastTokenAt(Date.now())
            refs.setStreamingThinking(refs.streamingThinkingRef.current)
            break
          }
          updateSourceMessages(source, prev => {
            const last = prev[prev.length - 1]
            if (last?.role === 'reasoning' && last.running) {
              return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: m.content + text } : m)
            }
            return [...prev, { id: messageIds.next('thought'), role: 'reasoning', sender: 'peri', content: text, time: new Date().toLocaleTimeString(), running: !replay }]
          }, replay)
          break
        }
        case 'tool_call': {
          if (!replay) flushStreaming(source)
          const rawInput = upd.rawInput
          const toolId = normalizeToolId(upd.toolCallId)
          if (replay && !shouldAcceptToolCall(toolId, refs.replayToolIdsRef.current[source] || [])) break
          if (replay && toolId) refs.replayToolIdsRef.current[source] = [...(refs.replayToolIdsRef.current[source] || []), toolId]
          const title = upd.title || '?'
          const inputStr = formatToolInput(title, rawInput) || (typeof rawInput === 'string' ? rawInput.slice(0, 80) : '')
          updateSourceMessages(source, prev => [...prev, {
            id: 'tool-' + (toolId || messageIds.next('tool-missing')), role: 'tool', sender: 'tool:' + title, content: '', time: new Date().toLocaleTimeString(),
            toolName: title, toolInput: inputStr, running: true,
          }], replay)
          break
        }
        case 'tool_call_update': {
          const rawOutput = upd.rawOutput
          const toolId = normalizeToolId(upd.toolCallId)
          if (!toolId) break
          const outputStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2)
          const lines = outputStr ? outputStr.split(/\n/).filter((l: string) => l.trim()).length : 0
          updateSourceMessages(source, prev => prev.map(m => m.id === 'tool-' + toolId && m.running
            ? { ...m, toolOutput: outputStr, toolOutputLines: lines, toolStatus: upd.status, running: false }
            : m), replay)
          break
        }
        case 'usage_update': {
          const usage = extractUsage(upd)
          useStore.getState().setSessionLiveStats(source, usage)
          if (isRenderedSource(source, refs.sessionRef.current)) refs.tokenCountRef.current = usage.tokensUsed
          break
        }
        case 'available_commands_update':
          useStore.getState().setSessionLiveStats(source, { commands: upd.commands || [] })
          break
        case 'config_option_update': {
          if (Array.isArray(upd.configOptions)) {
            const cfg = extractModelConfig(upd.configOptions)
            if (cfg.model || cfg.models) useStore.getState().setSessionConfig(source, { ...cfg, raw: upd.configOptions })
            const modeOption = upd.configOptions.find(option => (option.id || option.key) === 'mode')
            const mode = modeOption?.currentValue ?? modeOption?.value
            if (mode != null) useStore.getState().setSessionMode(source, String(mode))
          } else {
            const key = upd.id ?? upd.key
            const val = upd.currentValue ?? upd.value
            if (key === 'model' && val != null) useStore.getState().setSessionConfig(source, { model: String(val) })
            if (key === 'mode' && val != null) useStore.getState().setSessionMode(source, String(val))
          }
          break
        }
      }
    }),

    listen<PeriDonePayload>('peri:done', (event) => {
      const source = event.payload.source
      if (!isActiveSource(source)) return
      if (!source) return
      const replay = refs.replayingSourcesRef.current[source] !== undefined
      const terminationScope = resolveTerminationScope(replay, event.payload.replay === true)
      if (terminationScope === 'live') {
        stopGenerating(source)
        flushStreaming(source)
        if (isRenderedSource(source, refs.sessionRef.current)) {
          const start = refs.generationStartRef.current[source] || refs.genStartRef.current
          const elapsedMs = Date.now() - start
          refs.setSummary({ elapsedMs, tokenCount: refs.tokenCountRef.current, completedFrame: '', reason: 'done' })
          refs.setGenerating(false)
        }
      }
      updateSourceMessages(source, prev => settleReplayToolMessages(prev.map(m => ({ ...m, running: false }))), replay)
    }),

    listen<{ source: string; error: string; cancelled?: boolean; replay?: boolean }>('peri:error', (event) => {
      const { source, error } = event.payload
      if (!isActiveSource(source)) return
      if (!source) return
      const replay = refs.replayingSourcesRef.current[source] !== undefined
      const terminationScope = resolveTerminationScope(replay, event.payload.replay === true)
      const cancelState = refs.cancelStateRef.current[source] || createCancelState(source)
      const cancellationFailed = terminationScope === 'live'
        && cancelState.status === 'canceling'
        && event.payload.cancelled !== true
      if (terminationScope === 'live') {
        refs.cancelStateRef.current[source] = applyCancelEvent(
          source,
          event.payload.cancelled === true
            ? { kind: 'success' }
            : { kind: 'error', error },
          cancelState,
        )
        if (!cancellationFailed) stopGenerating(source)
      }
      if (terminationScope === 'live' && !cancellationFailed) flushStreaming(source)
      updateSourceMessages(source, prev => [...settleReplayToolMessages(prev.map(m => ({ ...m, running: false }))), {
        id: messageIds.next('err'), role: 'assistant', sender: 'system', content: error, time: new Date().toLocaleTimeString(),
      }], replay)
      if (terminationScope === 'live' && !cancellationFailed && isRenderedSource(source, refs.sessionRef.current)) {
        const start = refs.generationStartRef.current[source] || refs.genStartRef.current
        refs.setSummary({ elapsedMs: Date.now() - start, tokenCount: refs.tokenCountRef.current, completedFrame: '', reason: event.payload.cancelled === true ? 'cancelled' : 'error' })
        refs.setGenerating(false)
      }
    }),
  ])

  const handleClear = () => {
    const source = refs.sessionRef.current
    const ownerId = refs.messageOwnerRef.current
    if (!source || !ownerId) return
    const session = useStore.getState().sessions.find(item => item.id === ownerId && item.source === source)
    if (!session) return
    refs.messagesBySourceRef.current[source] = []
    clearMessageStorage(session.id, localStorage)
    refs.setMessages([])
    refs.setSummary(null)
  }
  window.addEventListener('peri:clear', handleClear)

  return () => {
    refs.flushStreamingRef.current = null
    unlisten.then(fns => fns.forEach(f => f()))
    window.removeEventListener('peri:clear', handleClear)
  }
}
