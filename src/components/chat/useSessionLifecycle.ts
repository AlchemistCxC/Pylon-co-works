import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI } from '../../infrastructure/tauri/env'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { reportRuntimeError } from '../../runtimeError'
import { createSessionClient, type ReplayMetadata } from '../../infrastructure/acp/sessionClient'
import { sessionResponseObject } from '../../infrastructure/acp/chatContracts'
import { applySessionStateResponse } from '../../domains/sessionState/sessionStateSync.ts'
import { isCurrentLoadGeneration, nextLoadGeneration } from './replayState'
import { CHAT_REPLAY_TRACE_CONTRACT, recordChatReplayTrace, replayErrorCode, safeContentEvidence } from './chatReplayTrace'
import { clearMessageStorage, messageStorageKey, parseMessageSnapshot } from './messagePersistence'
import { sessionContext, toAgentContextKey } from '../../agentContext'
import { attachChatEventController, bindChatControllerRefs, getChatController, registerChatController, type ChatControllerHandle, type ChatEventControllerRefs } from './chatEventController'
import { runSessionBoundaryHook } from './hookRuntime'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection'
import { tauriCanonicalEventRepository } from '../../infrastructure/events/canonicalEventRepository'
import type { Session } from '../../identityStore'
import type { Message } from './messageTypes'
import type { GenerationPhase, GenerationSummary } from './GenerationFooter'
import { runSessionPreflight } from '../../plugins/core/sessionCreation/sessionPreflight.ts'
import { collectProfilePersona } from '../../plugins/core/sessionCreation/builtinSessionCreation.ts'
import { ReplayLoadCoordinator } from './chatReplayCoordinator.ts'

export interface ChatSessionSetters {
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
  setStreamingThinking: React.Dispatch<React.SetStateAction<string>>
  setGenerating: React.Dispatch<React.SetStateAction<boolean>>
  setGenerationPhase: React.Dispatch<React.SetStateAction<GenerationPhase | null>>
  setSummary: React.Dispatch<React.SetStateAction<GenerationSummary | null>>
  setLastTokenAt: React.Dispatch<React.SetStateAction<number>>
}

export interface SessionRecoveryFailure {
  sessionId: string
  source: string
  message: string
}

export interface SessionReplayIntegrity {
  sessionId: string
  metadata: ReplayMetadata
}

function recoveryErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

/**
 * useSessionLifecycle — 会话生命周期（CV-4：从 ChatView 抽出，行为原样搬迁）。
 *
 * A1-c P4：Tauri 下首屏占位改读 SQLite canonical_events 投影，不再读写
 * localStorage 消息快照，也不再走 migrateLegacyMessages（旧历史废弃）。
 * canonical journal 是重启后的历史权威；仅在无本地权威且 replay 完整时使用 replay fallback。
 */
