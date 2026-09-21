// 投影核（WP2 workbench 折叠）的 wasm 装载、帧编码与文档物化——issue #220。
//
// 这一层是 JS 编排与 Rust 计算核之间的**唯一投影过界通道**：
// - 折叠状态住 wasm（`src-tauri/pylon-compute/src/projector/workbench.rs` 的
//   `PylonProjector`）；JS 侧文档是 wasm 产出的物化视图，`WorkbenchDocument`
//   形状与退役前的 TS 折叠逐字段一致（parity 门禁见
//   `src/domains/workbench/__tests__/projectorComputeParity.test.ts`）。
// - 批量入口是唯一形态：一页事件编码**一帧**过界（`appendBatch`），回放按
//   `EventPage` 页级合批，禁止逐事件 append 循环（spec「边界约定」生死线）。
// - 热边界禁 JSON：帧内事件类型是词表 u32 索引（词表以 wasm 出口
//   `projectorEventTypes` 为单源），字符串只留内容本体与预计算字段；
//   serde_json 只碰冷事件的整块富载荷（进字串池，一次性解析）。
// - 边界输出是增量 patch（`appendBatch` 返回值）；本层物化 JS 文档走
//   `document()` 全量读——patch 目前不携带 activities/diagnostics/plan/goal/
//   lifecycle/systemErrors/assist 等切片（Rust 侧 `WorkbenchPatch` 结构所限），
//   只靠 patch 无法物化完整文档，`document()` 是 Rust 头注认可的
//   parity/冷刷新读数。每页固定 2 次过界（帧进 + 文档出），与页内事件数无关。
// - 物化层保持 TS 折叠时代的**结构共享契约**（#205/P57）：patch 判定未变化的
//   切片沿用上一份文档的引用（未触碰的切片按事件族整片复用，append-only 的
//   diagnostics/systemErrors 按长度判等），appliedEventIds/appliedRanges 冻结。
//   这既是公开契约（runtime 的 memo 链靠引用稳定），也让幂等折叠恒等返回原文档。
//
// 装载模型：**环境无关**的那半在 `wasmRuntime.ts`——测试宿主（vitest / bun）由
// `scripts/wasmPreload.ts` 预初始化，因此行为测试可以同步调用折叠出口；浏览器走
// glue 的 fetch 分支，同步调用方在就绪前得到显式报错，会话层在 `bind` 首行
// `await whenProjectorComputeReady()` 后才开折叠。产品源码里没有 `node:*`（重构前
// 这里内联的 `node:fs` 让前端门禁 job 在干净检出上直接 TS2307），也不用顶层 await
// （Vite 生产构建 target 是 es2020，TLA 会让 esbuild 转译阶段失败）。装载失败不吞异常。
/// <reference types="node" />

import __wbgInit, * as glueNamespace from '../../wasm/pylon-compute/pylon_compute.js'

import { createComputeRuntime } from './wasmRuntime.ts'
import type {
  WorkbenchDocument,
  WorkbenchProjectionDiagnostic,
} from '../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'

/** wasm 计算核的投影段出口（与 Rust `#[wasm_bindgen]` 薄壳一一对应）。 */
export interface PylonProjectorInstance {
  /** 页级批量入口：消费一帧紧凑列式帧，返回增量 patch JSON 文本。 */
  appendBatch(frame: Uint8Array): string
  /** 全量读数：返回 WorkbenchDocument JSON 文本（null 保真，JS 侧 JSON.parse）。 */
  document(): string
  /**
   * 诊断读数：上次批量入口的 decode / project / patch 序列化耗时（毫秒）。
   * 只给性能调查与基准脚本用，生产路径不读——它不影响投影语义。
   */
  foldPhases(): string
}

interface ProjectorGlue {
  PylonProjector: new (sessionId: string) => PylonProjectorInstance
  projectorEventTypes(): string[]
}

/** 单条 message upsert 的紧凑追加形态（Rust `MessageAppendPatch`，camelCase）。 */
export interface ProjectorMessageAppend {
  contentTail: string
  lastPart?:
    | { mode: 'textTail', tail: string, kind?: string, language?: string | null }
    | { mode: 'rewritten', value: unknown }
  pushedParts?: readonly unknown[]
  identity?: unknown
  sequence?: unknown
  running?: boolean
}

/** 单条 message upsert：`append`（紧凑追加）与 `message`（全量）互斥、恰有一者。 */
export interface ProjectorMessageUpsert {
  index: number
  message?: unknown
  append?: ProjectorMessageAppend
}

/** `appendBatch` 返回的增量 patch DTO（Rust `WorkbenchPatch`，camelCase）。 */
export interface ProjectorPatch {
  revision: number
  appliedEventIdsAppended: string[]
  appliedRanges: [number, number][]
  /** 带下标：消费方据此把 upsert 精确合并进上一份数组（追加/替换/中插同一套）。 */
  timelineUpserts: readonly { index: number, entry: unknown }[]
  messageUpserts: readonly ProjectorMessageUpsert[]
  session: unknown
  /** 批后长度——合并时区分「插入」与「替换」的依据。 */
  timelineLength: number
  messageLength: number
  /** 低频切片：**仅在脏时携带**；缺省表示沿用上一份引用（结构性共享的落点）。 */
  activities?: readonly unknown[]
  interactions?: readonly unknown[]
  extensions?: readonly unknown[]
  assist?: unknown
  diagnostics?: readonly unknown[]
  plan?: unknown
  goal?: unknown
  lifecycle?: unknown
  systemErrors?: readonly unknown[]
}

