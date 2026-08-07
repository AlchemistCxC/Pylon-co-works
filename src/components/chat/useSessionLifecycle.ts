import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI } from '../../infrastructure/tauri/env'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { reportRuntimeError } from '../../runtimeError'
import { createSessionClient } from '../../infrastructure/acp/sessionClient'
import { extractMode, extractModelConfig, sessionResponseObject } from '../../infrastructure/acp/chatContracts'
import { isCurrentLoadGeneration, nextLoadGeneration, resolveLoadedMessages, serializeLoadedMessages } from './replayState'
import { clearMessageStorage, messageStorageKey, parseMessageSnapshot } from './messagePersistence'
import { attachChatEventController, bindChatControllerRefs, getChatController, registerChatController, type ChatControllerHandle, type ChatEventControllerRefs } from './chatEventController'
import type { Session } from '../../identityStore'
import type { Message } from './messageTypes'
import type { GenerationPhase, GenerationSummary } from './GenerationFooter'

export interface ChatSessionSetters {
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
  setStreamingThinking: React.Dispatch<React.SetStateAction<string>>
  setGenerating: React.Dispatch<React.SetStateAction<boolean>>
  setGenerationPhase: React.Dispatch<React.SetStateAction<GenerationPhase | null>>
  setSummary: React.Dispatch<React.SetStateAction<GenerationSummary | null>>
  setLastTokenAt: React.Dispatch<React.SetStateAction<number>>
}

/**
 * useSessionLifecycle — 会话生命周期（CV-4：从 ChatView 抽出，行为原样搬迁）。
 *
 * 承载：controller 挂接（必须先于会话切换 effect 声明——React effect 按声明顺序执行，
 * 首挂载时若 controller 未就绪，initSource 被跳过导致历史丢失）+ 会话切换
 * （重置 UI 态/恢复缓存/initSource/建会话或恢复持久化/同步 config+mode）+ 陈旧源清理。
 * 返回的 refs（sessionRef/messageOwnerRef/controllerHandleRef）供渲染与持久化消费。
 */
