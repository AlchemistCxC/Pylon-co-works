import type { Message } from '../../components/chat/messageTypes.ts'
import type { PlanEntry } from '../tasks/planTypes.ts'
import { normalizePlanEntries, type PlanEntryV2 } from './plan/goalModel.ts'
import type {
  GenerationActivitySnapshot,
  GenerationPhase,
  GenerationSummary,
} from './generationFooterContracts.ts'
import type { WorkbenchActivityNode, WorkbenchDocument, WorkbenchMessage } from './workbenchProjector.ts'
import { createWorkbenchDocument, freezeDeepSnapshot, selectGoal, selectPlan } from './workbenchProjector.ts'
import type { JsonValue } from './events/workbenchEventSchema.ts'

export type WorkbenchRuntimeStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'error'

/** Legacy chat plan rows and canonical C08 plan rows coexist only at the runtime adapter boundary. */
export type WorkbenchTaskEntry = PlanEntry | PlanEntryV2

export type WorkbenchRuntimeSlice =
  | 'document' | 'timeline' | 'messages' | 'activities' | 'interactions'
  | 'session' | 'usage' | 'plan' | 'goal' | 'assist' | 'diagnostics' | 'extensions'
  | 'config' | 'commands' | 'tasks' | 'capabilities'

export interface WorkbenchRuntimeSnapshot {
  revision: number
  sessionId: string | null
  /** Session owner identity used to reject late events after a session switch. */
  ownerKey?: string
  /** Agent/runtime generation associated with the current owner. */
  generation?: number
  /** Runtime-local turn identity; never persisted to provider/canonical wire. */
  turnEpoch?: number
  /**
   * #213 活性权威。`'kernel'` = 内核在途回合标记就本 source 表态（ADR-0017，
   * 优先级最高）；`'clock'` = 会话层已用**本进程回合时钟**就该 owner/source 表态，
   * 文档派生的 `generating`（`legacyFieldsFromDocument` 的 `firstRunning`）不得覆盖它；
   * `'document'`（缺省）= 无时钟宿主（preview / legacy host / 浏览器 mock）按文档形状推断。
   *
   * 重放出来的 `running` 尾行只说明「没有见到终态」，不说明「本进程在跑」——把两者混为一谈
   * 会让进程重启/回合被截断后的旧会话永久显示生成态（页脚 spinner、思考中…）。
   */
  livenessSource?: 'kernel' | 'clock' | 'document'
  /** Terminal absorption fence for the current owner/turn. */
  terminalFence?: WorkbenchTerminalFence
  status: WorkbenchRuntimeStatus
  messages: readonly Message[]
  generating: boolean
  generationPhase?: GenerationPhase
  /** 活动轴；旧 generationPhase 仍作为兼容投影保留。 */
  generationActivity?: GenerationActivitySnapshot
  generationStart: number
  lastTokenAt?: number
  tokenCount: number
  summary: GenerationSummary | null
  tasks: readonly WorkbenchTaskEntry[]
  thinkingStart?: number
  availableModels: readonly string[]
  activeModel: string
  availableModes: readonly string[]
  activeMode: string
  canAttach: boolean
  promptImage: boolean
  error: string | null
  /** A04 projection view; legacy fields remain compatibility selectors for the current Solid adapter. */
  document?: WorkbenchDocument
}

export interface WorkbenchTerminalFence {
  readonly ownerKey?: string
  readonly turnEpoch: number
  readonly eventId?: string
  readonly sequence?: number
  readonly arrivalOrdinal?: number
}

export interface WorkbenchRuntimeMergeInput {
  readonly document?: WorkbenchDocument
  readonly generationPatch?: Partial<Omit<WorkbenchRuntimeSnapshot, 'revision' | 'document'>>
  readonly terminalFence?: WorkbenchTerminalFence | null
  readonly turnEpoch?: number
  readonly preserveGeneration?: boolean
  /** #213/#217：本快照活性结论的来源；`'kernel'`/`'clock'` 时文档派生不得复活 `generating`。 */
  readonly livenessSource?: 'kernel' | 'clock' | 'document'
  /** #213：`livenessSource` 表态时随投影携带的权威活性值。 */
  readonly livenessGenerating?: boolean
}

export interface WorkbenchRuntime {
  getSnapshot(): WorkbenchRuntimeSnapshot
  subscribe(listener: () => void): () => void
  getSlice<T = unknown>(slice: WorkbenchRuntimeSlice): T
  subscribeSlice(slice: WorkbenchRuntimeSlice, listener: () => void): () => void
}

export interface PreviewWorkbenchRuntime extends WorkbenchRuntime {
  setSnapshot(snapshot: WorkbenchRuntimeSnapshot): void
  update(patch: Partial<Omit<WorkbenchRuntimeSnapshot, 'revision'>>): void
  destroy(): void
  applyDocument(document: WorkbenchDocument, options?: WorkbenchDocumentApplyOptions): void
  replaceDocument(document: WorkbenchDocument, options?: WorkbenchDocumentApplyOptions): void
}

