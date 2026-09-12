/** Tool connector projection: edge identity, precedence and appearance only.
 * DOM registration and layout subscriptions remain owned by the mounted workbench.
 */
import { isToolRenderMessage } from '../../components/chat/chatRowPipeline.ts'
import type { WorkbenchAppearanceSnapshot } from '../../domains/workbench/appearance.ts'
import type { WorkbenchActivityNode, WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import type { MessageListItem } from '../../domains/workbench/messageListPort.ts'
import type { SolidToolConnectorEdge, ToolConnectorAppearance } from './toolConnectorContracts.ts'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { deriveCanonicalToolConnectorSources, type ActivityTimelinePlacement } from './solidWorkbenchProjectionSupport.ts'

function toolConnectorTone(status: string): 'ok' | 'err' | 'run' {
  if (status === 'completed' || status === 'success') return 'ok'
  if (status === 'failed' || status === 'error' || status === 'cancelled') return 'err'
  return 'run'
}

export function buildLegacyToolConnectorEdges(
  descriptors: readonly MessageListItem['descriptor'][],
  appearance: WorkbenchAppearanceSnapshot,
): SolidToolConnectorEdge[] {
  const edges: SolidToolConnectorEdge[] = []
  const connectorAppearance = pickToolConnectorAppearance(appearance)
  for (let index = 1; index < descriptors.length; index += 1) {
    const current = descriptors[index]
    const previous = descriptors[index - 1]
    if (!current?.showConnector || !previous) continue
    if (!isToolRenderMessage(current.renderMessage) || !isToolRenderMessage(previous.renderMessage)) continue
    edges.push({
      key: `${previous.renderMessage.message.id}->${current.renderMessage.message.id}`,
      fromMessageId: previous.renderMessage.message.id,
      toMessageId: current.renderMessage.message.id,
      status: current.connectorStatus ?? 'run',
      visualState: normalizeToolVisualState(current.connectorVisualState),
      appearance: connectorAppearance,
    })
  }
  return edges
}

export function buildCanonicalToolConnectorEdges(
  placement: ActivityTimelinePlacement,
  document: WorkbenchDocument | undefined,
  context: SolidWorkbenchContextValue,
): SolidToolConnectorEdge[] {
  if (!document) return []
  const activities = new Map(document.activities.map(activity => [activity.id, activity]))
  const connectorAppearance = resolveSolidToolConnectorAppearance(context)
  const segments: readonly (readonly WorkbenchActivityNode[])[] = [
    placement.leading,
    ...placement.afterMessage.values(),
  ]
  const edges: SolidToolConnectorEdge[] = []
  for (const segment of segments) {
    const sources = deriveCanonicalToolConnectorSources(segment)
    for (const activity of segment) {
      const sourceId = sources.get(activity.id)
      if (!sourceId) continue
      const source = activities.get(sourceId)
      edges.push({
        key: `${sourceId}->${activity.id}`,
        fromMessageId: sourceId,
        toMessageId: activity.id,
        status: toolConnectorTone(source?.status ?? activity.status),
        visualState: normalizeToolVisualState(source?.status ?? activity.status),
        appearance: connectorAppearance,
      })
    }
  }
  return edges
}

export function mergeToolConnectorEdges(
  ...groups: readonly (readonly SolidToolConnectorEdge[])[]
): SolidToolConnectorEdge[] {
  const merged = new Map<string, SolidToolConnectorEdge>()
  for (const group of groups) {
    for (const edge of group) {
      // Legacy message rows are the authoritative representation when both
      // pipelines expose the same edge; do not register it twice.
      if (!merged.has(edge.key)) merged.set(edge.key, edge)
    }
  }
  return [...merged.values()]
}

function pickToolConnectorAppearance(appearance: WorkbenchAppearanceSnapshot): ToolConnectorAppearance {
  return {
    toolConnectorMode: appearance.toolConnectorMode,
    toolConnectorColor: appearance.toolConnectorColor,
    toolConnectorStyle: appearance.toolConnectorStyle,
    toolConnectorWidth: appearance.toolConnectorWidth,
    toolConnectorOpacity: appearance.toolConnectorOpacity,
  }
}

function resolveSolidToolConnectorAppearance(context: SolidWorkbenchContextValue): ToolConnectorAppearance {
  const host = context.appearanceSnapshot()
  const resolved = context.hostPort?.appearance.resolve?.({
    // Connector is owned by the generic lifecycle seam even when a
    // specialized tool kind falls back to the generic base Slot.
    kind: 'tool.generic',
    suiteId: context.activation?.suite.value.id ?? '',
    slotId: 'builtin.solid.content.base',
  })
  return {
    toolConnectorMode: resolved?.connectorMode === 'none' ? 'none' : host.toolConnectorMode,
    toolConnectorColor: host.toolConnectorColor,
    toolConnectorStyle: typeof resolved?.connectorStyle === 'string' ? resolved.connectorStyle : host.toolConnectorStyle,
    toolConnectorWidth: typeof resolved?.connectorWidth === 'number' ? resolved.connectorWidth : host.toolConnectorWidth,
    toolConnectorOpacity: typeof resolved?.connectorOpacity === 'number' ? resolved.connectorOpacity : host.toolConnectorOpacity,
  }
}

export function normalizeToolVisualState(value: string | undefined) {
  switch (value) {
    case 'queued':
    case 'waiting':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'unknown':
      return value
    default:
      return undefined
  }
}

