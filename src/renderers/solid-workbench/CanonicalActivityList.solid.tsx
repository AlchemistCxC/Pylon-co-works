import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js'
import { toolInvocationSnapshot, type WorkbenchActivityNode, type WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import { groupAdjacentToolActivities, type AdjacentToolActivityGroup } from '../../domains/workbench/activityGrouping.ts'
import { createToolConnectorLayoutPort } from '../../domains/workbench/toolConnectorLayoutPort.ts'
import { resolveToolIndicatorGlyph, SolidToolInvocationCard } from './chat/ToolInvocationCard.solid.tsx'
import { measureToolAnchor } from './chat/domToolConnectorMeasurement.ts'
import { SolidProcessActivity } from './chat/content/TerminalBlock.solid.tsx'
import { SolidSubagentCard } from './chat/content/SubagentCard.solid.tsx'
import { SolidWorkflowActivityCard } from './chat/content/WorkflowCard.solid.tsx'
import { capitalizeToolName } from '../../components/chat/toolPresentationModel.ts'
import { normalizeToolStatus, toolStatePresentation } from '../../domains/tool/status.ts'
import { fallbackRenderCommands } from './solidBuiltinContentRenderer.solid.tsx'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { WorkbenchContentSlot } from './WorkbenchContentSlot.solid.tsx'

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, character => `%${character.charCodeAt(0).toString(16).padStart(4, '0')}%`)
}

function CanonicalActivitySlot(props: {
  activity: WorkbenchActivityNode
  document: WorkbenchDocument
  context: SolidWorkbenchContextValue
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
}) {
  let root: HTMLDivElement | undefined
  let unregisterTool = () => {}
  let observer: MutationObserver | undefined
  const toolSnapshot = () => props.activity.kind === 'tool' ? toolInvocationSnapshot(props.document, props.activity.id) : null
  const kind = () => activityRenderKind(props.activity, props.context)
  createEffect(() => {
    unregisterTool()
    unregisterTool = () => {}
    if (props.activity.kind !== 'tool') return
    const id = props.activity.id
    unregisterTool = props.connectorPort.registerTool(id, () => {
      const head = root?.querySelector<HTMLButtonElement>('.term-tool-head')
      const indicator = root?.querySelector<HTMLSpanElement>('.term-tool-indicator')
      return measureToolAnchor(head ?? undefined, indicator ?? undefined)
    })
  })
  onMount(() => {
    if (typeof MutationObserver === 'undefined' || !root) return
    observer = new MutationObserver(() => props.connectorPort.invalidate('items-changed'))
    observer.observe(root, { childList: true, subtree: true })
  })
  onCleanup(() => {
    observer?.disconnect()
    unregisterTool()
  })

  return <>
    <div
      ref={root}
      class={`solid-workbench-activity-slot term-row ${props.activity.kind === 'tool' ? 'term-row-tool' : 'term-row-activity'}`}
      data-activity-id={props.activity.id}
    >
      <WorkbenchContentSlot
        nodeId={`${props.document.sessionId}:${props.activity.id}`}
        kind={kind()}
        payload={toolSnapshot() ?? props.activity}
        context={props.context}
        fallback={toolSnapshot()
          ? <SolidToolInvocationCard snapshot={toolSnapshot()!} appearance={{ ...props.context.appearanceSnapshot() }} renderKind="tool.generic" commands={fallbackRenderCommands(props.context)} />
          : props.activity.semanticKind === 'activity.process'
            ? <SolidProcessActivity activity={props.activity}
                appearance={{ ...props.context.appearanceSnapshot(), reducedMotion: props.context.input().reducedMotion }}
                commands={fallbackRenderCommands(props.context)} />
          : ['activity.subagent', 'activity.delegation', 'activity.team'].includes(props.activity.semanticKind ?? '')
            ? <SolidSubagentCard activity={props.activity}
                appearance={{ ...props.context.appearanceSnapshot(), reducedMotion: props.context.input().reducedMotion }}
                commands={fallbackRenderCommands(props.context)} />
          : ['activity.workflow', 'activity.workflow-phase', 'activity.workflow-agent', 'activity.background-task'].includes(props.activity.semanticKind ?? '')
            ? <SolidWorkflowActivityCard activity={props.activity}
                appearance={{ ...props.context.appearanceSnapshot(), reducedMotion: props.context.input().reducedMotion }}
                commands={fallbackRenderCommands(props.context)} />
          : <div class="solid-workbench-activity" data-activity-id={props.activity.id} data-status={props.activity.status}>
              {capitalizeToolName(props.activity.title || props.activity.kind)} · {props.activity.status}
            </div>}
      />
    </div>
  </>
}