export interface WorkbenchDocumentApplyOptions {
  /** Owner key is stable for one session binding (agent + source + session). */
  readonly ownerKey?: string
  /** Lower generations are stale and are ignored once a newer one is active. */
  readonly generation?: number
  /** replaceDocument may explicitly clear the active session. */
  readonly sessionId?: string | null
  /**
   * Keep the host-owned generation clock while applying a document projection.
   * The canonical document and the live TurnClock are separate streams; a
   * projection can briefly omit running rows (or their timestamps) while a
   * turn is still active.  Callers that own an authoritative live generation
   * reader set this flag so that gap cannot reset elapsed time.
   */
  readonly preserveGeneration?: boolean
  /** #213/#217：本次投影携带的活性结论来源（见 `WorkbenchRuntimeSnapshot.livenessSource`）。 */
  readonly livenessSource?: 'kernel' | 'clock' | 'document'
  /**
   * #213：`livenessSource` 表态时**随文档一并传递的权威活性值**。
   *
   * 不能只读 `previous.generating`：新回合推进 `turnEpoch` 的那一次投影里，
   * "权威说在跑"的表态还没进快照，只读 previous 会把新回合的合法在途判成静止。
   */
  readonly livenessGenerating?: boolean
  /** Optional atomic turn/generation metadata committed with this document. */
  readonly turnEpoch?: number
  readonly terminalFence?: WorkbenchTerminalFence | null
  readonly generationPatch?: Partial<Omit<WorkbenchRuntimeSnapshot, 'revision' | 'document'>>
}