/**
 * 下标序 upsert 与上一份数组的**精确合并**。
 *
 * `afterLength` 是批后长度，用来区分三种情况，同一个循环即可，无需知道本次是哪一种：
 * - **纯追加**：upsert 的 index 落在 `previous.length` 之后 ⇒ 前半段照抄上一份；
 * - **就地替换**：index 在上一份范围内 ⇒ 取 upsert，且**不推进**上一份游标（那一位已被替换）；
 * - **尾部之后的中插**（乱序回放页）：index 夹在中间 ⇒ 取 upsert、不推进游标 ⇒ 后续元素整体后移。
 */
function mergeByIndex<T>(
  previous: readonly T[],
  upserts: readonly { index: number, value: T }[],
  afterLength: number,
): readonly T[] {
  if (upserts.length === 0) return previous
  // **纯追加快路径**：一条 upsert、落在末尾、长度只加一 —— 这正是 live 逐事件折叠的常态。
  // 走慢路径时它也要按 `afterLength` 逐元素过一遍带分支的循环，N=2000 时实测 ~13µs/次，
  // 占 live 全程的 **41%**（#220 §30 子 agent 调查的消融结论）。`[...previous, v]` 走 V8
  // 的数组克隆快路径。
  //
  // 等价性：慢路径在 `index < previous.length` 上恒 `next.index !== index`（唯一那条
  // upsert 的下标就是 `previous.length`）⇒ 逐位照抄；最后一位写 value ⇒ 与快路径同结果。
  const only = upserts[0]
  if (upserts.length === 1 && only !== undefined
    && afterLength === previous.length + 1 && only.index === previous.length) {
    return Object.freeze([...previous, only.value])
  }
  const out = new Array<T>(afterLength)
  let upsertAt = 0
  let previousAt = 0
  for (let index = 0; index < afterLength; index += 1) {
    const next = upserts[upsertAt]
    if (next !== undefined && next.index === index) {
      out[index] = next.value
      upsertAt += 1
    } else {
      out[index] = previous[previousAt] as T
      previousAt += 1
    }
  }
  return Object.freeze(out)
}

/** 低频切片：patch 带了就用新的，没带就沿用上一份引用。 */
function sliceOf<T>(carried: T | undefined, previous: T): T {
  return carried === undefined ? previous : carried
}

/**
 * 紧凑追加形态 → 完整消息。生产路径每事件一次（live 逐事件折叠），必须保持 O(尾巴)：
 * content 用字符串拼接（V8 cons-string，摊销 O(1)），parts 浅拷贝只碰末部件。
 * 展开保留上一份的键序——全量形态的键序是 wire 的字典序，紧凑链式应用不破坏它
 * （`applyPatch` 的逐字节 JSON 断言依赖这一点，见其头注）。
 */
function applyMessageAppend(
  previous: WorkbenchDocument['messages'][number],
  append: ProjectorMessageAppend,
): WorkbenchDocument['messages'][number] {
  let parts: readonly unknown[] = previous.parts
  const pushed = append.pushedParts ?? []
  if (append.lastPart !== undefined) {
    const array = parts as readonly unknown[]
    const lastIndex = array.length - 1
    const tail = append.lastPart.mode === 'rewritten'
      ? append.lastPart.value
      : applyLastPartTextTail(array[lastIndex], append.lastPart)
    parts = [...array.slice(0, lastIndex), tail, ...pushed]
  } else if (pushed.length > 0) {
    parts = [...parts, ...pushed]
  }
  return {
    ...previous,
    content: previous.content + append.contentTail,
    parts,
    ...(append.identity !== undefined ? { identity: append.identity } : {}),
    ...(append.sequence !== undefined ? { sequence: append.sequence } : {}),
    ...(append.running !== undefined ? { running: append.running } : {}),
  } as WorkbenchDocument['messages'][number]
}

/** 末部件文本尾巴 + kind/language 覆写。`language: null` 表示移除该字段。 */
function applyLastPartTextTail(part: unknown, delta: { tail: string, kind?: string, language?: string | null }): unknown {
  const next = { ...(part as Record<string, unknown>) }
  next.text = typeof next.text === 'string' ? next.text + delta.tail : delta.tail
  if (delta.kind !== undefined) next.kind = delta.kind
  if (delta.language !== undefined) {
    if (delta.language === null) delete next.language
    else next.language = delta.language
  }
  return next
}

/** 单条 message upsert → 完整消息值；紧凑形态对上一份消息就地应用。 */
function messageUpsertValue(
  previous: WorkbenchDocument['messages'][number] | undefined,
  upsert: ProjectorMessageUpsert,
): WorkbenchDocument['messages'][number] {
  if (upsert.append === undefined) {
    if (upsert.message === undefined) {
      throw new Error('message upsert 既无 append 也无 message——patch DTO 契约破坏')
    }
    return upsert.message as WorkbenchDocument['messages'][number]
  }
  // Rust 侧判据保证紧凑条目的 index 落在批前区间内；缺失即跨语言契约失配，
  // 静默吞掉会把丢内容变成无声陈旧读，必须炸出来。
  if (previous === undefined) {
    throw new Error(`message append 缺批前基准（index=${upsert.index}）——patch DTO 契约破坏`)
  }
  return applyMessageAppend(previous, upsert.append)
}

