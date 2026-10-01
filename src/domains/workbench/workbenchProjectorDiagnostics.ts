/**
 * A04 projector · 诊断预算（#446）与 timeline 载荷收窄（#375-a）（#486 项2 四分之
 * 诊断预算+载荷收窄；行为不变）。
 *
 * 本件同时承载 `addDiagnostic` 与 `updateTimeline`：诊断落账要给 timeline 条目打
 * status/summary 补丁，而 reducer 反向依赖 addDiagnostic——收在本件可保持
 * types ← diagnostics ← reducer 的单向依赖，无环。
 */
import { TERMINAL_SESSION_STATUSES, freezeDeepSnapshot } from './workbenchProjectorTypes.ts'
import type { WorkbenchEventEnvelope } from './events/workbenchEventSchema.ts'
import type {
  WorkbenchDocument,
  WorkbenchProjectionDiagnostic,
  WorkbenchTimelineEntry,
  WorkbenchTimelineKind,
} from './workbenchProjectorTypes.ts'

// #446：diagnostics 无上限收敛（调查：addDiagnostic 无 cap、仅三码去重；event.unknown
// 整包进 data 且单条 raw ≤64KiB，病态流 ≈6MB/分钟且会话周期常驻）。
// - 条目环：非 error 条目超 256 丢最旧（error 级豁免——它们是 error center 的事实源，量小）；
// - 计数环：同 code 非 error 不再逐条追加，count+1 记在首条上（late-event/out-of-order 先例形态）；
// - data 字节预算：非 error 条目的 data 总量超 256KB 时从最旧起摘 data（置 dataOmitted——
//   卡片与 message 保留，载荷让位）。⚠️ event.unknown 的 data 也在预算内：#405 裁决
//   「原始载荷留在事件详情」指的是正常路径不投喂前摘除，这里是资源压力下的显式降级
//   （有标记、可裁），与该裁决的冲突面已在 issue #446 记录，如需豁免改一处表即可。
const DIAGNOSTICS_ENTRY_LIMIT = 256
const DIAGNOSTICS_DATA_BUDGET_CHARS = 262_144

/** data 的字节估算（JSON 字符数；与 retainedHeap 的估算口径同级——只用于预算判，不当绝对值）。 */
function diagnosticDataChars(data: unknown): number {
  if (data === undefined) return 0
  try {
    const encoded = JSON.stringify(data)
    return encoded === undefined ? 0 : encoded.length
  } catch {
    return 0
  }
}

// 非 error data 总字符量按 diagnostics 数组引用 memo（同 orphanActivityIdsMemo 的先例）：
// 无诊断事件时引用稳定 ⇒ O(1)；每次诊断事件重算一次 O(N)（N 被条目环钉在 ≤256）。
const diagnosticsDataCharsMemo = new WeakMap<readonly WorkbenchProjectionDiagnostic[], number>()

function diagnosticsDataChars(diagnostics: readonly WorkbenchProjectionDiagnostic[]): number {
  const cached = diagnosticsDataCharsMemo.get(diagnostics)
  if (cached !== undefined) return cached
  let total = 0
  for (const entry of diagnostics) {
    if (entry.level !== 'error' && entry.data !== undefined) total += diagnosticDataChars(entry.data)
  }
  diagnosticsDataCharsMemo.set(diagnostics, total)
  return total
}