/** Mutable document runtime used by production composition and preview fixtures. */
export function createWorkbenchRuntime(
  initial: Omit<WorkbenchRuntimeSnapshot, 'revision'>,
): PreviewWorkbenchRuntime {
  let revision = 0
  let activeOwnerKey = initial.ownerKey
  let activeGeneration = initial.generation
  let snapshot = freezeSnapshot(normalizeRuntimeSnapshot({ ...initial, revision, document: initial.document ?? documentFromLegacy(initial) }))
  // Provenance of `snapshot.document`.  Documents derived here from legacy
  // snapshot fields (preview fixtures, legacy-only hosts) may keep rebuilding on
  // legacy patches.  Documents that entered through applyDocument/replaceDocument
  // (or a setSnapshot carrying one) are authoritative projections; update()
  // must never silently replace them — that path drops activities,
  // interactions, extensions and semantic parts, and zeroes message sequences.
  let documentLegacyDerived = initial.document === undefined
  const listeners = new Set<() => void>()
  const sliceListeners = new Map<WorkbenchRuntimeSlice, Set<() => void>>()
  let destroyed = false

  const publish = (next: WorkbenchRuntimeSnapshot) => {
    next = normalizeRuntimeSnapshot(next)
    if (destroyed || runtimeSnapshotsEqual(snapshot, next)) return
    const previous = snapshot
    revision += 1
    snapshot = freezeSnapshot({ ...next, revision, document: next.document ?? documentFromLegacy(next) })
    for (const listener of [...listeners]) listener()
    for (const slice of sliceListeners.keys()) {
      if (sliceChanged(previous, snapshot, slice)) {
        for (const listener of [...(sliceListeners.get(slice) ?? [])]) listener()
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSlice<T = unknown>(slice: WorkbenchRuntimeSlice): T {
      return selectSlice(snapshot, slice) as T
    },
    subscribeSlice(slice, listener) {
      if (destroyed) return () => {}
      const current = sliceListeners.get(slice) ?? new Set<() => void>()
      current.add(listener)
      sliceListeners.set(slice, current)
      return () => {
        current.delete(listener)
        if (current.size === 0) sliceListeners.delete(slice)
      }
    },
    setSnapshot(next) {
      documentLegacyDerived = next.document === undefined
      publish(next)
    },
    update(patch) {
      const next = { ...snapshot, ...patch, revision }
      if (!Object.prototype.hasOwnProperty.call(patch, 'document') && legacyDocumentFields.some(field => Object.prototype.hasOwnProperty.call(patch, field))) {
        if (documentLegacyDerived) {
          next.document = documentFromLegacy(next)
        } else {
          console.warn('[workbench-runtime] update() 忽略 legacy 字段对 canonical document 的重建；document 只能经 applyDocument/replaceDocument 变更')
        }
      } else if (Object.prototype.hasOwnProperty.call(patch, 'document')) {
        documentLegacyDerived = false
      }
      publish(next)
    },
    applyDocument(document, options = {}) {
      if (!acceptDocument(options)) return
      documentLegacyDerived = false
      const nextDocument = freezeDocument(document, snapshot.document)
      const merged = mergeWorkbenchRuntimeSnapshot(snapshot, {
        document: nextDocument,
        preserveGeneration: options.preserveGeneration,
        turnEpoch: options.turnEpoch,
        terminalFence: options.terminalFence,
        generationPatch: options.generationPatch,
        livenessSource: options.livenessSource,
        livenessGenerating: options.livenessGenerating,
      })
      publish({
        ...merged,
        // The canonical document is keyed by provider source while the host
        // runtime sessionId is the stable bound Session.id. Applying a live
        // projection must not silently replace the host identity with the
        // document's source id; replaceDocument is the explicit identity seam.
        sessionId: snapshot.sessionId ?? nextDocument.sessionId,
        ownerKey: options.ownerKey ?? activeOwnerKey,
        generation: options.generation ?? activeGeneration,
      })
    },
    replaceDocument(document, options = {}) {
      const ownerChanged = options.ownerKey !== undefined && options.ownerKey !== activeOwnerKey
      if (!acceptDocument(options, true)) return
      documentLegacyDerived = false
      const nextDocument = freezeDocument(document)
      const sessionChanged = nextDocument.sessionId !== snapshot.document?.sessionId
      const merged = mergeWorkbenchRuntimeSnapshot(snapshot, {
        document: nextDocument,
        turnEpoch: options.turnEpoch,
        terminalFence: options.terminalFence,
        generationPatch: options.generationPatch,
        livenessSource: options.livenessSource,
        livenessGenerating: options.livenessGenerating,
      })
      publish({
        ...merged,
        // Replacing the owner/session starts a fresh ephemeral activity
        // timeline. Also clear it for an idle replacement so a stale tool
        // label can never survive a bind or terminal snapshot.
        ...(ownerChanged || sessionChanged || !merged.generating ? { generationActivity: undefined } : {}),
        document: nextDocument,
        sessionId: options.sessionId === undefined ? nextDocument.sessionId || snapshot.sessionId : options.sessionId,
        ownerKey: options.ownerKey ?? activeOwnerKey,
        generation: options.generation ?? activeGeneration,
      })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      listeners.clear()
      sliceListeners.clear()
    },
  }

  function acceptDocument(options: WorkbenchDocumentApplyOptions, replace = false): boolean {
    if (options.generation !== undefined && (!Number.isSafeInteger(options.generation) || options.generation < 0)) return false
    const ownerChanged = options.ownerKey !== undefined && options.ownerKey !== activeOwnerKey
    if (ownerChanged && !replace) return false
    if (options.generation !== undefined && activeGeneration !== undefined && options.generation < activeGeneration && !(replace && ownerChanged)) return false
    if (options.turnEpoch !== undefined && snapshot.turnEpoch !== undefined
      && options.turnEpoch < snapshot.turnEpoch && !(replace && ownerChanged)) return false
    if (replace && options.ownerKey !== undefined) activeOwnerKey = options.ownerKey
    if (replace && options.generation !== undefined) activeGeneration = options.generation
    return true
  }
}

/** Preview compatibility name; production callers use createWorkbenchRuntime. */
export function createPreviewWorkbenchRuntime(
  initial: Omit<WorkbenchRuntimeSnapshot, 'revision'>,
): PreviewWorkbenchRuntime {
  return createWorkbenchRuntime(initial)
}

function runtimeSnapshotsEqual(left: WorkbenchRuntimeSnapshot, right: WorkbenchRuntimeSnapshot): boolean {
  if (left === right) return true
  // Bug4（2026-08-20）：弃用全量 JSON.stringify 深比较——流式高频 tick 会对整个含全部历史消息
  // 的 snapshot 做一次 O(总字节) 序列化，消息越多越慢（实测 1000 条 ≈1.4ms/tick，成为流式卡顿
  // 源头）。改为逐字段浅比较：messages/tasks/availableModels 等数组字段在 freezeSnapshot 下引用
  // 稳定，引用相同即视为一致。
  return (
    left.sessionId === right.sessionId &&
    left.ownerKey === right.ownerKey &&
    left.generation === right.generation &&
    left.turnEpoch === right.turnEpoch &&
    terminalFencesEqual(left.terminalFence, right.terminalFence) &&
    left.status === right.status &&
    left.messages === right.messages &&
    left.generating === right.generating &&
    left.generationPhase === right.generationPhase &&
    left.generationActivity === right.generationActivity &&
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
    left.livenessSource === right.livenessSource &&
    left.error === right.error
    && left.document === right.document
  )
}

function terminalFencesEqual(left: WorkbenchTerminalFence | undefined, right: WorkbenchTerminalFence | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.ownerKey === right.ownerKey && left.turnEpoch === right.turnEpoch
    && left.eventId === right.eventId && left.sequence === right.sequence && left.arrivalOrdinal === right.arrivalOrdinal
}

/** Atomically reconcile canonical document and generation metadata. */
export function mergeWorkbenchRuntimeSnapshot(
  previous: WorkbenchRuntimeSnapshot,
  input: WorkbenchRuntimeMergeInput,
): WorkbenchRuntimeSnapshot {
  const document = input.document ?? previous.document
  // #204③：legacy `messages` 派生按需门控——仅当宿主真的在用 legacy 字段（预览
  // fixture / 预览宿主写入，数组非空）时才随文档重建；生产恒为空数组 ⇒ 零派生成本。
  const projected = document ? legacyFieldsFromDocument(document, (previous.messages?.length ?? 0) > 0) : {}
  const preserved = input.preserveGeneration ? preserveActiveGeneration(previous, projected, document) : projected
  // #213 活性权威：会话层已用回合时钟表态时，文档派生的 `generating` 一律让位——
  // 重放出的 `running` 尾行只是"没见到终态"的证据，不是"本进程在跑"的证据。
  const livenessSource = input.livenessSource ?? previous.livenessSource
  const stable = applyLivenessAuthority(
    preserved,
    input.livenessGenerating ?? previous.generating,
    livenessSource,
    previous,
  )
  const rawPatch = input.generationPatch ?? {}
  const requestedEpoch = input.turnEpoch ?? rawPatch.turnEpoch
  const previousEpoch = previous.turnEpoch
  // turnEpoch is a monotonic runtime-local fence. A stale clock/document
  // callback may still arrive after a new turn has started, but it must not
  // roll the epoch back or clear the newer turn's terminal state.
  const epochIsOlder = requestedEpoch !== undefined && previousEpoch !== undefined && requestedEpoch < previousEpoch
  const epochIsNew = requestedEpoch !== undefined && (previousEpoch === undefined || requestedEpoch > previousEpoch)
  const effectiveEpoch = epochIsOlder ? previousEpoch : requestedEpoch ?? previousEpoch
  const documentIsTerminal = document !== undefined && hasTerminalDocumentState(document)
  const patchWithoutControl = { ...(epochIsOlder ? {} : rawPatch) }
  delete (patchWithoutControl as { turnEpoch?: number }).turnEpoch
  delete (patchWithoutControl as { terminalFence?: WorkbenchTerminalFence | null }).terminalFence
  const inferredFence = document && hasTerminalDocumentState(document) && previous.generating && previous.turnEpoch !== undefined && previous.terminalFence === undefined
    ? { ownerKey: previous.ownerKey, turnEpoch: previous.turnEpoch, sequence: document.revision }
    : undefined
  const candidate: WorkbenchRuntimeSnapshot = {
    ...previous,
    ...(document ? { ...stable, document, sessionId: document.sessionId || previous.sessionId } : {}),
    ...patchWithoutControl,
    ...(livenessSource !== undefined ? { livenessSource } : {}),
    ...(effectiveEpoch !== undefined ? { turnEpoch: effectiveEpoch } : {}),
    ...(epochIsNew
      ? { terminalFence: undefined }
      : input.terminalFence === null && !epochIsOlder
        ? { terminalFence: undefined }
        : input.terminalFence && !epochIsOlder && input.terminalFence.turnEpoch >= (effectiveEpoch ?? 0)
          ? { terminalFence: input.terminalFence }
          : inferredFence ? { terminalFence: inferredFence } : {}),
  }
  if (epochIsNew) {
    candidate.summary = null
    candidate.terminalFence = undefined
  }
  // A canonical terminal projection is authoritative for the current turn.
  // A late clock patch (TurnClock reconcile, optimistic rollback) can arrive
  // with a stale active flag; never let that patch resurrect the spinner or
  // active-only metadata.
  if (documentIsTerminal && !epochIsNew) {
    candidate.generating = false
    candidate.generationStart = 0
    candidate.generationPhase = undefined
    candidate.generationActivity = undefined
    candidate.thinkingStart = undefined
    if (candidate.terminalFence === undefined && effectiveEpoch !== undefined) {
      candidate.terminalFence = { ownerKey: candidate.ownerKey, turnEpoch: effectiveEpoch }
    }
  } else if (!documentIsTerminal && !epochIsOlder && stable.generating === true && input.document !== undefined && previous.terminalFence !== undefined) {
    // The fence above outlives the evidence that set it as soon as the next
    // canonical projection carries a running turn (for example the user echo
    // after a rebind, or an assistant continuation without a new user turn).
    // A stale fence in that state pins the indicator terminal forever.
    candidate.summary = null
    candidate.terminalFence = undefined
  }
  return normalizeRuntimeSnapshot(candidate)
}

function normalizeRuntimeSnapshot(snapshot: WorkbenchRuntimeSnapshot): WorkbenchRuntimeSnapshot {
  if (snapshot.summary !== null || snapshot.terminalFence !== undefined) {
    // A display-only restored summary must not synthesize a terminal fence:
    // the fence is only cleared by a turn-epoch advance or an explicit null,
    // so a synthesized one would pin the indicator terminal and block the
    // next TurnClock-driven generation from restarting it.
    const synthesizedFence = snapshot.summary?.displayOnly === true
      ? undefined
      : snapshot.turnEpoch !== undefined ? { ownerKey: snapshot.ownerKey, turnEpoch: snapshot.turnEpoch } : undefined
    const terminalFence = snapshot.terminalFence ?? synthesizedFence
    return { ...snapshot, generating: false, generationStart: 0, generationPhase: undefined, generationActivity: undefined, thinkingStart: undefined, ...(terminalFence ? { terminalFence } : {}) }
  }
  if (snapshot.generating) return { ...snapshot, summary: null, terminalFence: undefined }
  return snapshot
}

function freezeSnapshot(snapshot: WorkbenchRuntimeSnapshot): WorkbenchRuntimeSnapshot {
  if (!Object.isFrozen(snapshot.messages)) snapshot.messages = Object.freeze([...snapshot.messages])
  if (!Object.isFrozen(snapshot.tasks)) snapshot.tasks = Object.freeze([...snapshot.tasks])
  if (snapshot.document && !Object.isFrozen(snapshot.document)) snapshot.document = freezeDocument(snapshot.document)
  if (snapshot.terminalFence && !Object.isFrozen(snapshot.terminalFence)) snapshot.terminalFence = Object.freeze({ ...snapshot.terminalFence })
  return Object.freeze(snapshot)
}

// JSC 把 `Object.freeze` 过的数组转入字典元素模式——此后逐位读取/拷贝按哈希走，
// 实测 40k 行数组单次遍历从 ~0.1ms 退化到 ~10ms。大集合改为项级冻结 + copy-on-write
// 纪律，数组本身保持 packed；小集合维持整体冻结的原契约。
const FROZEN_ARRAY_ELEMENT_LIMIT = 2048

function freezeLargeAware<T>(items: readonly T[]): readonly T[] {
  return items.length <= FROZEN_ARRAY_ELEMENT_LIMIT ? Object.freeze(items) : items
}

function freezeDocument(document: WorkbenchDocument, previous?: WorkbenchDocument): WorkbenchDocument {
  // P57 S2-R1b：全部元素与 previous 逐项引用相等时，直接返回 previousItems 原引用
  //（已冻结）。此前 items.map 恒产生新数组 → snapshot 侧数组引用每事件必新，
  // 一切数组引用 memo（legacy fields / 显示链包装）全部落空。
  //
  // #204③ 解冻基线：**数组本身不再整体 Object.freeze**（JSC 上对大数组是 O(N)
  // 高成本操作，40k ≈ 18ms/次，曾占 live 每帧成本的绝大部分），改为逐项校验：
  // 与上一帧引用相等的项（上一帧已冻结）直接沿用，新项若未冻结才走 freezeItem
  // ——投影器已改为**建时冻结**（见 workbenchProjector.freezeDeepSnapshot），故
  // live 每帧的稳态成本 = O(N) 指针比对 + 0 克隆 + 0 数组分配。数组可变性纪律
  // 由投影器/运行时的 copy-on-write 承担（快照不再提供数组级冻结防线）。
  const freezeItems = <T extends object>(
    items: readonly T[],
    previousItems?: readonly T[],
    freezeItem: (item: T) => T = item => Object.freeze({ ...item }) as T,
  ): readonly T[] => {
    // 同一数组引用：上一帧已处理过，恒等返回（不做 isFrozen——JSC 对未冻结大数组的
    // Object.isFrozen 本身是 O(N) 遍历）。
    if (items === previousItems) return items
    // #204③ 解冻基线：数组本身不再整体 Object.freeze（JSC 上 40k ≈ 18ms/次，曾占
    // live 每帧成本的绝大部分）。改两遍扫描：
    //   ① 逐位引用比对（上一帧同位项按归纳已冻结，O(1) 沿用）；引用不同的项用
    //      Object.isFrozen（O(1) 小对象判定）确认投影器建时冻结是否已生效；
    //   ② 稳态（live 每帧只有尾部 1–2 个新项且已冻结）⇒ 零克隆、零分配直接返回；
    //      仅当存在未冻结的新项（非投影器来源的首折/外部文档）才拷贝补冻。
    // 数组可变性纪律由投影器/运行时的 copy-on-write 承担（快照不再提供数组级冻结防线）。
    if (previousItems !== undefined) {
      let allRefEqual = items.length === previousItems.length
      let needsFreeze = false
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!
        if (item === previousItems[index]) continue
        allRefEqual = false
        if (!Object.isFrozen(item)) { needsFreeze = true; break }
      }
      if (!needsFreeze) {
        // 全等且等长 → previous 原引用（P57 S2-R1b 引用稳定契约）；否则返回 items
        //（携带着新增/替换的已冻结项，零分配）。
        return allRefEqual ? previousItems : items
      }
      const copied = [...items]
      for (let index = 0; index < copied.length; index += 1) {
        const item = copied[index]!
        if (item === previousItems[index] || Object.isFrozen(item)) continue
        copied[index] = freezeItem(item)
      }
      return freezeLargeAware(copied)
    }
    const mapped = items.map((item, index) => item === previousItems?.[index] && Object.isFrozen(item)
      ? item
      : freezeItem(item))
    return freezeLargeAware(mapped)
  }
  const session = document.session === previous?.session && Object.isFrozen(document.session)
    ? document.session
    : Object.freeze({
      ...document.session,
      ...(document.session.usage ? { usage: freezeUsage(document.session.usage) } : {}),
      commands: document.session.commands === previous?.session.commands && Object.isFrozen(document.session.commands)
        ? document.session.commands
        : Object.freeze(document.session.commands.map(command => Object.freeze({
          ...command,
          ...(command.raw ? { raw: freezeJsonRecord(command.raw) } : {}),
        }))),
      options: document.session.options === previous?.session.options && Object.isFrozen(document.session.options)
        ? document.session.options
        : Object.freeze(document.session.options.map(option => Object.freeze({
          ...option,
          ...(option.value !== undefined ? { value: freezeJsonValue(option.value) } : {}),
          ...(option.schema !== undefined ? { schema: freezeJsonValue(option.schema) } : {}),
          ...(option.raw ? { raw: freezeJsonRecord(option.raw) } : {}),
        }))),
    })
  const plan = document.plan === previous?.plan && Object.isFrozen(document.plan)
    ? document.plan
    : Object.freeze({
      ...document.plan,
      entries: freezeItems(document.plan.entries, previous?.plan.entries),
    })
  const extensions = document.extensions === previous?.extensions && Object.isFrozen(document.extensions)
    ? document.extensions
    : Object.freeze(document.extensions.map(extension => Object.freeze({
      ...extension,
      payload: freezeJsonValue(extension.payload),
      // SAFETY: content part 按 contentPartSchema 构造，本就是 JSON；freezeJsonValue 保形返回。
      fallback: Object.freeze(extension.fallback.map(part => freezeJsonValue(part as unknown as JsonValue))) as typeof extension.fallback,
      identity: Object.freeze({ ...extension.identity }),
      source: Object.freeze({ ...extension.source }),
      provenance: Object.freeze({
        ...extension.provenance,
        ...(extension.provenance.synthetic ? { synthetic: Object.freeze({ ...extension.provenance.synthetic }) } : {}),
      }),
    })))
  return Object.freeze({
    ...document,
    appliedEventIds: document.appliedEventIds === previous?.appliedEventIds && Object.isFrozen(document.appliedEventIds) ? document.appliedEventIds : Object.freeze([...document.appliedEventIds]),
    appliedRanges: document.appliedRanges === previous?.appliedRanges && Object.isFrozen(document.appliedRanges) ? document.appliedRanges : Object.freeze(document.appliedRanges.map(range => Object.freeze([range[0], range[1]]) as readonly [number, number])),
    timeline: freezeItems(document.timeline, previous?.timeline),
    messages: freezeItems(document.messages, previous?.messages, freezeDeepSnapshot),
    activities: freezeItems(document.activities, previous?.activities, freezeDeepSnapshot),
    interactions: freezeItems(document.interactions, previous?.interactions, freezeDeepSnapshot),
    extensions,
    diagnostics: freezeItems(document.diagnostics, previous?.diagnostics, freezeDeepSnapshot),
    session,
    assist: document.assist === previous?.assist && Object.isFrozen(document.assist)
      ? document.assist
      : Object.freeze({
        ...document.assist,
        files: Object.freeze([...document.assist.files]),
        ...(document.assist.prediction ? { prediction: Object.freeze({
          ...document.assist.prediction,
          actions: Object.freeze(document.assist.prediction.actions.map(freezeJsonValue)),
        }) } : {}),
      }),
    plan,
  })
}

function freezeUsage(usage: NonNullable<WorkbenchDocument['session']['usage']>): NonNullable<WorkbenchDocument['session']['usage']> {
  return Object.freeze({
    ...usage,
    ...(usage.budget ? { budget: Object.freeze({ ...usage.budget }) } : {}),
    ...(usage.raw ? { raw: freezeJsonRecord(usage.raw) } : {}),
  })
}

function freezeJsonRecord(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, freezeJsonValue(nested)])))
}

function freezeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    const frozen = value.map(freezeJsonValue)
    Object.freeze(frozen)
    return frozen
  }
  if (value && typeof value === 'object') return freezeJsonRecord(value)
  return value
}

// #204③ legacy messages 派生链退役：`snapshot.messages` 在生产没有任何写入者
// （P52 D4 后 replay commit 适配器是文档化 no-op，agentWorkbenchLifecycle.replayAdapter）
// 与有效读取者（SolidWorkbenchApp/scheduler 的 legacy 分支都是 document 缺席时的
// fallback，而 runtime 恒有 document；WorkbenchMessage 无 tool 角色 ⇒ tool 合并恒空转）。
// 字段保留为**预览宿主输入**（documentFromLegacy + update({messages})，预览兼容面），
// 派生不再执行 ⇒ 每帧 O(M) 数组重建 + 大数组冻结消失。
// 派生里唯一仍有消费者的部分是 running 行记账（generating/phase/thinkingStart 的
// document 侧证据）——降为无分配单趟扫描。
interface RunningState {
  firstRunning?: WorkbenchMessage
  lastRunning?: WorkbenchMessage
  runningReasoning?: WorkbenchMessage
}

const runningStateMemo = new WeakMap<readonly WorkbenchMessage[], RunningState>()

function runningStateOf(source: readonly WorkbenchMessage[]): RunningState {
  const cached = runningStateMemo.get(source)
  if (cached) return cached
  let firstRunning: WorkbenchMessage | undefined
  let lastRunning: WorkbenchMessage | undefined
  let runningReasoning: WorkbenchMessage | undefined
  for (const message of source) {
    if (!message.running) continue
    firstRunning ??= message
    lastRunning = message
    if (message.role === 'reasoning') runningReasoning = message
  }
  const result: RunningState = { firstRunning, lastRunning, runningReasoning }
  runningStateMemo.set(source, result)
  return result
}