/**
 * 把 patch 应用到**上一份文档**上——热路径唯一的物化方式。
 *
 * 取代旧的「每折叠一次 `document()` 全量读 + 按启发式决定切片复用」：那次全量读是
 * Θ(文档) 的 JSON 序列化+parse+重建，逐事件折叠时就是 Θ(N²)（实测 1000 次
 * `document()`+parse = 1512ms ≈ live 总耗时）。现在边界只走一次 patch，且**要不要换切片
 * 由 Rust 侧的写点记账给出**（不再靠事件类型猜）。
 */
function applyPatch(
  state: ProjectorState,
  previous: WorkbenchDocument,
  patch: ProjectorPatch,
): WorkbenchDocument {
  const sessionJson = JSON.stringify(patch.session)
  // **键序刻意取字典序**：文档的 JSON 形状此前由 wasm 侧产出（`document()` 的 serde_json
  // Map 是 BTreeMap ⇒ 字典序），而仓库里有逐字节比较文档 JSON 的断言（例如 appliedRanges
  // 的「分两次折 == 一次折」）。冷路径（`coldMaterialize`）沿用 Rust 产出物，热路径若在这
  // 里按可读顺序写字面量，同一条断言就会因为键序不同而红——那不是行为差异，是键序差异。
  // 所以不要为了字面量好看而调整下面的字段顺序。
  const next = {
    activities: sliceOf(patch.activities, previous.activities) as WorkbenchDocument['activities'],
    appliedEventIds: patch.appliedEventIdsAppended.length === 0
      ? previous.appliedEventIds
      : Object.freeze([...previous.appliedEventIds, ...patch.appliedEventIdsAppended]),
    appliedRanges: rangesEqual(patch.appliedRanges, previous.appliedRanges)
      ? previous.appliedRanges
      : freezeAppliedRanges(patch.appliedRanges),
    assist: sliceOf(patch.assist, previous.assist) as WorkbenchDocument['assist'],
    diagnostics: sliceOf(patch.diagnostics, previous.diagnostics) as WorkbenchDocument['diagnostics'],
    extensions: sliceOf(patch.extensions, previous.extensions) as WorkbenchDocument['extensions'],
    goal: sliceOf(patch.goal, previous.goal) as WorkbenchDocument['goal'],
    interactions: sliceOf(patch.interactions, previous.interactions) as WorkbenchDocument['interactions'],
    lifecycle: sliceOf(patch.lifecycle, previous.lifecycle) as WorkbenchDocument['lifecycle'],
    messages: mergeByIndex(
      previous.messages,
      patch.messageUpserts.map(upsert => ({
        index: upsert.index,
        value: messageUpsertValue(previous.messages[upsert.index], upsert),
      })),
      patch.messageLength,
    ),
    plan: sliceOf(patch.plan, previous.plan) as WorkbenchDocument['plan'],
    revision: patch.revision,
    session: state.lastSessionJson === sessionJson
      ? previous.session
      : patch.session as WorkbenchDocument['session'],
    sessionId: previous.sessionId,
    systemErrors: sliceOf(patch.systemErrors, previous.systemErrors) as WorkbenchDocument['systemErrors'],
    timeline: mergeByIndex(
      previous.timeline,
      patch.timelineUpserts.map(upsert => ({
        index: upsert.index,
        value: upsert.entry as WorkbenchDocument['timeline'][number],
      })),
      patch.timelineLength,
    ),
  } satisfies WorkbenchDocument
  state.lastSessionJson = sessionJson
  // 幂等折叠（重复事件/已覆盖区间）：全部切片引用相等 ⇒ 恒等返回上一份文档。
  for (const key of Object.keys(next) as (keyof WorkbenchDocument)[]) {
    if (next[key] !== previous[key]) return next
  }
  return previous
}

/** 一次页级折叠的边界产物：增量 patch + 物化后的完整 JS 文档。 */
export interface ProjectorFoldPage {
  readonly patch: ProjectorPatch
  readonly document: WorkbenchDocument
}

const glue = glueNamespace as unknown as ProjectorGlue
const runtime = createComputeRuntime('pylon-compute（投影）', glue, () => __wbgInit())

/**
 * 已就绪的 glue 命名空间。**同步出口必须经这里取 glue，不要直接用导入的命名空间**。
 *
 * 直接 `new glueNamespace.PylonProjector(...)` 会把「计算核还没就绪」暴露成 wasm-bindgen
 * 内部的 `TypeError: Cannot read properties of undefined (reading '__wbindgen_export')`
 * ——真机验收（#220 §25.2）就是这么撞上的：一句话看不出是谁没等谁。走 `runtime.glue()`
 * 则抛本模块自己的可执行错误（与 streaming / markdown 两个装载层同一条约定）。
 */
function readyGlue(): ProjectorGlue {
  return runtime.glue()
}