export function addDiagnostic(document: WorkbenchDocument, envelope: WorkbenchEventEnvelope, code: string, message: string, level: 'info' | 'warning' | 'error', data?: unknown): WorkbenchDocument {
  const failedTurn = code === 'turn.failed' || code === 'provider.error'
  const alreadyTerminal = TERMINAL_SESSION_STATUSES.has(document.session.status.toLowerCase())
  const transitionToError = failedTurn && !alreadyTerminal
  const isError = level === 'error'
  const previous = document.diagnostics
  // 计数环（非 error）：同 code、同 message 且同 level 的既有条目就地 count+1 并刷新到
  // 最新事件。键带 message：event.unknown 的卡片标题取变体名（#405），不同 originalType
  // 的变体必须各自成卡，只折叠「同一形状的重复」；键带 level：info→warning 的升级证据
  // 不能被首条的 level 吞掉（审查轮 P2）。error 级恒追加。
  let appended = false
  let nextDiagnostics: WorkbenchProjectionDiagnostic[]
  if (isError) {
    nextDiagnostics = [...previous, { code, message, eventId: envelope.eventId, sequence: envelope.sequence, level, data }]
    appended = true
  } else {
    let merged = false
    nextDiagnostics = previous.map(entry => {
      if (merged || entry.level === 'error' || entry.code !== code || entry.message !== message || entry.level !== level) return entry
      merged = true
      // 恢复 data 时必须剥掉 dataOmitted——「标记 ⇒ 已摘除」是本形状的契约
      // （审查轮 P1：合并携带旧标记会造出 data 与 dataOmitted 并存的违约态）。
      if (data !== undefined && entry.dataOmitted !== undefined) {
        const { dataOmitted: _dropped, ...restored } = entry
        return { ...restored, count: (entry.count ?? 1) + 1, eventId: envelope.eventId, sequence: envelope.sequence, data }
      }
      return {
        ...entry,
        count: (entry.count ?? 1) + 1,
        eventId: envelope.eventId,
        sequence: envelope.sequence,
        ...(data !== undefined ? { data } : {}),
      }
    })
    if (!merged) {
      nextDiagnostics = [...previous, { code, message, eventId: envelope.eventId, sequence: envelope.sequence, level, data }]
      appended = true
    }
  }
  // 条目环：非 error 超 256 丢**最旧**（error 恒保留），单趟 filter 保持到达序——
  // 不做「error 前置重排」，那会打乱 error center 事实源的展示顺序（审查轮 P2）。
  let ringed = nextDiagnostics
  if (!isError && nextDiagnostics.length > DIAGNOSTICS_ENTRY_LIMIT) {
    const nonError = nextDiagnostics.filter(entry => entry.level !== 'error')
    const excess = nonError.length - DIAGNOSTICS_ENTRY_LIMIT
    if (excess > 0) {
      const dropped = new Set(nonError.slice(0, excess))
      ringed = nextDiagnostics.filter(entry => !dropped.has(entry))
    }
  }
  // data 字节预算：超预算从最旧的非 error 条目起摘 data（error 豁免）。合并/新增那条的
  // data 是本事件引入的增量（data === undefined 时旧 data 原样保留、零增量），用它校正
  // memo 总量；环淘汰后**重算全表**——否则被淘汰条目的幻影字符永久占账，极端时把有效
  // 预算压到零（审查轮 P2）。环触发是超限 pathological 区的低频路径，O(N) 重算可接受。
  let budgeted = ringed
  const previousTotal = diagnosticsDataChars(previous)
  const removedChars = appended || data === undefined ? 0 : (() => {
    const old = previous.find(entry => entry.level !== 'error' && entry.code === code && entry.message === message && entry.level === level)
    return old !== undefined ? diagnosticDataChars(old.data) : 0
  })()
  let total = ringed !== nextDiagnostics ? diagnosticsDataChars(ringed) : previousTotal - removedChars + diagnosticDataChars(data)
  if (total > DIAGNOSTICS_DATA_BUDGET_CHARS) {
    budgeted = ringed.map(entry => {
      if (total <= DIAGNOSTICS_DATA_BUDGET_CHARS || entry.level === 'error' || entry.data === undefined) return entry
      total -= diagnosticDataChars(entry.data)
      return entry.dataOmitted === undefined ? { ...entry, data: undefined, dataOmitted: true } : entry
    })
    diagnosticsDataCharsMemo.delete(previous)
  }
  diagnosticsDataCharsMemo.set(budgeted, total)
  return {
    ...document,
    ...(transitionToError ? {
      messages: document.messages.map(item => item.running ? freezeDeepSnapshot({ ...item, running: false }) : item),
      session: { ...document.session, status: 'error' },
    } : {}),
    diagnostics: budgeted,
    timeline: updateTimeline(document.timeline, envelope.eventId, { status: level, summary: message }),
  }
}

/**
 * #375-a：`timeline.data` 收窄的事件族。实测载荷全部集中在 tool / activity 两族
 * （`tool.parts` / `rawOutput` / `rawInput` / `input` / `locations` …），而生产代码里
 * `timeline[].data` 的读者**只读 session 族**（终态判定与协商守卫读 `type`/`status`/`options`）。
 * 载荷的消费者是 `toolInvocationSnapshot`（读 `activities[]`），与 timeline 无关。
 *
 * 收窄方式按**形状**而不是键名白名单：标量（string/number/bool/null）逐字节保留，复合值
 * （数组/对象）即载荷载体、不进 `data`；被省略的键名记在 `payloadKeys` 里，便于插件迁移
 * 定位。需要整份事件的现场可用 `data-timeline-payload="full"` 逃生口（见 readPathSwitches）。
 */
const NARROWED_TIMELINE_KINDS: readonly WorkbenchTimelineKind[] = ['tool', 'activity']

/** #375-a 的宿主默认开关：默认收窄；宿主（agentWorkbenchSession）按 DOM 逃生口置位。
 * 投影核的确定性以「显式 options 优先」保证——同一入参 + 同一 options ⇒ 同一输出；
 * 未传 options 时沿用宿主默认（结构审查 B-8：全局可变状态改为默认值语义）。 */
let hostNarrowTimelinePayloadDefault = true

export function setTimelinePayloadNarrowing(enabled: boolean): void {
  hostNarrowTimelinePayloadDefault = enabled
}

/** 投影 options：narrowTimelinePayload 显式传入时覆盖宿主默认（测试/工具不再依赖进程级状态）。 */
export interface WorkbenchReduceOptions {
  readonly narrowTimelinePayload?: boolean
}