// Cache the remaining fields by the references and session values they consume.
let legacyFieldsMemo: {
  readonly messages: unknown
  readonly activities: unknown
  readonly diagnostics: unknown
  readonly sessionStatus: unknown
  readonly sessionModel: unknown
  readonly sessionMode: unknown
  readonly value: Partial<WorkbenchRuntimeSnapshot>
} | undefined

// #204③：legacy `messages` 派生（按需）。单条 WorkbenchMessage → legacy Message 按
// 消息引用缓存（append-delta 只重投影变化行）；仅在宿主 legacy 字段非空（预览宿主/
// fixture）时被调用，生产路径恒空数组 ⇒ 不进入。
const legacyMessageMemo = new WeakMap<WorkbenchMessage, Message>()

function legacyMessageOf(message: WorkbenchMessage): Message {
  const cached = legacyMessageMemo.get(message)
  if (cached) return cached
  const projected: Message = {
    id: message.id,
    role: message.role === 'reasoning' ? 'reasoning' : message.role === 'user' ? 'user' : 'assistant',
    sender: message.source.provider, content: message.content, time: message.time, running: message.running,
  }
  legacyMessageMemo.set(message, projected)
  return projected
}

const legacyMessagesMemo = new WeakMap<readonly WorkbenchMessage[], readonly Message[]>()

