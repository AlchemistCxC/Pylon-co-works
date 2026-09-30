/**
 * A04 projector · 只读选择器（#486 项2 四分之 selector；行为不变）。
 * C04/C08/C09/C11/C13 各 slice 的读取面；不读时钟、store、registry 或 IO。
 */
import type { GoalSnapshot, PlanState } from './plan/goalModel.ts'
import type { LifecycleState, NormalizedError } from './lifecycle/lifecycleModel.ts'
import type { AssistSnapshot } from './session/sessionSurface.ts'
import { TERMINAL_TOOL_STATUSES } from './workbenchProjectorTypes.ts'
import type {
  WorkbenchActivityNode,
  WorkbenchDocument,
  WorkbenchExtensionNode,
  WorkbenchInteraction,
  WorkbenchSessionSurface,
  WorkbenchTimelineEntry,
} from './workbenchProjectorTypes.ts'

export function selectTimeline(document: WorkbenchDocument): readonly WorkbenchTimelineEntry[] {
  return document.timeline
}

export function selectActivities(document: WorkbenchDocument): readonly WorkbenchActivityNode[] {
  return document.activities
}

/** C09：按 identity parent edge 派生稳定展示顺序；journal/document 本身保持原序。 */
export function selectActivityDisplayOrder(document: WorkbenchDocument): readonly WorkbenchActivityNode[] {
  const nodes = document.activities
  if (nodes.length < 2) return nodes
  const byId = new Map(nodes.map(node => [node.id, node]))
  const children = new Map<string, WorkbenchActivityNode[]>()
  const roots: WorkbenchActivityNode[] = []
  for (const node of nodes) {
    if (!node.parentId || node.parentId === node.id || !byId.has(node.parentId)) {
      roots.push(node)
      continue
    }
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const ordered: WorkbenchActivityNode[] = []
  const visited = new Set<string>()
  const appendTree = (root: WorkbenchActivityNode) => {
    const stack = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (visited.has(node.id)) continue
      visited.add(node.id)
      ordered.push(node)
      const descendants = children.get(node.id)
      if (descendants) for (let index = descendants.length - 1; index >= 0; index -= 1) stack.push(descendants[index])
    }
  }
  for (const root of roots) appendTree(root)
  // Cycles have no root; append them deterministically without losing evidence.
  for (const node of nodes) appendTree(node)
  return ordered
}

/** C11：全部 interaction 列表（requested/resolved/expired 均可见，供历史审计与 fallback）。 */
export function selectInteractions(document: WorkbenchDocument): readonly WorkbenchInteraction[] {
  return document.interactions
}
/** C11：待处理 interaction 队列（renderer 卡片消费；重复 response 幂等由 reducer 保证）。 */
export function selectPendingInteractions(document: WorkbenchDocument): readonly WorkbenchInteraction[] {
  return document.interactions.filter(interaction => interaction.status === 'requested')
}

/** C04：工具调用 provider-neutral snapshot（renderer 消费的唯一形态）。 */
export interface ToolInvocationSnapshot {
  readonly id: string
  /** 展示名（wire title 直通；缺失时 undefined，由 generic 卡显示 provider name）。 */
  readonly title?: string
  /** canonical machine name（_meta.pylon.toolName 优先）。 */
  readonly canonicalName?: string
  /** wire 原始 name（generic 卡的 provider name 显示）。 */
  readonly name?: string
  readonly semanticKind?: string
  readonly kind?: string
  readonly action?: string
  readonly capabilities?: unknown
  /** normalized input（renderer 消费字段）。 */
  readonly input?: unknown
  /** 审计兼容原始 input（不进 UI 主路径）。 */
  readonly rawInput?: unknown
  readonly locations?: unknown
  readonly status?: string
  readonly progress?: unknown
  readonly parentToolCallId?: string
  readonly result?: {
    readonly status?: string
    readonly parts?: unknown
    readonly rawOutput?: unknown
    readonly error?: NormalizedError
    readonly durationMs?: number
  }
}

/**
 * C04 架构补全：从 document activities 收窄出 typed 工具调用快照。
 * 缺字段保持 undefined（不伪造空值/零值）；未知 id 返回 null。
 */