/** wasm 计算核就绪。测试宿主由前置预初始化，因此同步已就绪。 */
export function whenProjectorComputeReady(): Promise<void> {
  return runtime.whenReady()
}

/**
 * 事件类型 → 帧内 typeIndex。词表以 wasm 出口为单源（跨语言契约的 Rust 方向，
 * 见 dev-standards「Rust/WASM 计算核」），TS 侧由 parity 测试与
 * `WORKBENCH_SEMANTIC_EVENT_TYPES` 钉死等价。
 *
 * **懒建**：这不是可选的优化——在导入期调用 wasm 出口，浏览器宿主会在 glue 尚未
 * 初始化时炸（`wasm` 未定义）。测试宿主之所以没暴露它，是因为预初始化把 wasm
 * 变成了导入期就已就绪。
 */
let typeIndexCache: Map<string, number> | undefined
function typeIndexes(): Map<string, number> {
  typeIndexCache ??= new Map(readyGlue().projectorEventTypes().map((name, index) => [name, index]))
  return typeIndexCache
}

const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool', 'reasoning', 'developer', 'unknown'] as const
const PROVENANCE_ORIGINS = ['local-observed', 'optimistic-local', 'recovery-import', 'migration', 'plugin'] as const
const TEXT_PART_KINDS = ['text', 'markdown', 'code', 'ansi', 'reasoning', 'thinking'] as const
/** v2 第 18 槽：provenance 可选富字段（origin/trust 走 flags 低 4 位）。 */
const PROVENANCE_EXTRA_KEYS = ['provider', 'importId', 'sourceOrdinal', 'orderConfidence', 'collectionComplete', 'synthetic'] as const
/** 每事件变长段的 (offset,len) 对数；与 Rust `FRAME_PAIRS` 钉死。 */
const FRAME_PAIRS = 18
const FRAME_VERSION = 2

// ── 边界穿越计数（可断言的读数，不是感觉；spec「mock 基准」） ────────────────

let boundaryCrossings = 0

/** JS↔wasm 过界次数累计（一次 appendBatch / 一次 document() 各计 1）。 */
export function readProjectorBoundaryCrossings(): number {
  return boundaryCrossings
}

export function resetProjectorBoundaryCrossings(): void {
  boundaryCrossings = 0
}

// ── 帧编码（紧凑列式：定长头 + 字串池；位定义见 Rust workbench.rs 头注） ─────

/**
 * 把一页 semantic envelope 编码为一帧 `PYPB` v2。编码完全在 JS 侧完成，
 * 不构成边界穿越；热路径（message/reasoning delta）走单文本部件通道零 JSON，
 * 冷事件富载荷整块 JSON 进池。
 */