export function useSessionLifecycle(
  sessionId: string | null,
  sessions: readonly Session[],
  setters: ChatSessionSetters,
) {
  const { setMessages, setStreamingText, setStreamingThinking, setGenerating, setGenerationPhase, setSummary, setLastTokenAt } = setters
  const sessionRef = useRef<string | null>(null)
  const messageOwnerRef = useRef<string | null>(null)
  const loadGenerationRef = useRef<Record<string, number>>({})
  // 初始 null：重挂载（切走 sheet 再切回）时首跑不得与当前 sessionId 相等，
  // 否则初始化被跳过、sessionRef 恒 null、事件永不 sync 到 UI。
  const prevSessionRef = useRef<string | null>(null)
  const controllerHandleRef = useRef<ChatControllerHandle | null>(null)

  // 2026-08-02 加固：controller attach 必须先于 sessionId 切换 effect 声明——
  // React effect 按声明顺序执行，首挂载时若 controller 未就绪，initSource 被跳过
  // （controller runtimeState 从空开始，后续 live 事件覆盖 UI 缓存导致历史丢失）。
  // eventControllerRefs 构造也随之上移（attach 块消费它，必须在初始化后使用）。
  const eventControllerRefs = useRef<ChatEventControllerRefs | null>(null)
  if (!eventControllerRefs.current) {
    eventControllerRefs.current = {
      sessionRef,
      messageOwnerRef,
      setMessages,
      setStreamingText,
      setStreamingThinking,
      setGenerating,
      setGenerationPhase,
      setSummary,
      setLastTokenAt,
    }
  }
  const controllerRefs = eventControllerRefs.current
  useEffect(() => {
    // 非 Tauri 环境（浏览器预览 mock）不挂接 controller——
    // @tauri-apps/api 的 listen() 在无后端时会 reject，此前每次挂载产生多个未处理
    // rejection 且 dispose 的 unlisten.then 永不执行。所有消费点（initSource/
    // commitReplay/clearReplay/pruneSources/requestCancel）均有可选链或 fallback。
    if (!IS_TAURI) return
    // G0：controller 全局单例（listener 只注册一次）——首次创建注册，
    // ChatView 重挂载只重绑定渲染 refs，不重复注册 listener
    const existing = getChatController()
    if (existing) {
      bindChatControllerRefs(controllerRefs)
      controllerHandleRef.current = existing
    } else {
      controllerHandleRef.current = attachChatEventController(controllerRefs)
      registerChatController(controllerHandleRef.current)
    }
    return () => {
      // G0：卸载不 dispose（应用级保活，后台事件继续处理）；只解绑 handle 引用
      controllerHandleRef.current = null
    }
    // controllerRefs 是稳定 ref 对象（内部 .current 由接线层填充），无需加入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (sessionId === prevSessionRef.current) return
    prevSessionRef.current = sessionId
    sessionRef.current = null
    messageOwnerRef.current = null
    setStreamingText('')
    setStreamingThinking('')
    setMessages([]); setGenerating(false); setSummary(null); setGenerationPhase(null)
    if (!sessionId) return

    const s = useIdentityStore.getState().sessions.find(s => s.id === sessionId)
    if (!s) return
    sessionRef.current = s.source  // set BEFORE async, so incoming events match
    messageOwnerRef.current = s.id

    const cached = (() => {
      // H3：存储不可用（受限 WebView）时守卫，与全库其他 localStorage 读取一致
      let stored: string | null = null
      try { stored = localStorage.getItem(messageStorageKey(s.id)) } catch { /* 存储不可用：按空缓存 */ }
      if (!stored) return []
      // 2026-08-02：parseMessageSnapshot 兼容版本 envelope 与旧裸数组（损坏返回 null → 空）
      return (parseMessageSnapshot<Message>(stored) ?? []).map(message => ({ ...message, running: false }))
    })()
    const messages = controllerHandleRef.current
      ? controllerHandleRef.current.initSource(s.source, cached)
      : cached
    setMessages(messages)
    const sourceGenerating = (useRuntimeStore.getState().liveGeneratingSources || []).includes(s.source)
    setGenerating(sourceGenerating)

    const profile = useIdentityStore.getState().profiles.find(p => p.id === s.profileId)
    const persona = profile?.persona || ''
    // FE-AUD-018：Profile 默认模型只作为新会话默认（new_session payload 权威路径一），
    // 不覆盖已存在会话；实际生效模型以 config_option 回读为准（下方 syncMode/config 同步）

    // new_session 返回可能是 string(periId) 或 { sessionId, configOptions } — 兼容处理
    const syncMode = (source: string, res: ReturnType<typeof sessionResponseObject>) => {
      const currentMode = extractMode(res)
      if (currentMode != null) useRuntimeStore.getState().setSessionMode(source, String(currentMode))
    }

    const createSession = () => {
      const loadGeneration = nextLoadGeneration(loadGenerationRef.current[s.source])
      loadGenerationRef.current[s.source] = loadGeneration
      const sessionClient = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      sessionClient.newSession({ source: s.source, persona, cwd: s.workdir || undefined, model: profile?.model || undefined }).then((response: unknown) => {
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        const res = sessionResponseObject(response)
        const periId = res.sessionId ?? res.periId
        if (periId) useIdentityStore.getState().setSessionPeriId(s.id, periId)
        const cfg = extractModelConfig(res?.configOptions)
        if (cfg.model || cfg.models) useRuntimeStore.getState().setSessionConfig(s.source, { ...cfg, raw: res?.configOptions })
        syncMode(s.source, res)
      }).catch(error => {
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        reportRuntimeError('创建会话', error)
      })
    }

    if (s.periId) {
      const loadGeneration = nextLoadGeneration(loadGenerationRef.current[s.source])
      loadGenerationRef.current[s.source] = loadGeneration
      const sessionClient = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      sessionClient.loadPersistedSession({ source: s.source, periId: s.periId, cwd: s.workdir || undefined }).then((response: unknown) => {
        const res = sessionResponseObject(response)
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        const resolved = controllerHandleRef.current
          ? controllerHandleRef.current.commitReplay(s.source, cached)
          : resolveLoadedMessages({ loadSucceeded: true, cached, replayed: [] })
        const serialized = serializeLoadedMessages(resolved)
        try {
          if (serialized) localStorage.setItem(messageStorageKey(s.id), serialized)
          else clearMessageStorage(s.id, localStorage)
        } catch {}
        if (sessionRef.current === s.source) setMessages(resolved)
        const cfg = extractModelConfig(res?.configOptions)
        if (cfg.model || cfg.models) useRuntimeStore.getState().setSessionConfig(s.source, { ...cfg, raw: res?.configOptions })
        syncMode(s.source, res)
      }).catch(error => {
        reportRuntimeError('恢复会话', error)
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        controllerHandleRef.current?.clearReplay(s.source)
        createSession()  // Fallback
      })
    } else {
      controllerHandleRef.current?.clearReplay(s.source)
      createSession()
    }
    // setters 是 useState 稳定函数（经 setters 参数传入，eslint 无法识别稳定性），无需加入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    const activeSources = sessions.map(session => session.source)
    controllerHandleRef.current?.pruneSources(activeSources)
    for (const source of Object.keys(loadGenerationRef.current)) {
      if (!activeSources.includes(source)) delete loadGenerationRef.current[source]
    }
  }, [sessions, sessionId])

  return { sessionRef, messageOwnerRef, controllerHandleRef }
}