function projectLegacyMessages(source: readonly WorkbenchMessage[]): readonly Message[] {
  const cached = legacyMessagesMemo.get(source)
  if (cached) return cached
  const derived = Object.freeze(source.map(legacyMessageOf))
  legacyMessagesMemo.set(source, derived)
  return derived
}

function legacyFieldsFromDocument(document: WorkbenchDocument, deriveLegacyMessages: boolean): Partial<WorkbenchRuntimeSnapshot> {
  const memo = legacyFieldsMemo
  if (memo !== undefined
    && memo.messages === document.messages
    && memo.activities === document.activities
    && memo.diagnostics === document.diagnostics
    && memo.sessionStatus === document.session.status
    && memo.sessionModel === document.session.model
    && memo.sessionMode === document.session.mode) {
    return memo.value
  }
  const { firstRunning, lastRunning: lastRunningMessage, runningReasoning } = runningStateOf(document.messages)
  // #204③：倒序扫描（免 `[...].reverse()` 每帧两份数组分配）；命中即返回，未命中
  // 走满也只是无分配的整数/字符串比较。
  let error: string | null = null
  for (let index = document.diagnostics.length - 1; index >= 0; index -= 1) {
    const diagnostic = document.diagnostics[index]!
    if (diagnostic.level === 'error') {
      error = diagnostic.message
      break
    }
  }
  const status = document.session.status === 'error' || document.session.status === 'degraded' || document.session.status === 'loading' || document.session.status === 'ready' || document.session.status === 'idle'
    ? document.session.status
    : document.session.status === 'completed' ? 'ready' : 'ready'
  let runningActivity: WorkbenchActivityNode | undefined
  for (let index = document.activities.length - 1; index >= 0; index -= 1) {
    const activity = document.activities[index]!
    if (!isTerminalActivityStatus(activity.status)) {
      runningActivity = activity
      break
    }
  }
  // Lifecycle status alone is not evidence of an active turn. Require a
  // running message/activity so mode strings and stale status cannot revive
  // a completed generation.
  const generating = firstRunning !== undefined || runningActivity !== undefined
  const generationStart = generating
    ? firstTimestamp([
        firstRunning?.time,
        runningActivity?.startedAt,
      ]) ?? Date.now()
    : 0
  const lastTokenAt = generating
    ? lastTimestamp([
        lastRunningMessage?.time,
        runningActivity?.startedAt,
      ]) ?? generationStart
    : undefined
  const value: Partial<WorkbenchRuntimeSnapshot> = {
    // `messages` 仅在宿主 legacy 字段非空（预览宿主/fixture 兼容面）时随文档派生；
    // 生产恒空数组 ⇒ 不派生（见 mergeWorkbenchRuntimeSnapshot 的门控）。
    ...(deriveLegacyMessages ? { messages: projectLegacyMessages(document.messages) } : {}),
    status,
    activeModel: document.session.model ?? '',
    activeMode: document.session.mode ?? 'default',
    generating,
    generationStart,
    lastTokenAt,
    generationPhase: runningReasoning
      ? { kind: 'thinking' }
      : runningActivity
        ? { kind: 'tool', name: runningActivity.title || runningActivity.providerName || '?' }
        : lastRunningMessage?.role === 'assistant'
          ? { kind: 'responding' }
          : generating ? { kind: 'thinking' } : undefined,
    thinkingStart: timestampOf(runningReasoning?.time),
    error,
  }
  legacyFieldsMemo = {
    messages: document.messages,
    activities: document.activities,
    diagnostics: document.diagnostics,
    sessionStatus: document.session.status,
    sessionModel: document.session.model,
    sessionMode: document.session.mode,
    value,
  }
  return value
}