export function encodeProjectorFrame(envelopes: readonly WorkbenchEventEnvelope[]): Uint8Array {
  const encoder = new TextEncoder()
  // 字串池用**分块 + 末尾一次拼接**，不要用 `number[]` 逐字节 push：
  // 一帧 5MB 就是 500 万次 JS 数组 push，外加一次 `Uint8Array.from(pool)` 的再遍历。
  // 20k 事件的编组分段实测里，这两步占了绝大部分（见 `bench-ts-vs-wasm.mts`）。
  const poolChunks: Uint8Array[] = []
  let poolLength = 0
  // 每事件的 18 个 (offset,len) 槽写进一块**预分配 Int32Array**，而不是每字段返回
  // 一个二元组数组：20k 事件 × 18 字段 = 36 万个短命数组（加上 `pairs` 本身是 20k 个
  // 18 元数组），在 V8 里就是上百万次小对象分配。槽表法把这项归零。
  const slotWords = new Int32Array(envelopes.length * FRAME_PAIRS * 2)
  let slotCursor = 0
  // 逐字段 `encoder.encode(value)` 每字段新建一个 Uint8Array，一页就是上万次分配——
  // 消融实测这一步占编码总耗时的 **2/3**（delta-m 6.56ms → 2.36ms）。改成
  // `encodeInto` 写进**复用 scratch** 再 `slice` 取走：只保留「拷进池」那一次 memcpy。
  // 扩容按 UTF-8 最坏 3 字节/UTF-16 单元估上界，够则直接原地重试（`read` 未走完即不够）。
  let scratch = new Uint8Array(256)
  /** 把字符串写进池，并把 (offset,len) 写进当前槽位。`len=0` 表示缺席。 */
  const putSlot = (value: string | undefined): void => {
    if (value === undefined || value.length === 0) {
      slotWords[slotCursor] = 0
      slotWords[slotCursor + 1] = 0
      slotCursor += 2
      return
    }
    if (scratch.length < value.length * 3) scratch = new Uint8Array(value.length * 3)
    let result = encoder.encodeInto(value, scratch)
    while (result.read !== value.length) {
      scratch = new Uint8Array(scratch.length * 2)
      result = encoder.encodeInto(value, scratch)
    }
    slotWords[slotCursor] = poolLength
    slotWords[slotCursor + 1] = result.written
    slotCursor += 2
    poolChunks.push(scratch.slice(0, result.written))
    poolLength += result.written
  }

  const encoded = envelopes.map(envelope => {
    const typeIndex = typeIndexes().get(envelope.event.type)
    if (typeIndex === undefined) throw new Error(`事件类型不在投影词表内：${envelope.event.type}`)

    const event = envelope.event as unknown as Record<string, unknown>
    const originIndex = PROVENANCE_ORIGINS.indexOf(envelope.provenance.origin)
    if (originIndex < 0) throw new Error(`provenance.origin 不在词表内：${String(envelope.provenance.origin)}`)
    let flags = originIndex
    flags |= (envelope.provenance.trust === 'unverified' ? 1 : 0) << 3
    if (envelope.coverage !== undefined) flags |= 1 << 5

    const roleIndex = typeof event.role === 'string' ? MESSAGE_ROLES.indexOf(event.role as typeof MESSAGE_ROLES[number]) : -1
    if (roleIndex >= 0) flags |= (1 << 6) | (roleIndex << 7)

    // parts 通道：单个无 language 的文本部件走热路径（零 JSON），其余整块 JSON。
    let partsText: string | undefined
    if (Array.isArray(event.parts)) {
      const parts = event.parts as { kind?: unknown; text?: unknown; language?: unknown }[]
      const single = parts.length === 1
        && typeof parts[0]?.text === 'string'
        && typeof parts[0]?.kind === 'string'
        && TEXT_PART_KINDS.includes(parts[0].kind as typeof TEXT_PART_KINDS[number])
        && parts[0].language === undefined
      const partsMode = single ? 1 : 2
      const partKind = single ? TEXT_PART_KINDS.indexOf(parts[0].kind as typeof TEXT_PART_KINDS[number]) : 0
      partsText = single ? (parts[0].text as string) : JSON.stringify(event.parts)
      flags |= (partsMode << 10) | (partKind << 12)
    }

    // 逐事件用 `Object.keys` + 下标循环、并用计数器判空，避免 `Object.entries`
    // （一对 N 个二元组数组）与第二次 `Object.keys(...)`（又一个数组）。语义与
    // `Object.entries` 一致：只枚举**自有可枚举**键。
    const extra: Record<string, unknown> = {}
    const eventKeys = Object.keys(event)
    let extraCount = 0
    for (let index = 0; index < eventKeys.length; index += 1) {
      const key = eventKeys[index]!
      if (key === 'type' || key === 'role' || key === 'parts' || key === 'reason') continue
      extra[key] = event[key]
      extraCount += 1
    }
    const extraJson = extraCount > 0 ? JSON.stringify(extra) : undefined
    const reason = typeof event.reason === 'string' ? (event.reason as string) : undefined
    const provenanceExtras: Record<string, unknown> = {}
    const provenance = envelope.provenance as unknown as Record<string, unknown>
    let provenanceCount = 0
    for (const key of PROVENANCE_EXTRA_KEYS) {
      if (key in provenance) {
        provenanceExtras[key] = provenance[key]
        provenanceCount += 1
      }
    }
    const provenanceJson = provenanceCount > 0 ? JSON.stringify(provenanceExtras) : undefined

    const identity = envelope.identity
    // 槽序必须与 Rust `decode_event` 的读取顺序逐位对齐（FRAME_PAIRS = 18）。
    putSlot(envelope.eventId)
    putSlot(envelope.sessionId)
    putSlot(envelope.recordedAt)
    putSlot(envelope.occurredAt)
    putSlot(identity.turnId)
    putSlot(identity.messageId)
    putSlot(identity.toolCallId)
    putSlot(identity.taskId)
    putSlot(identity.runId)
    putSlot(identity.interactionId)
    putSlot(envelope.source.provider)
    putSlot(envelope.source.sourceId)
    putSlot(envelope.source.agentId)
    putSlot(envelope.source.parentAgentId)
    putSlot(reason)
    putSlot(partsText)
    putSlot(extraJson)
    putSlot(provenanceJson)
    return { envelope, typeIndex, flags }
  })
  const eventSectionBytes = encoded.reduce(
    (total, item) => total + 24 + FRAME_PAIRS * 8 + (item.envelope.coverage !== undefined ? 16 : 0),
    0,
  )
  const frame = new Uint8Array(14 + poolLength + eventSectionBytes)
  const view = new DataView(frame.buffer)
  frame.set([0x50, 0x59, 0x50, 0x42]) // "PYPB"
  view.setUint16(4, FRAME_VERSION, true)
  view.setUint32(6, encoded.length, true)
  view.setUint32(10, poolLength, true)
  for (let index = 0, at = 14; index < poolChunks.length; index += 1) {
    const chunk = poolChunks[index]!
    frame.set(chunk, at)
    at += chunk.length
  }

  let cursor = 14 + poolLength
  let slots = 0
  for (const item of encoded) {
    view.setFloat64(cursor, item.envelope.sequence, true)
    view.setFloat64(cursor + 8, 0, true)
    view.setUint32(cursor + 16, item.typeIndex, true)
    view.setUint32(cursor + 20, item.flags, true)
    cursor += 24
    for (let pair = 0; pair < FRAME_PAIRS; pair += 1) {
      view.setUint32(cursor, slotWords[slots]!, true)
      view.setUint32(cursor + 4, slotWords[slots + 1]!, true)
      slots += 2
      cursor += 8
    }
    if (item.envelope.coverage !== undefined) {
      view.setFloat64(cursor, item.envelope.coverage[0], true)
      view.setFloat64(cursor + 8, item.envelope.coverage[1], true)
      cursor += 16
    }
  }
  return frame
}

