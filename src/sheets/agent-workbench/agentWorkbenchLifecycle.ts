/**
 * agentWorkbenchLifecycle — 会话生命周期 IPC 编排（P52 D4）。
 *
 * 从 useSessionLifecycle.ts 迁入（行为保真），controller 依赖全部退役：
 * - new_session 链：preflight → sessionClient.newSession → setSessionPeriId →
 *   setBindingGeneration → 错误上报（重试走 bumpSessionReload）；
 * - load_persisted_session 链：session.loading/loaded hooks、ReplayLoadCoordinator
 *   （owner 拒绝/authority/commit 决策保留；commit 的 UI 投影随 controller 死亡，
 *   adapter 退化为 seed-only + no-op）、replay trace（load-start/response/commit/error
 *   全量保留）、错误降级（空缓存上报 / 非空缓存诊断）；
 * - 首屏占位：canonical journal 投影读取 + 失败上报（迟到失败不污染新会话）；
 * - refresh 信号：canonicalRefresh → 宿主调 sessionRuntime.refresh（绑定链保真）。
 *
 * 框架无关（无 React hooks）：宿主 AgentRendererSuiteWorkbench 以 bind 效应驱动。
 */
import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI } from '../../infrastructure/tauri/env.ts'
import { useIdentityStore, type Session } from '../../identityStore.ts'
import { useRuntimeStore } from '../../runtimeStore.ts'
import { reportRuntimeDiagnostic, reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import { createSessionClient, type ReplayMetadata } from '../../infrastructure/acp/sessionClient.ts'
import { sessionResponseObject } from '../../infrastructure/acp/chatContracts.ts'
import { applySessionStateResponse } from '../../domains/sessionState/sessionStateSync.ts'
import { CHAT_REPLAY_TRACE_CONTRACT, recordChatReplayTrace, replayErrorCode, safeContentEvidence } from '../../components/chat/chatReplayTrace.ts'
import { clearMessageStorage } from '../../components/chat/messagePersistence.ts'
import { sessionContext } from '../../agentContext.ts'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection.ts'
import { tauriCanonicalEventRepository } from '../../infrastructure/events/canonicalEventRepository.ts'
import { getCanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'
import { runSessionPreflight } from '../../plugins/core/sessionCreation/sessionPreflight.ts'
import { collectProfilePersona } from '../../plugins/core/sessionCreation/builtinSessionCreation.ts'
import { ReplayLoadCoordinator } from '../../components/chat/chatReplayCoordinator.ts'
import type { Message } from '../../components/chat/messageTypes.ts'

export interface SessionRecoveryFailure {
  sessionId: string
  source: string
  message: string
}

export interface SessionReplayIntegrity {
  sessionId: string
  metadata: ReplayMetadata
}

export interface AgentWorkbenchLifecycleOutcome {
  /** placeholder 读取完成（load 链已排程）；宿主无需消费 messages（journal 由
   * sessionRuntime.bind 的 loadAll 投影），仅时序信号。 */
  readonly kind: 'placeholder-read' | 'create-scheduled'
}

/** P52 D4：controller 死后 replay commit 不再有 UI 投影意义——adapter 只保留
 * cursor 播种（canonicalEventFeed.seed）；lock/commit 语义退化 no-op。
 * 载荷（generation/authority/trace）仍在 coordinator 与返回的 outcome 中完整保留。 */
const replayAdapter = {
  beginLoadLock: () => 0,
  finishLoadLock: () => {},
  abortSessionLoad: () => {},
  commitReplaySnapshot: (_source: string, _generation: number, replay: unknown[]) => replay as Message[],
  commitCanonicalProjection: (_source: string, _generation: number, messages: Message[]) => messages,
  seedCanonicalCursor: (ownerKey: string, sequence: number) => getCanonicalEventFeed().seed(ownerKey, sequence),
}

export class AgentWorkbenchLifecycle {
  private readonly loadGenerations = new Map<string, number>()
  private readonly coordinator = new ReplayLoadCoordinator(replayAdapter)

  /** 当前绑定会话变更（宿主 bind 效应调用）：跑 new/load 链。
   * 返回值仅作时序信号；错误经 ErrorCenter 呈现。 */
  async activate(session: Session, options: { reloadToken?: number; isCurrent?: () => boolean }): Promise<AgentWorkbenchLifecycleOutcome | undefined> {
    if (!IS_TAURI) {
      // 浏览器 Dev 是纯视觉预览：无 canonical SQLite，不走桌面恢复链路。
      clearMessageStorage(session.id, localStorage)
      return { kind: 'placeholder-read' }
    }
    const context = sessionContext(session)
    const ownerKey = toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source })
    const isCurrent = options.isCurrent ?? (() => true)

    // session.created：旧 session.start 经兼容桥执行；v2 原生 Hook 同步收到稳定新 phase。
    void this.invokeSessionStartHook(session)

    const profile = useIdentityStore.getState().profiles.find(p => p.id === session.profileId)
    const persona = collectProfilePersona(session.creationSnapshot) || profile?.persona || ''

    if (!session.periId) {
      await this.createSession(session, context, persona, isCurrent)
      return { kind: 'create-scheduled' }
    }

    // A1-c P4：先读 canonical_events 投影作为首屏占位（读失败按空缓存降级并可见
    // 上报），再走 load_persisted_session 权威恢复。localStorage 旧快照不再读写。
    const cached = await this.coordinator.readCanonicalPlaceholder({
      ownerKey,
      loadCanonical: () => tauriCanonicalEventRepository().loadAll(ownerKey),
      projectCanonical: rows => projectMessagesFromCanonical(rows),
    }).then(result => result.messages).catch(error => {
      // The canonical read can finish after a session switch/reload. A late
      // failure belongs to that abandoned generation and must not create a
      // notification for the currently visible session.
      if (!isCurrent()) return []
      reportRuntimeError(`读取 canonical 首屏占位失败（${session.id}）`, error, session.agentId, {
        key: `session-placeholder:${session.id}`,
        scope: { kind: 'session', id: session.id },
        source: 'chat.session-placeholder',
        recovery: { kind: 'open-runtime-log', sessionId: session.id },
        recoveryAction: { label: '重试会话恢复', run: () => this.retryRecovery(session.id) },
      })
      return []
    })
    if (!isCurrent()) return undefined
    // D7：旧 localStorage 快照整体废弃——访问过该会话即清理旧 key，不再读写。
    clearMessageStorage(session.id, localStorage)
    await this.startPersistedLoad(session, ownerKey, cached, isCurrent)
    return { kind: 'placeholder-read' }
  }

  /** 会话删除后清理该 source 的 load generation（prune 等价物）。 */
  prune(sources: readonly string[]): void {
    for (const key of [...this.loadGenerations.keys()]) {
      if (!sources.includes(key)) this.loadGenerations.delete(key)
    }
  }

  retryRecovery(sessionId: string): void {
    const session = useIdentityStore.getState().sessions.find(candidate => candidate.id === sessionId)
    if (!session) return
    useRuntimeStore.getState().bumpSessionReload(sessionContext(session))
  }

  private async invokeSessionStartHook(session: Session): Promise<void> {
    const { runSessionBoundaryHook } = await import('../../components/chat/hookRuntime.ts')
    void runSessionBoundaryHook('session.start', session)
  }

  private async createSession(session: Session, context: ReturnType<typeof sessionContext>, persona: string, isCurrent: () => boolean): Promise<void> {
    const loadGeneration = (this.loadGenerations.get(session.source) ?? 0) + 1
    this.loadGenerations.set(session.source, loadGeneration)
    const sessionClient = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    // OWNER-02：new_session 目标 owner = session.agentId（从 Session 读取）。
    // CWD-03：绑定 Workspace 时随 wire 发送 workspaceId（后端以 root_path 为 root 单一来源）。
    try {
      const preflight = await runSessionPreflight(session)
      const response = await sessionClient.newSession({
        agentId: session.agentId,
        profileId: session.profileId,
        source: session.source,
        persona,
        cwd: session.workdir || undefined,
        workspaceId: session.workspaceId || undefined,
        model: useIdentityStore.getState().profiles.find(p => p.id === session.profileId)?.model || undefined,
        ...(preflight.mcpServers.length > 0 ? { mcpServers: preflight.mcpServers } : {}),
      })
      if (this.loadGenerations.get(session.source) !== loadGeneration || !isCurrent()) return
      const res = sessionResponseObject(response)
      const periId = res.sessionId ?? res.periId
      if (periId) useIdentityStore.getState().setSessionPeriId(session.id, periId)
      applySessionStateResponse(context, res)
      // OWNER-04：new_session 成功 → 记录本次绑定建立时的 agent generation。
      useRuntimeStore.getState().setBindingGeneration(context, useRuntimeStore.getState().agentStatuses[session.agentId]?.generation)
      resolveRuntimeErrors({ key: `session-create:${session.id}`, source: 'chat.session-create' })
    }
    catch (error) {
      if (this.loadGenerations.get(session.source) !== loadGeneration || !isCurrent()) return
      reportRuntimeError('创建会话', error, session.agentId, {
        key: `session-create:${session.id}`,
        scope: { kind: 'session', id: session.id },
        source: 'chat.session-create',
        recovery: { kind: 'open-runtime-log', sessionId: session.id },
        recoveryAction: { label: '重试会话恢复', run: () => this.retryRecovery(session.id) },
      })
    }
  }

  private async startPersistedLoad(session: Session, ownerKey: string, cached: Message[], isCurrent: () => boolean): Promise<void> {
    const sessionClient = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    // OWNER-02：load_persisted_session 目标 owner = session.agentId（从 Session 读取）。
    // CWD-03：绑定 Workspace 时随 wire 发送 workspaceId（后端以 root_path 为 root 单一来源）。
    void getHookRuntime().invoke('session.loading', { session, source: session.source }, session.hooks.length > 0 ? session.hooks : undefined)
    const pending = this.coordinator.load({
      source: session.source,
      ownerKey,
      cached,
      load: () => sessionClient.loadPersistedSession({ owner: { profileId: session.profileId, agentId: session.agentId, localSessionId: session.source }, periId: session.periId, cwd: session.workdir || undefined, workspaceId: session.workspaceId || undefined }),
      loadCanonical: () => tauriCanonicalEventRepository().loadAll(ownerKey),
      projectCanonical: rows => projectMessagesFromCanonical(rows),
      isCurrent,
    })
    const loadGeneration = this.coordinator.currentGeneration(session.source) ?? 0
    recordChatReplayTrace({
      kind: 'load-start', ownerSessionId: session.id, source: session.source, generation: loadGeneration,
      contract: CHAT_REPLAY_TRACE_CONTRACT, owner: ownerKey, loadGeneration,
      captureLp: 'active-replay-registry',
      ...safeContentEvidence(cached),
    })
    try {
      const outcome = await pending
      if (!outcome) return
      void getHookRuntime().invoke('session.loaded', { session, source: session.source }, session.hooks.length > 0 ? session.hooks : undefined)
      const res = sessionResponseObject(outcome.response)
      recordChatReplayTrace({
        kind: 'load-response',
        ownerSessionId: session.id, source: session.source, generation: loadGeneration,
        contract: CHAT_REPLAY_TRACE_CONTRACT,
        owner: ownerKey, loadGeneration,
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
        kind: 'load-commit', ownerSessionId: session.id, source: session.source, generation: loadGeneration,
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
      resolveRuntimeErrors({ action: '恢复会话', scope: { kind: 'session', id: session.id }, source: 'chat.session-recovery' })
      resolveRuntimeErrors({ key: `session-recovery:${session.id}`, source: 'chat.session-recovery' })
      resolveRuntimeErrors({ key: `session-placeholder:${session.id}`, source: 'chat.session-placeholder' })
      applySessionStateResponse(sessionContext(session), res)
      // OWNER-04：load_persisted_session 成功 → 记录本次绑定重建时的 agent generation。
      // 上次绑定的 generation 已不同（重连/替换）时，旧 binding 必须 Invalidated。
      useRuntimeStore.getState().setBindingGeneration(sessionContext(session), useRuntimeStore.getState().agentStatuses[session.agentId]?.generation)
      // load 后 canonical journal 可能发现 bind 读漏掉的终态事件——通知宿主 refresh。
      this.onCanonicalRefresh?.(session, outcome.canonicalRevision)
    }
    catch (error) {
      if (this.coordinator.currentGeneration(session.source) !== loadGeneration) return
      if (!isCurrent()) return
      recordChatReplayTrace({
        kind: 'load-error', ownerSessionId: session.id, source: session.source, generation: loadGeneration,
        contract: CHAT_REPLAY_TRACE_CONTRACT, owner: ownerKey, loadGeneration,
        captureLp: 'active-replay-registry', responseBoundary: 'not-observed',
        observedCount: 0, retainedCount: 0, droppedCount: 0,
        authority: 'none', canonicalRevision: 0, commitOutcome: 'load-error',
        errorCode: replayErrorCode(error),
      })
      const options = {
        key: `session-recovery:${session.id}`,
        scope: { kind: 'session' as const, id: session.id },
        source: 'chat.session-recovery',
        recovery: { kind: 'open-runtime-log' as const, sessionId: session.id },
        recoveryAction: { label: '重试会话恢复', run: () => this.retryRecovery(session.id) },
      }
      // canonical 首屏占位已经提供可用历史时，远端 ACP replay 失败不应
      // 把底部错误条覆盖在可读会话上；用户仍可从 Runtime/ErrorCenter
      // 看到诊断并按需重试。空缓存时保留原有可操作失败提示。
      if (cached.length === 0) {
        reportRuntimeError('恢复会话', error, session.agentId, options)
      } else {
        reportRuntimeDiagnostic('恢复会话', error, session.agentId, options)
      }
    }
  }

  /** load 完成信号（宿主接 sessionRuntime.refresh）。 */
  onCanonicalRefresh?: (session: Session, canonicalRevision: number) => void
}