/**
 * Reconcile a canonical document projection with the host's live generation
 * clock (P52 D3: the clock owner is the session TurnClock).  `legacyFieldsFromDocument`
 * is intentionally deterministic, but an in-flight projection may contain no
 * running message/activity (or may carry a transient session status).  Falling
 * back to `Date.now()` in that window makes the footer jump back to 0–1s.
 * The TurnClock remains the source of truth for the active turn, so retain its
 * ephemeral fields until it explicitly publishes the terminal state.
 */
function preserveActiveGeneration(
  previous: WorkbenchRuntimeSnapshot,
  projected: Partial<WorkbenchRuntimeSnapshot>,
  document?: WorkbenchDocument,
): Partial<WorkbenchRuntimeSnapshot> {
  if (!previous.generating) return projected
  if (previous.summary !== null || previous.terminalFence !== undefined) return projected
  if (document && hasTerminalDocumentState(document)) return projected
  return {
    ...projected,
    generating: true,
    ...(previous.generationStart > 0 ? { generationStart: previous.generationStart } : {}),
    ...(previous.lastTokenAt !== undefined ? { lastTokenAt: previous.lastTokenAt } : {}),
    ...(previous.generationPhase !== undefined ? { generationPhase: previous.generationPhase } : {}),
    ...(previous.generationActivity !== undefined ? { generationActivity: previous.generationActivity } : {}),
    ...(previous.thinkingStart !== undefined ? { thinkingStart: previous.thinkingStart } : {}),
  }
}

/**
 * #213：会话层已就该 source 表态（`livenessSource` 为 `'kernel'` 或 `'clock'`）时，
 * 活性只认权威值，文档派生让位。
 *
 * `'kernel'`（#217/ADR-0017）：内核在途回合标记的表态，优先级最高；
 * `'clock'`：本进程回合时钟的表态。两者语义同构——权威说「在跑」⇒ 保住 generating
 * 与起点（文档短暂缺 running 行不得让 elapsed 归零）；权威说「没在跑」⇒ generating
 * 与整条活动轴（phase/activity/thinking）一并落定为静止，否则重放出来的 `running`
 * 尾行会把它复活成「正在思考…」。其余字段（messages/status/tokenCount…）仍由文档
 * 派生，不受影响。
 *
 * `authoritativeGenerating` 由调用方给出（`livenessGenerating`），缺省回落到 `previous.generating`。
 */
function applyLivenessAuthority(
  preserved: Partial<WorkbenchRuntimeSnapshot>,
  authoritativeGenerating: boolean,
  livenessSource: WorkbenchRuntimeSnapshot['livenessSource'],
  previous: WorkbenchRuntimeSnapshot,
): Partial<WorkbenchRuntimeSnapshot> {
  if (livenessSource !== 'clock' && livenessSource !== 'kernel') return preserved
  if (authoritativeGenerating) {
    return {
      ...preserved,
      generating: true,
      ...(previous.generationStart > 0 ? { generationStart: previous.generationStart } : {}),
    }
  }
  return {
    ...preserved,
    generating: false,
    generationStart: 0,
    generationPhase: undefined,
    generationActivity: undefined,
    thinkingStart: undefined,
  }
}