// ── 物化（结构共享） ─────────────────────────────────────────────────────────


function rangesEqual(
  left: readonly (readonly [number, number])[],
  right: readonly (readonly [number, number])[],
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index]![0] !== right[index]![0] || left[index]![1] !== right[index]![1]) return false
  }
  return true
}

function freezeAppliedRanges(
  ranges: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  return Object.freeze(ranges.map(range => Object.freeze([range[0], range[1]]) as readonly [number, number]))
}

/** 投影核句柄的内部状态：wasm 实例 + 最近一次物化产物（结构共享的基准）。 */
export interface ProjectorState {
  readonly projector: PylonProjectorInstance
  lastDocument?: WorkbenchDocument
  lastSessionJson?: string
}

type UncoveredSlice = 'activities' | 'interactions' | 'extensions' | 'diagnostics'
  | 'systemErrors' | 'plan' | 'goal' | 'lifecycle' | 'assist'

/**
 * 事件族 → 本页可能触碰的 patch 外切片（归约器矩阵的保守上界）。
 * patch 已覆盖 messages/timeline/session/revision/applied*，这里只列它们之外的。
 * diagnostics/systemErrors 是 append-only（归约器只追加），物化时按长度判等。
 */
function uncoveredSlicesTouched(eventTypes: readonly string[]): Set<UncoveredSlice> {
  const touched = new Set<UncoveredSlice>()
  for (const type of eventTypes) {
    if (type.startsWith('tool.') || type.startsWith('activity.')) {
      touched.add('activities')
      touched.add('diagnostics')
      continue
    }
    if (type.startsWith('message.') || type.startsWith('reasoning.')) {
      touched.add('diagnostics')
      continue
    }
    if (type === 'usage.updated' || type === 'budget.warning') {
      touched.add('diagnostics')
      continue
    }
    if (type.startsWith('plan.')) {
      touched.add('plan')
      touched.add('diagnostics')
      continue
    }
    if (type.startsWith('goal.')) {
      touched.add('goal')
      touched.add('diagnostics')
      continue
    }
    if (type.startsWith('diagnostic.') || type === 'event.unknown') {
      touched.add('diagnostics')
      touched.add('systemErrors')
      continue
    }
    if (type.startsWith('interaction.')) touched.add('interactions')
    else if (type === 'extension.event') touched.add('extensions')
    else if (type.startsWith('lifecycle.')) touched.add('lifecycle')
    else if (type.startsWith('assist.')) touched.add('assist')
  }
  return touched
}


/** 投影核句柄的内部状态：wasm 实例 + 最近一次物化产物（结构共享的基准）。 */
export interface ProjectorState {
  readonly projector: PylonProjectorInstance
  lastDocument?: WorkbenchDocument
  lastSessionJson?: string
}

/**
 * **兜底物化**：上一份文档不是本投影核自己的产出（冷启动、外置文档、池重建）时走这里。
 *
 * 它必须付一次 `document()` 全量读；但它同时承担一条**渲染契约**：未触碰的切片要沿用
 * 上一份的**引用**，且全切片引用相等时恒等返回上一份对象——渲染门的浅比较依赖这一点
 * （`mountSolidWorkbench` 的「payload/appearance 全等时跳过 update」）。
 * 本核自己的产出走 `applyPatch`（只过界一次、不读全量），两条路径的收口语义一致。
 */
function materializePage(
  state: ProjectorState,
  base: WorkbenchDocument | undefined,
  fresh: WorkbenchDocument,
  patch: ProjectorPatch,
  eventTypes: readonly string[],
): WorkbenchDocument {
  // 引用共享以**调用方传入的 base** 为基准（而不是 state.lastDocument）：
  // 池命中时两者是同一对象；内容匹配复用时 base 是 runtime 的冻结副本——
  // 它的切片引用才是显示链 memo 正在持有的。
  const previous = base
  if (!previous) {
    state.lastSessionJson = JSON.stringify(fresh.session)
    return {
      ...fresh,
      appliedEventIds: Object.freeze([...fresh.appliedEventIds]),
      appliedRanges: freezeAppliedRanges(fresh.appliedRanges),
    }
  }
  const sessionJson = JSON.stringify(patch.session)
  const touched = uncoveredSlicesTouched(eventTypes)
  // 归约器只追加，不删改：长度相等 ⇒ 内容相等 ⇒ 沿用引用。
  const sameLength = (slice: readonly unknown[], previousSlice: readonly unknown[]): boolean =>
    slice.length === previousSlice.length
  const next: WorkbenchDocument = {
    ...fresh,
    revision: patch.revision,
    appliedEventIds: patch.appliedEventIdsAppended.length === 0
      ? previous.appliedEventIds
      : Object.freeze([...fresh.appliedEventIds]),
    appliedRanges: rangesEqual(patch.appliedRanges, previous.appliedRanges)
      ? previous.appliedRanges
      : freezeAppliedRanges(fresh.appliedRanges),
    timeline: patch.timelineUpserts.length === 0 ? previous.timeline : fresh.timeline,
    messages: patch.messageUpserts.length === 0 ? previous.messages : fresh.messages,
    activities: !touched.has('activities') ? previous.activities : fresh.activities,
    interactions: !touched.has('interactions') ? previous.interactions : fresh.interactions,
    extensions: !touched.has('extensions') ? previous.extensions : fresh.extensions,
    session: state.lastSessionJson === sessionJson ? previous.session : fresh.session,
    assist: !touched.has('assist') ? previous.assist : fresh.assist,
    diagnostics: !touched.has('diagnostics') || sameLength(fresh.diagnostics, previous.diagnostics)
      ? previous.diagnostics
      : fresh.diagnostics,
    plan: !touched.has('plan') ? previous.plan : fresh.plan,
    goal: !touched.has('goal') ? previous.goal : fresh.goal,
    lifecycle: !touched.has('lifecycle') ? previous.lifecycle : fresh.lifecycle,
    systemErrors: !touched.has('systemErrors') || sameLength(fresh.systemErrors, previous.systemErrors)
      ? previous.systemErrors
      : fresh.systemErrors,
  }
  state.lastSessionJson = sessionJson
  // 幂等折叠（重复事件/已覆盖区间）：全部切片引用相等 ⇒ 恒等返回上一份文档。
  for (const key of Object.keys(fresh) as (keyof WorkbenchDocument)[]) {
    if (next[key] !== previous[key]) return next
  }
  return previous
}

