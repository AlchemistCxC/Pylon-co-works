import { selectActivityDisplayOrder, type WorkbenchActivityNode, type WorkbenchDocument, type WorkbenchInteraction } from '../../domains/workbench/workbenchProjector.ts'
import type { ContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import type { LifecycleState } from '../../domains/workbench/lifecycle/lifecycleModel.ts'
import type { Message } from '../../components/chat/messageTypes.ts'
import type { WorkbenchStreamingIdentity } from '../../domains/workbench/workbenchRuntime.ts'

export interface DisplayStreamRecord {
  readonly role: 'assistant' | 'reasoning'
  readonly text: string
  readonly owner: 'canonical' | 'transient' | 'none'
  readonly canonical?: WorkbenchDocument['messages'][number]
}

/** Resolve canonical/transient text to one visible owner for a stream. */
export function selectDisplayStream(
  canonical: readonly WorkbenchDocument['messages'][number][],
  role: 'assistant' | 'reasoning',
  transientText: string,
  transientIdentity?: WorkbenchStreamingIdentity,
): DisplayStreamRecord {
  const row = [...canonical].reverse().find(message => message.role === role
    && identityCompatible(message.identity, transientIdentity))
  if (!row && transientText) return { role, text: transientText, owner: 'transient' }
  if (!row || !row.content) return row ? { role, text: transientText || row.content, owner: transientText ? 'transient' : 'canonical', canonical: row } : { role, text: '', owner: 'none' }
  if (!transientText) return { role, text: row.content, owner: 'canonical', canonical: row }
  // A terminal canonical row belongs to the previous turn. Only absorb a
  // transient tail when it is a valid prefix continuation; unrelated text is
  // a new display record and must not replace the historical row.
  if (!row.running) {
    if (transientText.startsWith(row.content) || row.content.startsWith(transientText)) {
      return { role, text: row.content, owner: 'canonical', canonical: row }
    }
    return { role, text: transientText, owner: 'transient' }
  }
  if (transientText.startsWith(row.content) && transientText.length > row.content.length) return { role, text: transientText, owner: 'transient', canonical: row }
  // Identity/content conflict: prefer the newest transient value as the sole
  // visible owner rather than swallowing unrelated text behind a role-only
  // coverage check. The canonical row is replaced at the list seam.
  if (!transientText.startsWith(row.content) && !row.content.startsWith(transientText)) {
    return { role, text: transientText, owner: 'transient', canonical: row }
  }
  return { role, text: row.content, owner: 'canonical', canonical: row }
}

function identityCompatible(
  canonical: WorkbenchDocument['messages'][number]['identity'],
  transient?: WorkbenchStreamingIdentity,
): boolean {
  if (!transient) return true
  const keys: (keyof WorkbenchStreamingIdentity)[] = ['turnId', 'messageId', 'toolCallId', 'eventId']
  const provided = keys.filter(key => transient[key] !== undefined)
  if (provided.length === 0) return true
  return provided.some(key => {
    const canonicalValue = key === 'eventId' ? undefined : canonical[key]
    return canonicalValue !== undefined && canonicalValue === transient[key]
  })
}

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

export function toSolidMessage(message: WorkbenchDocument['messages'][number]): Message {
  return {
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
}