// #204③：终态是投影器的**吸收态**——`session.completed|failed` 折入时 reduceSession
// 必置 session.status 为同一终态，且 terminalRegression 阻止任何非终态回写；
// `turn.failed/provider.error` 经 addDiagnostic 置 'error'。因此「timeline 存在终态
// session 条目」⇔「session.status 为终态」，逐条 timeline 扫描（每次 publish 的隐藏
// O(N)）删为 O(1) 状态判定。仍只认显式生命周期终态事件为证据：completed
// assistant/reasoning 行不是——provider 可能对同一回合补发迟到的 tool.started。
const TERMINAL_DOCUMENT_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'cancelled', 'failed'])

function hasTerminalDocumentState(document: WorkbenchDocument): boolean {
  return TERMINAL_DOCUMENT_STATUSES.has(document.session.status.toLowerCase())
}

function isTerminalActivityStatus(status: string): boolean {
  return ['completed', 'failed', 'error', 'cancelled', 'killed', 'timeout'].includes(status.toLowerCase())
}

function timestampOf(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function firstTimestamp(values: readonly (string | undefined)[]): number | undefined {
  const timestamps = values.map(timestampOf).filter((value): value is number => value !== undefined)
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined
}

function lastTimestamp(values: readonly (string | undefined)[]): number | undefined {
  const timestamps = values.map(timestampOf).filter((value): value is number => value !== undefined)
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined
}

type WorkbenchDocumentSlice = NonNullable<WorkbenchRuntimeSnapshot['document']>

/** `selectSlice` 的全部可能产物（按 slice 名分派）。
 *  运行时按名取值天然是异构的，故用命名联合表达；调用方经 `getSlice<T>` 收窄。 */
type WorkbenchSliceValue =
  | WorkbenchRuntimeSnapshot['document']
  | WorkbenchDocumentSlice['timeline']
  | WorkbenchRuntimeSnapshot['messages']
  | WorkbenchDocumentSlice['messages']
  | WorkbenchDocumentSlice['activities']
  | WorkbenchDocumentSlice['interactions']
  | WorkbenchDocumentSlice['extensions']
  | WorkbenchDocumentSlice['session']
  | WorkbenchDocumentSlice['session']['usage']
  | WorkbenchDocumentSlice['session']['options']
  | WorkbenchDocumentSlice['session']['commands']
  | ReturnType<typeof selectPlan>
  | ReturnType<typeof selectGoal>
  | WorkbenchDocumentSlice['assist']
  | WorkbenchDocumentSlice['diagnostics']
  | WorkbenchRuntimeSnapshot['tasks']
  | { canAttach: WorkbenchRuntimeSnapshot['canAttach']; promptImage: WorkbenchRuntimeSnapshot['promptImage'] }

function selectSlice(snapshot: WorkbenchRuntimeSnapshot, slice: WorkbenchRuntimeSlice): WorkbenchSliceValue {
  const document = snapshot.document
  switch (slice) {
    case 'document': return document
    case 'timeline': return document?.timeline ?? []
    case 'messages': return document?.messages ?? snapshot.messages
    case 'activities': return document?.activities ?? []
    case 'interactions': return document?.interactions ?? []
    case 'extensions': return document?.extensions ?? []
    case 'session': return document?.session
    case 'usage': return document?.session.usage
    case 'config': return document?.session.options ?? []
    case 'commands': return document?.session.commands ?? []
    case 'plan': return document ? selectPlan(document) : undefined
    case 'goal': return document ? selectGoal(document) : undefined
    case 'assist': return document?.assist
    case 'diagnostics': return document?.diagnostics ?? []
    case 'tasks': return snapshot.tasks
    case 'capabilities': return { canAttach: snapshot.canAttach, promptImage: snapshot.promptImage }
  }
}

function sliceChanged(left: WorkbenchRuntimeSnapshot, right: WorkbenchRuntimeSnapshot, slice: WorkbenchRuntimeSlice): boolean {
  if (slice === 'capabilities') return left.canAttach !== right.canAttach || left.promptImage !== right.promptImage
  return selectSlice(left, slice) !== selectSlice(right, slice)
}

function documentFromLegacy(snapshot: Omit<WorkbenchRuntimeSnapshot, 'revision'> | WorkbenchRuntimeSnapshot): WorkbenchDocument {
  const base = createWorkbenchDocument(snapshot.sessionId ?? '')
  const messages: WorkbenchMessage[] = snapshot.messages.map(message => ({
    id: message.id,
    segmentId: message.id,
    role: message.role === 'reasoning' ? 'reasoning' : message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
    parts: [],
    identity: {},
    source: { provider: message.sender, sessionId: snapshot.sessionId ?? '', sourceId: message.sender },
    sequence: 0,
    running: message.running === true,
    time: message.time,
  }))
  return {
    ...base,
    messages,
    plan: {
      ...base.plan,
      entries: normalizePlanEntries(snapshot.tasks),
    },
    session: {
      ...base.session,
      status: snapshot.status,
      model: snapshot.activeModel || undefined,
      mode: snapshot.activeMode || undefined,
      usage: undefined,
    },
  }
}

const legacyDocumentFields: readonly (keyof WorkbenchRuntimeSnapshot)[] = [
  'sessionId', 'status', 'messages', 'activeModel', 'activeMode', 'error',
]
