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
  const { revision: _leftRevision, ...leftValue } = left
  const { revision: _rightRevision, ...rightValue } = right
  return JSON.stringify(leftValue) === JSON.stringify(rightValue)
}

function freezeSnapshot(snapshot: WorkbenchRuntimeSnapshot): WorkbenchRuntimeSnapshot {
  Object.freeze(snapshot.messages)
  Object.freeze(snapshot.tasks)
  return Object.freeze(snapshot)
}