export function CanonicalActivityList(props: {
  activities: readonly WorkbenchActivityNode[]
  document: WorkbenchDocument | undefined
  context: SolidWorkbenchContextValue
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
}) {
  const [rows, setRows] = createSignal<readonly StableActivityRow[]>([])
  const [expandedGroups, setExpandedGroups] = createSignal<Record<string, boolean>>({})
  let expandedSessionId: string | undefined
  createEffect(() => {
    const document = props.document
    const activities = props.activities
    if (!document) {
      setRows([])
      return
    }
    if (expandedSessionId !== document.sessionId) {
      expandedSessionId = document.sessionId
      setExpandedGroups({})
    }
    const previous = new Map(untrack(rows).map(row => [row.key, row]))
    setRows(activities.map(activity => {
      const key = `${document.sessionId}:${activity.id}`
      const existing = previous.get(key)
      if (!existing) return createStableActivityRow(key, activity)
      existing.update(activity)
      return existing
    }))
  })
  // Group wrappers must keep a stable identity across streaming revisions.
  // `groupAdjacentToolActivities` returns fresh objects per tick, and Solid's
  // <For> reconciles by reference — feeding it fresh groups would remount the
  // whole expanded group subtree on every paced snapshot (the remount storm
  // behind the expanded-tool-group jitter) and destroy scroll anchoring.
  const stableGroups = new Map<string, StableActivityGroupRow>()
  const groupedRows = createMemo(() => {
    const currentRows = rows()
    const rowById = new Map(currentRows.map(row => [row.activity.id, row]))
    const groups = groupAdjacentToolActivities(currentRows.map(row => row.activity))
    const firstById = new Map(groups.map(group => [group.items[0]!.id, group]))
    const consumed = new Set<string>()
    const liveGroupIds = new Set<string>()
    const units: Array<StableActivityRow | StableActivityGroupRow> = []
    for (const row of currentRows) {
      if (consumed.has(row.activity.id)) continue
      const group = firstById.get(row.activity.id)
      if (!group || group.count === 1) {
        units.push(row)
        continue
      }
      const memberRows = group.items
        .map(item => rowById.get(item.id))
        .filter((member): member is StableActivityRow => member !== undefined)
      const stable = stableGroups.get(group.groupId) ?? createStableActivityGroupRow(group.groupId)
      stable.update(group, memberRows)
      stableGroups.set(group.groupId, stable)
      liveGroupIds.add(group.groupId)
      units.push(stable)
      // Skip the remaining members; they are rendered inside the group row.
      for (const member of group.items) consumed.add(member.id)
    }
    for (const groupId of [...stableGroups.keys()]) {
      if (!liveGroupIds.has(groupId)) stableGroups.delete(groupId)
    }
    return units
  })
  return <Show when={rows().length > 0 ? props.document : undefined}>
    {document => <div class="solid-workbench-activities" aria-label="活动" data-activity-count={rows().length}>
      <For each={groupedRows()}>{unit => {
        if ('memberRows' in unit) {
          return <CanonicalActivityGroup
            row={unit}
            document={document()}
            context={props.context}
            connectorPort={props.connectorPort}
            open={expandedGroups()[unit.key] === true}
            onToggle={() => setExpandedGroups(previous => ({ ...previous, [unit.key]: !previous[unit.key] }))}
          />
        }
        return <CanonicalActivitySlot
          activity={unit.activity}
          document={document()}
          context={props.context}
          connectorPort={props.connectorPort}
        />
      }}</For>
    </div>}
  </Show>
}