export function narrowingEnabled(explicit?: boolean): boolean {
  return explicit ?? hostNarrowTimelinePayloadDefault
}

/**
 * 收窄规则（#375-a）：标量**字符串**只有短于该上限才留下，再往深（第三层）或数组一律视为
 * 载荷载体。取 512 而不是按键名白名单，是因为「载荷藏在哪」不稳定——`rawOutput` 是对象、
 * 但真正的大字符串在 `rawOutput.text`；`input` 有时只有 `{command}`、有时是整个文件正文。
 * 按长度判定对两种形状都成立：name/title/status/kind/toolCallId 这类身份标量全都远短于此。
 */
const NARROWED_SCALAR_STRING_LIMIT = 512

function narrowTimelineData(event: unknown): unknown {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event
  const omitted: string[] = []
  const narrowed: Record<string, unknown> = {}
  const keepScalar = (
    target: Record<string, unknown>,
    key: string,
    value: unknown,
    path: string,
  ): boolean => {
    if (typeof value === 'string') {
      if (value.length <= NARROWED_SCALAR_STRING_LIMIT) {
        target[key] = value
        return true
      }
      omitted.push(path)
      return true
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      target[key] = value
      return true
    }
    return false
  }
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (keepScalar(narrowed, key, value, key)) continue
    if (Array.isArray(value)) {
      omitted.push(key)
      continue
    }
    const nested: Record<string, unknown> = {}
    // `Object.entries(undefined)` 会抛——非 JSON 载荷（规范化器理论上不发，但这里是投影
    // 热路径的守卫成本极低）显式挡住；此时该键按载荷省略。
    if (value === null) {
      omitted.push(key)
      continue
    }
    for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
      // 只再进一层：`tool` 的身份标量在这一层，再深的复合值一律算载荷。
      if (!keepScalar(nested, innerKey, innerValue, `${key}.${innerKey}`)) {
        omitted.push(`${key}.${innerKey}`)
      }
    }
    narrowed[key] = Object.freeze(nested)
  }
  if (omitted.length > 0) narrowed.payloadKeys = Object.freeze(omitted)
  return freezeDeepSnapshot(narrowed)
}

export function timelineEntry(envelope: WorkbenchEventEnvelope, narrowTimelinePayload: boolean): WorkbenchTimelineEntry {
  const event = envelope.event
  const kind: WorkbenchTimelineKind = event.type.startsWith('message.') ? 'message'
    : event.type.startsWith('reasoning.') ? 'reasoning'
      : event.type.startsWith('tool.') ? 'tool'
        : event.type.startsWith('activity.') ? 'activity'
          : event.type.startsWith('interaction.') ? 'interaction'
            : event.type.startsWith('session.') ? 'session'
              : event.type.startsWith('usage.') || event.type === 'budget.warning' ? 'usage'
                : event.type.startsWith('diagnostic.') || event.type === 'event.unknown' ? (event.type === 'event.unknown' ? 'unknown' : 'diagnostic')
                  : event.type === 'extension.event' ? 'extension'
                  // C08/C13：plan/goal 同属 plan family；lifecycle 独立 kind（不再误判 assist）
                  : event.type.startsWith('plan.') || event.type.startsWith('goal.') ? 'plan'
                    : event.type.startsWith('lifecycle.') ? 'lifecycle' : 'assist'
  const data = narrowTimelinePayload && NARROWED_TIMELINE_KINDS.includes(kind) ? narrowTimelineData(event) : event
  return { id: envelope.eventId, sequence: envelope.sequence, eventId: envelope.eventId, kind, data }
}

/**
 * 给 `eventId` 对应的 timeline 条目打补丁。
 *
 * `draft`（#234，仅批量路径）时**原地**替换尾条：批量路径下补丁目标恒是「本轮刚 push 的
 * 那一条」——它的 eventId 就是本轮 envelope 的 eventId，对象本轮新建、不与任何已发布文档
 * 共享，且它就是数组尾。因此原地替换只动我们独占的数组，省掉每事件 O(T) 的 map + 分配；
 * 补丁目标不是尾条时（乱序插入兜底等）退回复制语义。live 路径不传 `draft`，一字不变。
 */
export function updateTimeline(
  items: readonly WorkbenchTimelineEntry[],
  eventId: string,
  patch: Partial<WorkbenchTimelineEntry>,
  draft = false,
): WorkbenchTimelineEntry[] {
  if (draft) {
    const tailIndex = items.length - 1
    const tail = items[tailIndex]
    if (tail !== undefined && tail.eventId === eventId) {
      const mutable = items as WorkbenchTimelineEntry[]
      mutable[tailIndex] = { ...tail, ...patch }
      return mutable
    }
  }
  return items.map(item => item.eventId === eventId ? { ...item, ...patch } : item)
}
