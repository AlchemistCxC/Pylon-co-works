import type { Message } from '../../components/chat/messageTypes.ts'
import type { PlanEntry } from '../tasks/planTypes.ts'
import type { GenerationPhase, GenerationSummary } from './generationFooterContracts.ts'

export type WorkbenchRuntimeStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'error'

export interface WorkbenchRuntimeSnapshot {
  revision: number
  sessionId: string | null
  status: WorkbenchRuntimeStatus
  messages: readonly Message[]
  streamingText: string
  streamingThinking: string
  generating: boolean
  generationPhase?: GenerationPhase
  generationStart: number
  lastTokenAt?: number
  tokenCount: number
  summary: GenerationSummary | null
  tasks: readonly PlanEntry[]
  thinkingStart?: number
  availableModels: readonly string[]
  activeModel: string
  availableModes: readonly string[]
  activeMode: string
  canAttach: boolean
  promptImage: boolean
  error: string | null
}

export interface WorkbenchRuntime {
  getSnapshot(): WorkbenchRuntimeSnapshot
  subscribe(listener: () => void): () => void
}

export interface PreviewWorkbenchRuntime extends WorkbenchRuntime {
  setSnapshot(snapshot: WorkbenchRuntimeSnapshot): void
  update(patch: Partial<Omit<WorkbenchRuntimeSnapshot, 'revision'>>): void
  destroy(): void
}

export function createPreviewWorkbenchRuntime(
  initial: Omit<WorkbenchRuntimeSnapshot, 'revision'>,
): PreviewWorkbenchRuntime {
  let revision = 0
  let snapshot = freezeSnapshot({ ...initial, revision })
  const listeners = new Set<() => void>()
  let destroyed = false

  const publish = (next: WorkbenchRuntimeSnapshot) => {
    if (destroyed || runtimeSnapshotsEqual(snapshot, next)) return
    revision += 1
    snapshot = freezeSnapshot({ ...next, revision })
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setSnapshot(next) {
      publish(next)
    },
    update(patch) {
      publish({ ...snapshot, ...patch, revision })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      listeners.clear()
    },
  }
}

function runtimeSnapshotsEqual(left: WorkbenchRuntimeSnapshot, right: WorkbenchRuntimeSnapshot): boolean {
  if (left === right) return true
  // Bug4（2026-08-20）：弃用全量 JSON.stringify 深比较——流式高频 tick 会对整个含全部历史消息
  // 的 snapshot 做一次 O(总字节) 序列化，消息越多越慢（实测 1000 条 ≈1.4ms/tick，成为流式卡顿
  // 源头）。改为逐字段浅比较：messages/tasks/availableModels 等数组字段在 freezeSnapshot 下引用
  // 稳定，引用相同即视为一致（避免把"仅 streamingText 变化"误当成整包变化）。
  return (
    left.sessionId === right.sessionId &&
    left.status === right.status &&
    left.messages === right.messages &&
    left.streamingText === right.streamingText &&
    left.streamingThinking === right.streamingThinking &&
    left.generating === right.generating &&
    left.generationPhase === right.generationPhase &&
    left.generationStart === right.generationStart &&
    left.lastTokenAt === right.lastTokenAt &&
    left.tokenCount === right.tokenCount &&
    left.summary === right.summary &&
    left.tasks === right.tasks &&
    left.thinkingStart === right.thinkingStart &&
    left.availableModels === right.availableModels &&
    left.activeModel === right.activeModel &&
    left.availableModes === right.availableModes &&
    left.activeMode === right.activeMode &&
    left.canAttach === right.canAttach &&
    left.promptImage === right.promptImage &&
    left.error === right.error
  )
}

function freezeSnapshot(snapshot: WorkbenchRuntimeSnapshot): WorkbenchRuntimeSnapshot {
  Object.freeze(snapshot.messages)
  Object.freeze(snapshot.tasks)
  return Object.freeze(snapshot)
}
