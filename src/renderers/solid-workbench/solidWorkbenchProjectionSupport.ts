import { selectActivityDisplayOrder, type WorkbenchActivityNode, type WorkbenchDocument, type WorkbenchInteraction } from '../../domains/workbench/workbenchProjector.ts'
import type { ContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import type { LifecycleState } from '../../domains/workbench/lifecycle/lifecycleModel.ts'
import type { Message } from '../../components/chat/messageTypes.ts'
export function canonicalTokenCount(
  usage: WorkbenchDocument['session']['usage'],
  fallback: number,
): number {
  if (!usage) return fallback
  if (usage.totalTokens !== undefined) return usage.totalTokens
  const known = [usage.inputTokens, usage.outputTokens, usage.reasoningTokens]
    .filter((value): value is number => value !== undefined)
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : fallback
}

export interface ActivityTimelinePlacement {
  readonly leading: readonly WorkbenchActivityNode[]
  readonly afterMessage: ReadonlyMap<string, readonly WorkbenchActivityNode[]>
}

export function selectActivityTimelinePlacement(document: WorkbenchDocument | undefined): ActivityTimelinePlacement {
  if (!document || document.activities.length === 0) return { leading: [], afterMessage: new Map() }
  const leading: WorkbenchActivityNode[] = []
  const afterMessage = new Map<string, WorkbenchActivityNode[]>()
  for (const activity of selectActivityDisplayOrder(document)) {
    let anchor: WorkbenchDocument['messages'][number] | undefined
    for (const message of document.messages) {
      if (message.sequence >= activity.sequence) continue
      if (!anchor || message.sequence > anchor.sequence) anchor = message
    }
    if (!anchor) {
      leading.push(activity)
      continue
    }
    const anchored = afterMessage.get(anchor.id) ?? []
    anchored.push(activity)
    afterMessage.set(anchor.id, anchored)
  }
  return { leading, afterMessage }
}

/** Derive incoming edges for one canonical activity segment. */
export function deriveCanonicalToolConnectorSources(
  activities: readonly WorkbenchActivityNode[],
): ReadonlyMap<string, string> {
  const sources = new Map<string, string>()
  let previousToolId: string | undefined
  for (const activity of activities) {
    if (activity.kind !== 'tool') {
      previousToolId = undefined
      continue
    }
    const parentId = activity.parentToolCallId
    if (parentId && parentId !== activity.id) sources.set(activity.id, parentId)
    else if (!parentId && previousToolId) sources.set(activity.id, previousToolId)
    previousToolId = activity.id
  }
  return sources
}

export function lifecycleRenderKind(state: LifecycleState): string | undefined {
  if (state.suspended) return 'lifecycle.suspended'
  if (state.retry) return 'lifecycle.retry'
  if (state.rewind) return 'lifecycle.rewind'
  if (state.compact) return 'lifecycle.compact'
  if (state.lastRecovery) return 'lifecycle.recovered'
  return undefined
}

export function interactionRenderKind(interaction: WorkbenchInteraction): string {
  if (!interaction.request || typeof interaction.request !== 'object' || Array.isArray(interaction.request)) return 'interaction.questions'
  switch ((interaction.request as Record<string, unknown>).kind) {
    case 'approval': return 'interaction.approval'
    case 'confirm': return 'interaction.confirm'
    case 'permission': return 'interaction.permission'
    case 'oauth': return 'interaction.oauth'
    case 'secret': return 'interaction.secret'
    case 'sudo': return 'interaction.sudo'
    case 'clarify':
    case 'ask-question':
    default: return 'interaction.questions'
  }
}

// P57 S2-R3：显示链包装复用。键是冻结的 WorkbenchMessage（引用稳定性由
// workbenchRuntime freezeItems 的全等短路保证）；同一冻结条目重复包装是
// 每-chunk O(n) 放大器，WeakMap 命中后引用跨 revision 稳定。
const solidMessageCache = new WeakMap<WorkbenchDocument['messages'][number], Message>()

export function toSolidMessage(message: WorkbenchDocument['messages'][number]): Message {
  const cached = solidMessageCache.get(message)
  if (cached) return cached
  const wrapped: Message = {
    id: message.id,
    role: message.role === 'user' ? 'user' : message.role === 'reasoning' ? 'reasoning' : 'assistant',
    sender: message.source.provider,
    content: message.content,
    time: message.time,
    running: message.running,
    thoughtStartedAt: message.thoughtStartedAtMs,
    thoughtDurationMs: message.thoughtDurationMs,
    redacted: message.redacted,
    redactedReason: message.redactedReason,
    semanticParts: message.parts,
  } as Message & { semanticParts: readonly ContentPart[] }
  solidMessageCache.set(message, wrapped)
  return wrapped
}