// #409：渲染侧每个工具卡每拍都查一次快照（O(A) find × 卡数）。activities 数组每拍
// 重建一次 ⇒ 以数组为键的 WeakMap 每 tick 只付一次 O(A) 建 Map，M 个卡读 O(1)；
// 旧数组失引用后条目随 GC 回收。
const activityLookupCache = new WeakMap<readonly WorkbenchActivityNode[], Map<string, WorkbenchActivityNode>>()

function activityById(document: WorkbenchDocument, id: string): WorkbenchActivityNode | undefined {
  let lookup = activityLookupCache.get(document.activities)
  if (lookup === undefined) {
    lookup = new Map(document.activities.map(node => [node.id, node]))
    activityLookupCache.set(document.activities, lookup)
  }
  return lookup.get(id)
}

export function toolInvocationSnapshot(document: WorkbenchDocument, toolCallId: string): ToolInvocationSnapshot | null {
  const node = activityById(document, toolCallId)
  if (!node || node.kind !== 'tool') return null
  // C04：result 只在真实结果到达后存在——running 中不伪造 {status:'running'}
  const terminalOrHasOutput = TERMINAL_TOOL_STATUSES.has(node.status) || node.parts !== undefined || node.rawOutput !== undefined || node.error !== undefined
  const resultFields = terminalOrHasOutput ? {
    ...(node.status !== undefined ? { status: node.status } : {}),
    ...(node.parts !== undefined ? { parts: node.parts } : {}),
    ...(node.rawOutput !== undefined ? { rawOutput: node.rawOutput } : {}),
    ...(node.error !== undefined ? { error: node.error } : {}),
    ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
  } : {}
  // C04：title/canonicalName/name 三者语义分离——title 是展示标题，canonicalName 是归一机器名，
  // name 是 wire 原始名。node.title 在 reduceTool 里由 tool.name || tool.title 回填，
  // 因此 wire name 从原始事件（data.event.tool）取回，不与展示标题混淆。
  return Object.freeze({
    id: node.id,
    ...(node.displayName !== undefined ? { title: node.displayName } : node.title !== undefined ? { title: node.title } : {}),
    ...(node.canonicalName !== undefined ? { canonicalName: node.canonicalName } : {}),
    ...(node.providerName !== undefined ? { name: node.providerName } : {}),
    ...(node.semanticKind !== undefined ? { semanticKind: node.semanticKind } : {}),
    ...(node.toolKindWire !== undefined ? { kind: node.toolKindWire } : {}),
    ...(node.action !== undefined ? { action: node.action } : {}),
    ...(node.capabilities !== undefined ? { capabilities: node.capabilities } : {}),
    ...(node.input !== undefined ? { input: node.input } : {}),
    ...(node.rawInput !== undefined ? { rawInput: node.rawInput } : {}),
    ...(node.locations !== undefined ? { locations: node.locations } : {}),
    ...(node.status !== undefined ? { status: node.status } : {}),
    ...(node.progress !== undefined ? { progress: node.progress } : {}),
    ...(node.parentToolCallId !== undefined ? { parentToolCallId: node.parentToolCallId } : {}),
    ...(Object.keys(resultFields).length > 0 ? { result: resultFields } : {}),
  })
}

export function selectSessionSurface(document: WorkbenchDocument): WorkbenchSessionSurface {
  return document.session
}

export function selectAssist(document: WorkbenchDocument): AssistSnapshot {
  return document.assist
}

/** C08：plan/goal slice 只读选择器。 */
export function selectPlan(document: WorkbenchDocument): PlanState {
  return document.plan
}

export function selectGoal(document: WorkbenchDocument): GoalSnapshot | undefined {
  return document.goal.current
}

/** C13：生命周期 slice 与 system error 只读选择器。 */
export function selectLifecycle(document: WorkbenchDocument): LifecycleState {
  return document.lifecycle
}

export function selectSystemErrors(document: WorkbenchDocument): readonly NormalizedError[] {
  return document.systemErrors
}

export function selectExtensions(document: WorkbenchDocument): readonly WorkbenchExtensionNode[] {
  return document.extensions
}