export function useSessionLifecycle(
  sessionId: string | null,
  sessions: readonly Session[],
  setters: ChatSessionSetters,
  selectSession: (id: string) => void,
) {
  const { setMessages, setStreamingText, setStreamingThinking, setGenerating, setGenerationPhase, setSummary, setLastTokenAt } = setters
  const sessionRef = useRef<string | null>(null)
  const messageOwnerRef = useRef<string | null>(null)
  const loadGenerationRef = useRef<Record<string, number>>({})
  // 初始 null：重挂载（切走 sheet 再切回）时首跑不得与当前 sessionId 相等，
  // 否则初始化被跳过、sessionRef 恒 null、事件永不 sync 到 UI。
  const prevSessionRef = useRef<string | null>(null)
  // CWD-03：已处理的 reload 令牌（同会话 rootPath 变更原地重载；令牌递增即重跑）。
  const processedReloadRef = useRef<number | undefined>(undefined)
  const controllerHandleRef = useRef<ChatControllerHandle | null>(null)
  const replayCoordinatorRef = useRef<ReplayLoadCoordinator | null>(null)
  const [recoveryFailure, setRecoveryFailure] = useState<SessionRecoveryFailure | null>(null)
  const [replayIntegrity, setReplayIntegrity] = useState<SessionReplayIntegrity | null>(null)
  const [canonicalRefresh, setCanonicalRefresh] = useState<{ sessionId: string; revision: number } | null>(null)

  // CWD-03：订阅当前会话的 reload 令牌——令牌递增时 effect 以 [sessionId, reloadToken]
  // 触发重跑（读取已同步的新 workdir/workspaceId 走 load/new，InputBar 随之恢复）。
  const activeSessionForReload = sessionId ? sessions.find(s => s.id === sessionId) : undefined
  const reloadKey = activeSessionForReload
    ? toAgentContextKey({ agentId: activeSessionForReload.agentId, source: activeSessionForReload.source })
    : undefined
  const reloadToken = useRuntimeStore(s => reloadKey ? s.sessionReloadTokens[reloadKey] : undefined)

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
    replayCoordinatorRef.current = new ReplayLoadCoordinator(controllerHandleRef.current!)
    return () => {
      // G0：卸载不 dispose（应用级保活，后台事件继续处理）；只解绑 handle 引用
      controllerHandleRef.current = null
    }
    // controllerRefs 是稳定 ref 对象（内部 .current 由接线层填充），无需加入 deps
  }, [])

  useEffect(() => {
    if (sessionId === prevSessionRef.current && processedReloadRef.current === reloadToken) return
    // 重挂载（切走 sheet 再切回）时 prevSessionRef 为 null；此时应保留 controller 内存态，
    // 避免 cached 尚未异步落盘导致 completed 消息被清空（只剩 running tool/生成指示）。
    const preserveRuntime = prevSessionRef.current === null
    processedReloadRef.current = reloadToken
    prevSessionRef.current = sessionId
    sessionRef.current = null
    messageOwnerRef.current = null
    setStreamingText('')
    setStreamingThinking('')
    setMessages([]); setGenerating(false); setSummary(null); setGenerationPhase(null)
    if (!sessionId) return

    const s = useIdentityStore.getState().sessions.find(s => s.id === sessionId)
    if (!s) return
    setRecoveryFailure(null)
    setReplayIntegrity(null)
    setCanonicalRefresh(null)
    sessionRef.current = s.source  // set BEFORE async, so incoming events match
    messageOwnerRef.current = s.id
    // I01-W2：会话运行时 store 写入一律按 AgentContext（agentId+source）隔离
    const context = sessionContext(s)
    const ownerKey = toCanonicalOwnerKey({ profileId: s.profileId, agentId: s.agentId, localSessionId: s.source })

    // session.created：旧 session.start 经兼容桥执行；v2 原生 Hook 同步收到稳定新 phase。
    void runSessionBoundaryHook('session.start', s)

    const profile = useIdentityStore.getState().profiles.find(p => p.id === s.profileId)
    const persona = collectProfilePersona(s.creationSnapshot) || profile?.persona || ''
    // FE-AUD-018：Profile 默认模型只作为新会话默认（new_session payload 权威路径一），
    // 不覆盖已存在会话；实际生效模型以 config_option 回读为准（下方 syncMode/config 同步）

    // new_session 返回可能是 string(periId) 或 { sessionId, configOptions } — 兼容处理

    /** 恢复 UI：initSource 注入占位/内存态，并同步 streaming/summary/generating。 */
    const restoreUi = (cached: Message[], baseFromCanonical = false) => {
      const messages = controllerHandleRef.current
        ? controllerHandleRef.current.initSource(s.source, cached, preserveRuntime, baseFromCanonical)
        : cached
      setMessages(messages)
      const streaming = controllerHandleRef.current?.getStreamingState(s.source)
      setStreamingText(streaming?.text ?? '')
      setStreamingThinking(streaming?.thinking ?? '')
      setSummary(controllerHandleRef.current?.getSummary(s.source) ?? null)
      setGenerationPhase(controllerHandleRef.current?.getGenerationPhase(s.source) ?? null)
      const lastActivityAt = controllerHandleRef.current?.getLastActivityAt(s.source)
      if (lastActivityAt !== undefined) setLastTokenAt(lastActivityAt)
      const sourceGenerating = (useRuntimeStore.getState().liveGeneratingSources || []).includes(s.source)
      setGenerating(sourceGenerating)
      return messages
    }

    // 浏览器 Dev 是纯视觉预览：它没有 canonical SQLite，也不应因 mock Tauri invoke
    // globals 的存在误走桌面恢复链路。直接使用 seed 写入的会话快照，保留场景差异。
    if (!IS_TAURI) {
      const cached = parseMessageSnapshot<Message>(localStorage.getItem(messageStorageKey(s.id))) ?? []
      restoreUi(cached)
      return
    }

    const createSession = () => {
      const loadGeneration = nextLoadGeneration(loadGenerationRef.current[s.source])
      loadGenerationRef.current[s.source] = loadGeneration
      const lockGeneration = controllerHandleRef.current?.beginLoadLock(s.source)
      const sessionClient = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      // OWNER-02：new_session 目标 owner = session.agentId（从 Session 读取）。
      // CWD-03：绑定 Workspace 时随 wire 发送 workspaceId（后端以 root_path 为 root 单一来源）。
      runSessionPreflight(s).then(preflight => sessionClient.newSession({
        agentId: s.agentId,
        profileId: s.profileId,
        source: s.source,
        persona,
        cwd: s.workdir || undefined,
        workspaceId: s.workspaceId || undefined,
        model: profile?.model || undefined,
        ...(preflight.mcpServers.length > 0 ? { mcpServers: preflight.mcpServers } : {}),
      })).then((response: unknown) => {
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) {
          if (lockGeneration !== undefined) controllerHandleRef.current?.finishLoadLock(s.source, lockGeneration)
          return
        }
        const res = sessionResponseObject(response)
        const periId = res.sessionId ?? res.periId
        if (periId) useIdentityStore.getState().setSessionPeriId(s.id, periId)
        applySessionStateResponse(context, res)
        // OWNER-04：new_session 成功 → 记录本次绑定建立时的 agent generation。
        // 重连后 generation 递增，bindingState.refineBindingGeneration 将旧 binding 判为 stale。
        useRuntimeStore.getState().setBindingGeneration(context, useRuntimeStore.getState().agentStatuses[s.agentId]?.generation)
        if (lockGeneration !== undefined) controllerHandleRef.current?.finishLoadLock(s.source, lockGeneration)
      }).catch(error => {
        if (lockGeneration !== undefined) controllerHandleRef.current?.finishLoadLock(s.source, lockGeneration)
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        reportRuntimeError('创建会话', error)
      })
    }

    const startPersistedLoad = (cached: Message[]) => {
      const coordinator = replayCoordinatorRef.current
      const controller = controllerHandleRef.current
      if (!coordinator || !controller) return
      const sessionClient = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      // OWNER-02：load_persisted_session 目标 owner = session.agentId（从 Session 读取）。
      // CWD-03：绑定 Workspace 时随 wire 发送 workspaceId（后端以 root_path 为 root 单一来源）。
      void getHookRuntime().invoke('session.loading', { session: s, source: s.source }, s.hooks.length > 0 ? s.hooks : undefined)
      const pending = coordinator.load({
        source: s.source,
        ownerKey,
        cached,
        load: () => sessionClient.loadPersistedSession({ owner: { profileId: s.profileId, agentId: s.agentId, localSessionId: s.source }, periId: s.periId, cwd: s.workdir || undefined, workspaceId: s.workspaceId || undefined }),
        loadCanonical: () => tauriCanonicalEventRepository().loadAll(ownerKey),
        projectCanonical: rows => projectMessagesFromCanonical(rows),
        isCurrent: () => sessionRef.current === s.source && processedReloadRef.current === reloadToken,
      })
      const loadGeneration = coordinator.currentGeneration(s.source) ?? 0
      recordChatReplayTrace({
        kind: 'load-start', ownerSessionId: s.id, source: s.source, generation: loadGeneration,
        contract: CHAT_REPLAY_TRACE_CONTRACT, owner: ownerKey, loadGeneration,
        captureLp: 'active-replay-registry',
        ...safeContentEvidence(cached),
      })
      void pending.then(outcome => {
        if (!outcome) return
        void getHookRuntime().invoke('session.loaded', { session: s, source: s.source }, s.hooks.length > 0 ? s.hooks : undefined)
        const res = sessionResponseObject(outcome.response)
        recordChatReplayTrace({
          kind: 'load-response',
          ownerSessionId: s.id,
          source: s.source,
          generation: loadGeneration,
          contract: CHAT_REPLAY_TRACE_CONTRACT,
          owner: ownerKey,
          loadGeneration,
          captureLp: 'active-replay-registry',
          responseBoundary: outcome.replayMetadata.boundary.kind,
          observedCount: outcome.replayMetadata.boundary.observedCount,
          retainedCount: outcome.replayCount,
          droppedCount: outcome.replayMetadata.droppedCount,
          authority: outcome.authority,
          canonicalRevision: outcome.canonicalRevision,
          detail: {
            replayCount: outcome.replayCount,
            replayComplete: outcome.replayMetadata.complete,
            replayTruncated: outcome.replayMetadata.truncated,
            replayDroppedCount: outcome.replayMetadata.droppedCount,
            replayBoundary: outcome.replayMetadata.boundary.kind,
            replayObservedCount: outcome.replayMetadata.boundary.observedCount,
            replayJournalStatus: outcome.replayJournalStatus,
            canonicalRevision: outcome.canonicalRevision,
          },
        })
        recordChatReplayTrace({
          kind: 'load-commit', ownerSessionId: s.id, source: s.source, generation: loadGeneration,
          contract: CHAT_REPLAY_TRACE_CONTRACT, owner: ownerKey, loadGeneration,
          captureLp: 'active-replay-registry',
          responseBoundary: outcome.replayMetadata.boundary.kind,
          observedCount: outcome.replayMetadata.boundary.observedCount,
          retainedCount: outcome.replayCount,
          droppedCount: outcome.replayMetadata.droppedCount,
          authority: outcome.authority,
          canonicalRevision: outcome.canonicalRevision,
          commitOutcome: outcome.commit,
          detail: { commit: outcome.commit, authority: outcome.authority, canonicalRevision: outcome.canonicalRevision },
          ...safeContentEvidence(outcome.messages),
        })
        if (sessionRef.current === s.source) {
          setReplayIntegrity(outcome.replayMetadata.complete ? null : { sessionId: s.id, metadata: outcome.replayMetadata })
          setMessages(outcome.messages)
          setSummary(controller.getSummary(s.source) ?? (outcome.messages.length > 0 ? {
            elapsedMs: 0,
            tokenCount: controller.getTokenCount(s.source),
            completedFrame: '',
            reason: 'done',
          } : null))
        }
        applySessionStateResponse(context, res)
        // OWNER-04：load_persisted_session 成功 → 记录本次绑定重建时的 agent generation。
        // 上次绑定的 generation 已不同（重连/替换）时，旧 binding 必须 Invalidated。
        useRuntimeStore.getState().setBindingGeneration(context, useRuntimeStore.getState().agentStatuses[s.agentId]?.generation)
        setCanonicalRefresh({ sessionId: s.id, revision: outcome.canonicalRevision })
      }).catch(error => {
        if (coordinator.currentGeneration(s.source) !== loadGeneration) return
        if (sessionRef.current !== s.source) return
        recordChatReplayTrace({
          kind: 'load-error', ownerSessionId: s.id, source: s.source, generation: loadGeneration,
          contract: CHAT_REPLAY_TRACE_CONTRACT, owner: ownerKey, loadGeneration,
          captureLp: 'active-replay-registry', responseBoundary: 'not-observed',
          observedCount: 0, retainedCount: 0, droppedCount: 0,
          authority: 'none', canonicalRevision: 0, commitOutcome: 'load-error',
          errorCode: replayErrorCode(error),
        })
        reportRuntimeError('恢复会话', error)
        setRecoveryFailure({
          sessionId: s.id,
          source: s.source,
          message: recoveryErrorMessage(error),
        })
      })
    }

    if (s.periId) {
      // A1-c P4：先读 canonical_events 投影作为首屏占位（读失败按空缓存降级并可见上报），
      // 再走既有的 load_persisted_session 权威恢复。localStorage 旧快照不再读写。
      const coordinator = replayCoordinatorRef.current
      const placeholder = coordinator
        ? coordinator.readCanonicalPlaceholder({
            ownerKey,
            loadCanonical: () => tauriCanonicalEventRepository().loadAll(ownerKey),
            projectCanonical: rows => projectMessagesFromCanonical(rows),
          }).then(result => result.messages)
        : Promise.resolve([] as Message[])
      placeholder
        .catch(error => {
          reportRuntimeError(`读取 canonical 首屏占位失败（${s.id}）`, error)
          return []
        })
        .then(cached => {
          // 占位读取期间用户可能已切走/重载：refs 已指向新一轮，直接丢弃本次结果。
          if (sessionRef.current !== s.source || processedReloadRef.current !== reloadToken) return
          // D7：旧 localStorage 快照整体废弃——访问过该会话即清理旧 key，不再读写。
          clearMessageStorage(s.id, localStorage)
          const placeholder = cached.map(message => ({ ...message, running: false }))
          restoreUi(placeholder, true)
          startPersistedLoad(placeholder)
        })
    } else {
      controllerHandleRef.current?.clearReplay(s.source)
      restoreUi([])
      createSession()
    }
    // setters 是 useState 稳定函数（经 setters 参数传入，eslint 无法识别稳定性），无需加入 deps
  }, [sessionId, reloadToken])

  useEffect(() => {
    const activeSources = sessions.map(session => session.source)
    controllerHandleRef.current?.pruneSources(activeSources)
    for (const source of Object.keys(loadGenerationRef.current)) {
      if (!activeSources.includes(source)) delete loadGenerationRef.current[source]
    }
  }, [sessions, sessionId])

  const retryRecovery = () => {
    if (!sessionId) return
    const session = useIdentityStore.getState().sessions.find(candidate => candidate.id === sessionId)
    if (!session) return
    useRuntimeStore.getState().bumpSessionReload(sessionContext(session))
  }

  const createFork = () => {
    if (!sessionId) return
    const forkId = useIdentityStore.getState().forkSession(sessionId)
    if (!forkId) {
      reportRuntimeError('创建分叉会话', new Error('无法创建本地分叉会话'))
      return
    }
    setRecoveryFailure(null)
    selectSession(forkId)
  }

  return {
    sessionRef,
    messageOwnerRef,
    controllerHandleRef,
    recoveryFailure,
    replayIntegrity,
    canonicalRefresh,
    retryRecovery,
    createFork,
  }
}