// ── 折叠出口 ─────────────────────────────────────────────────────────────────

/**
 * 创建投影核句柄。返回值在**边界处**计数：每一次 `appendBatch` / `document`
 * 都记一次过界，与调用方走哪条路径无关。
 *
 * 计数放在这一层而不是放在 `foldIntoProjector` 里，是因为「过界次数」是**边界**的
 * 属性，不是某条便捷路径的属性——基准脚本直接驱动 `appendBatch` 时也必须量得到，
 * 否则读数会退化成「只要绕开那个 helper 就永远 0」。
 */
export function createProjector(sessionId: string): PylonProjectorInstance {
  // 经 `readyGlue()` 而不是直接用导入的命名空间：未就绪时抛本模块的可执行错误，
  // 而不是 wasm-bindgen 的 `__wbindgen_export` TypeError（见 `readyGlue` 头注）。
  const inner = new (readyGlue().PylonProjector)(sessionId)
  return {
    appendBatch(frame: Uint8Array): string {
      boundaryCrossings += 1
      return inner.appendBatch(frame)
    },
    document(): string {
      boundaryCrossings += 1
      return inner.document()
    },
    foldPhases(): string {
      return inner.foldPhases()
    },
  }
}

/**
 * 页级折叠：一页事件一帧过界，物化走 `document()` 全量读 + 结构共享。
 * 固定 2 次边界穿越，与页内事件数无关（按页合批的落点）。
 */
export function foldIntoProjector(
  state: ProjectorState,
  envelopes: readonly WorkbenchEventEnvelope[],
  base?: WorkbenchDocument,
): ProjectorFoldPage {
  const patch = JSON.parse(state.projector.appendBatch(encodeProjectorFrame(envelopes))) as ProjectorPatch
  const previous = base ?? state.lastDocument
  // **热路径只过界一次**：patch 已带齐增量（timeline/messages 下标 upsert + 脏切片整面），
  // 因此不必再 `document()` 全量读。
  //
  // 但只有「上一份文档**就是本投影核自己的产出**」时才能把 patch 应用到它上面：patch 的
  // 下标 upsert 与脏切片都是相对**核内状态**的。`resolveEntry` 对外置文档（宿主手工构造后
  // 写入、池里认不出）会起一个**空核**并把该文档当 `base` 传进来——那种情况必须全量读，
  // 否则会把外置内容与核内增量混成一份既不是 A 也不是 B 的文档。
  const appliesToOwnOutput = previous !== undefined && state.lastDocument === previous
  const document = appliesToOwnOutput
    ? applyPatch(state, previous, patch)
    : materializePage(
        state,
        previous,
        JSON.parse(state.projector.document()) as WorkbenchDocument,
        patch,
        envelopes.map(envelope => envelope.event.type),
      )
  state.lastDocument = document
  return { patch, document }
}

/**
 * 会话持有的投影核句柄：折叠状态常驻 wasm，`fold` 把一页信封折进同一份状态。
 * `agentWorkbenchSession` 是唯一生产消费者（live 逐帧到达天然逐页一事件，
 * 冷装载按 journal 页合批）；reject 回滚由调用方重建句柄（见其折叠日志）。
 */
export interface SessionProjector {
  fold(envelopes: readonly WorkbenchEventEnvelope[]): WorkbenchDocument
}

export function createSessionProjector(sessionId: string): SessionProjector {
  const state: ProjectorState = { projector: createProjector(sessionId) }
  return {
    fold(envelopes) {
      return foldIntoProjector(state, envelopes).document
    },
  }
}