function CanonicalActivityGroup(props: {
  row: StableActivityGroupRow
  document: WorkbenchDocument
  context: SolidWorkbenchContextValue
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
  open: boolean
  onToggle: () => void
}) {
  // A group is a display projection only.  Its indicator/status are derived
  // from the final member so a mixed run settles to the same visual state as
  // the last ordinary tool card (rather than the group's aggregate `mixed`).
  const group = () => props.row.group
  const lastActivity = () => group().items.at(-1)!
  const lastSnapshot = () => toolInvocationSnapshot(props.document, lastActivity().id)
  const toolAppearance = () => resolveToolActivityAppearance(lastActivity(), props.context)
  const state = () => {
    const snapshot = lastSnapshot()
    return normalizeToolStatus(snapshot?.status ?? snapshot?.result?.status ?? lastActivity().status)
  }
  const hasOutput = () => {
    const result = lastSnapshot()?.result
    return result !== undefined && (
      result.parts !== undefined || result.rawOutput !== undefined || result.error !== undefined
    )
  }
  const presentation = () => toolStatePresentation(state(), hasOutput())
  const label = () => {
    const snapshot = lastSnapshot()
    return snapshot?.title
      || snapshot?.canonicalName
      || snapshot?.name
      || '未知工具'
  }
  const indicatorMode = () => stringAppearanceSetting(toolAppearance(), 'indicator', 'glyph')
  const indicatorGlyph = () => resolveToolIndicatorGlyph(indicatorMode(), presentation().tone, toolAppearance())
  const bodyId = () => `solid-tool-group-${safeDomId(group().groupId)}`
  const renderKind = () => activityRenderKind(lastActivity(), props.context)
  const statusPalette = () => stringAppearanceSetting(toolAppearance(), 'statusPalette', 'semantic')
  const density = () => stringAppearanceSetting(toolAppearance(), 'density', 'comfortable')
  return <article
    class="term-tool solid-workbench-activity-group"
    role="status"
    aria-label={`工具：${capitalizeToolName(label())}，${group().count} 次调用，${presentation().label}`}
    data-content-kind="tool.group"
    data-activity-group={group().groupId}
    data-count={group().count}
    data-tool-state={presentation().state}
    data-status-label={presentation().label}
    data-status={presentation().tone}
    data-status-palette={statusPalette()}
    data-density={density() === 'compact' ? 'compact' : 'comfortable'}
    data-kind={renderKind()}
    data-reduced-motion={props.context.input().reducedMotion ? 'true' : 'false'}
    style={{
      color: stringAppearanceSetting(toolAppearance(), 'foreground', 'var(--text)'),
      background: stringAppearanceSetting(toolAppearance(), 'background', 'transparent'),
      'border-color': stringAppearanceSetting(toolAppearance(), 'borderColor', 'var(--border)'),
      'max-width': `${numberAppearanceSetting(toolAppearance(), 'maxWidth', 960)}px`,
    }}
    data-group-status={group().status}
    data-last-tool-status={lastActivity().status}
  >
    <button
      class="term-tool-head solid-workbench-activity-group-head"
      type="button"
      aria-expanded={props.open}
      aria-controls={bodyId()}
      onClick={props.onToggle}
    >
      <Show when={indicatorMode() !== 'none'}>
        <span class={`term-tool-indicator ${presentation().tone}`} aria-hidden="true">{indicatorGlyph()}</span>
      </Show>
      <span class="term-tool-name">{capitalizeToolName(label())}</span>
      <span class="term-tool-summary"> ({group().count} 次调用)</span>
      <span class="term-tool-state-label"> — {presentation().label}</span>
    </button>
    <Show when={props.open}>
      <div id={bodyId()} class="term-tool-body solid-workbench-activity-group-body">
        <div class="solid-workbench-activity-group-items" role="group" aria-label={`${label()} 的单次调用`}>
        {/* Members render through stable rows so streaming revisions update
            the member slots in place instead of remounting the subtree. */}
        <For each={props.row.memberRows}>{memberRow => <CanonicalActivitySlot
          activity={memberRow.activity}
          document={props.document}
          context={props.context}
          connectorPort={props.connectorPort}
        />}</For>
        </div>
      </div>
    </Show>
  </article>
}