// ── 池化纯函数折叠（document-in/out 兼容层） ─────────────────────────────────
//
// `projectWorkbench` / `reduceWorkbenchEvent` 的对外契约是**纯函数**（文档入、
// 文档出、可任意交错重入），而 wasm 投影核是会前进的临时状态、没有「从文档
// 种子」的出口。解析顺序：
// 1. WeakMap 直命中且该条目状态仍停在传入文档（`state.lastDocument === base`）
//    → 就地推进（链式折叠的快路径）；
// 2. 命中但血统已前进（同一底文档之后其它折叠推进了共享投影核）→ 按条目的
//    **日志快照**重建一份停在该文档状态的投影核，再折入新事件——纯函数语义
//    （同输入同输出、交错重入不串味）由此恢复；
// 3. **内容匹配**：runtime 会把产物深冻结成副本（freezeDocument），内容与某份
//    产物当前状态恒等（wasm 的 document 就是全部折叠状态）→ 复用该条目；
// 4. 其余（createWorkbenchDocument 空文档、真正外置的文档）按空种子新建投影核。
// 测试、渲染器预览与 smoke 挂载都走这条路径；生产链路的折叠状态由会话投影核
// 独占持有，不经过这里。

interface PoolEntry {
  state: ProjectorState
  /** 产出该文档时的折叠日志快照（血统前进后重建同状态投影核用）。 */
  log: WorkbenchEventEnvelope[]
  sessionId: string
}

const poolByDocument = new WeakMap<object, PoolEntry>()
/** 内容匹配的近期产物登记（弱引用持有，防泄漏；容量截断保扫描有界）。 */
const recentEntries: { document: WeakRef<WorkbenchDocument>; entry: PoolEntry }[] = []
const RECENT_ENTRIES_LIMIT = 32

function recentEntriesMatch(document: WorkbenchDocument): PoolEntry | undefined {
  let matched: PoolEntry | undefined
  const target = JSON.stringify(document)
  for (let index = recentEntries.length - 1; index >= 0; index--) {
    const record = recentEntries[index]!
    const held = record.document.deref()
    if (held === undefined) {
      recentEntries.splice(index, 1)
      continue
    }
    if (matched === undefined && held !== document && JSON.stringify(held) === target) {
      matched = record.entry
    }
  }
  return matched
}

function recentEntriesRegister(document: WorkbenchDocument, entry: PoolEntry): void {
  recentEntries.push({ document: new WeakRef(document), entry })
  if (recentEntries.length > RECENT_ENTRIES_LIMIT) recentEntries.shift()
}

function freshPoolEntry(sessionId: string): PoolEntry {
  return { state: { projector: createProjector(sessionId) }, log: [], sessionId }
}

function rebuildAt(pooled: PoolEntry): PoolEntry {
  const state: ProjectorState = { projector: createProjector(pooled.sessionId) }
  if (pooled.log.length > 0) foldIntoProjector(state, pooled.log)
  return { state, log: [...pooled.log], sessionId: pooled.sessionId }
}

function resolveEntry(
  initialDocument: WorkbenchDocument | undefined,
  fallbackSessionId: string,
): { entry: PoolEntry; base: WorkbenchDocument | undefined } {
  if (initialDocument === undefined) return { entry: freshPoolEntry(fallbackSessionId), base: undefined }
  const pooled = poolByDocument.get(initialDocument)
  if (pooled) {
    if (pooled.state.lastDocument === initialDocument) return { entry: pooled, base: initialDocument }
    return { entry: rebuildAt(pooled), base: initialDocument }
  }
  const matched = recentEntriesMatch(initialDocument)
  if (matched) {
    if (matched.state.lastDocument === initialDocument) return { entry: matched, base: initialDocument }
    return { entry: rebuildAt(matched), base: initialDocument }
  }
  return { entry: freshPoolEntry(initialDocument.sessionId || fallbackSessionId), base: initialDocument }
}

export interface WorkbenchFoldOptions {
  readonly initialDocument?: WorkbenchDocument
}

export interface WorkbenchFoldResult {
  readonly document: WorkbenchDocument
  readonly diagnostics: readonly WorkbenchProjectionDiagnostic[]
}

/** `projectWorkbench` 的 wasm 实现：一页一帧，产物登记进池。 */
export function projectWorkbenchFold(
  events: readonly WorkbenchEventEnvelope[],
  options: WorkbenchFoldOptions = {},
): WorkbenchFoldResult {
  const { entry, base } = resolveEntry(options.initialDocument, events[0]?.sessionId ?? '')
  const page = foldIntoProjector(entry.state, events, base)
  // 新条目持有「旧快照 + 本页事件」的新数组；**不**改动旧条目的日志——旧文档
  // 的重建快照必须停留在它被产出的时刻（血统前进后仍可精确重建）。
  const registered: PoolEntry = { state: entry.state, log: [...entry.log, ...events], sessionId: entry.sessionId }
  poolByDocument.set(page.document, registered)
  recentEntriesRegister(page.document, registered)
  return { document: page.document, diagnostics: page.document.diagnostics }
}

/** `reduceWorkbenchEvent` 的 wasm 实现：单事件页。 */
export function reduceWorkbenchFold(
  document: WorkbenchDocument,
  envelope: WorkbenchEventEnvelope,
): WorkbenchDocument {
  return projectWorkbenchFold([envelope], { initialDocument: document }).document
}