function resolveToolActivityAppearance(
  activity: WorkbenchActivityNode,
  context: SolidWorkbenchContextValue,
): Readonly<Record<string, unknown>> {
  const kind = activityRenderKind(activity, context)
  const slotId = resolveActivitySlotId(kind, context) ?? 'builtin.solid.content.base'
  return context.hostPort?.appearance.resolve?.({
    kind,
    suiteId: context.activation?.suite.value.id ?? 'builtin.solid',
    slotId,
  }) ?? { ...context.appearanceSnapshot() }
}

function stringAppearanceSetting(appearance: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  return typeof appearance[key] === 'string' ? appearance[key] as string : fallback
}

function numberAppearanceSetting(appearance: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  return typeof appearance[key] === 'number' && Number.isFinite(appearance[key] as number)
    ? appearance[key] as number
    : fallback
}

function resolveActivitySlotId(kind: string, context: SolidWorkbenchContextValue): string | undefined {
  const activation = context.activation
  if (!activation) return undefined
  const visited = new Set<string>()
  let current: string | undefined = kind
  while (current && !visited.has(current)) {
    visited.add(current)
    const candidate = activation.slots.get(current)?.find(entry => entry.value.kinds.includes(current!))
    if (candidate) return candidate.value.id
    current = activation.kinds.get(current)?.value.fallbackKind
  }
  return undefined
}

/**
 * Derive incoming edges for one canonical activity segment.
 *
 * Canonical activities are rendered outside the legacy Message descriptor
 * pipeline, so `showConnector` is not available here.  Preserve explicit
 * parent edges and fill the missing flat-chain case by linking adjacent tool
 * nodes in the same segment.  Any non-tool activity is a hard boundary: it
 * starts a new visual chain rather than implying a relationship across it.
 */
interface StableActivityRow {
  readonly key: string
  readonly activity: WorkbenchActivityNode
  update(activity: WorkbenchActivityNode): void
}

function createStableActivityRow(key: string, initialActivity: WorkbenchActivityNode): StableActivityRow {
  const [current, setCurrent] = createSignal(initialActivity)
  return {
    key,
    get activity() { return current() },
    update: setCurrent,
  }
}

/**
 * Stable identity for an aggregated tool group. `groupAdjacentToolActivities`
 * rebuilds groups on every streaming revision; feeding those fresh objects to
 * `<For>` (reference-keyed) would remount the expanded group's whole subtree
 * per paced snapshot. The wrapper keeps the unit identity stable and exposes
 * the rebuilt group plus the member STABLE rows, so member slots update in
 * place.
 */
interface StableActivityGroupRow {
  readonly key: string
  readonly group: AdjacentToolActivityGroup
  readonly memberRows: readonly StableActivityRow[]
  update(group: AdjacentToolActivityGroup, memberRows: readonly StableActivityRow[]): void
}

function createStableActivityGroupRow(key: string): StableActivityGroupRow {
  const [current, setCurrent] = createSignal<{ group: AdjacentToolActivityGroup; memberRows: readonly StableActivityRow[] }>()
  return {
    key,
    get group() { return current()!.group },
    get memberRows() { return current()?.memberRows ?? [] },
    update: (group, memberRows) => setCurrent({ group, memberRows }),
  }
}

function activityRenderKind(activity: WorkbenchActivityNode, context: SolidWorkbenchContextValue): string {
  if (activity.kind !== 'tool') return activity.semanticKind ?? 'activity.generic'
  const semanticKind = activity.semanticKind
  return semanticKind && context.activation?.kinds.has(semanticKind) ? semanticKind : 'tool.generic'
}
