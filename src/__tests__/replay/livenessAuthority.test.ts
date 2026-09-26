/**
 * #213 活性权威：`generating` 由**本进程的回合时钟**决定，不由文档形状推断。
 *
 * 症状：进程重启、或回合被空闲上限截断后，打开该会话永久显示「正在生成 / 仍在等待后端响应」
 * ——journal 里那一行没有终态行，投影出来的 `running` 为真，文档派生的
 * `generating = firstRunning !== undefined` 就把它复活了（页脚 spinner、思考中…）。
 *
 * 权威来源是会话层的 TurnClock（按 source 隔离的本进程回合时钟）：
 *  · 有活动时钟 ⇒ `generating: true`（随文档一并传递，见 livenessGenerating）；
 *  · 时钟封存 / 无时钟 ⇒ `generating: false`，文档派生的活性不得复活它；
 *  · 无时钟宿主（preview / legacy host / 浏览器 mock）不申报 `livenessSource`，
 *    行为退回文档派生——这条是兼容路径，必须保持。
 */
import { describe, expect, it } from 'vitest'
import { createWorkbenchDocument, projectWorkbench } from '../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'
import { createWorkbenchEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import { createAgentWorkbenchSessionRuntime } from '../../sheets/agent-workbench/agentWorkbenchSession.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'
import { getCanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'
import type { Session } from '../../domains/identity/identityStore.ts'
import type { WorkbenchRuntimeSnapshot } from '../../domains/workbench/workbenchRuntime.ts'

function session(id: string, source: string): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function canonicalRow(sequence: number, sessionUpdate: string, fields: Record<string, unknown> = {}) {
  const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:live' }
  return {
    schemaVersion: 1,
    eventId: `${toCanonicalOwnerKey(owner)}#${sequence}`,
    owner,
    provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'peri' },
    clientGeneration: 1,
    sequence,
    occurredAt: new Date(Date.UTC(2026, 8, 20, 0, 0, sequence)).toISOString(),
    receivedAt: new Date(Date.UTC(2026, 8, 20, 0, 0, sequence)).toISOString(),
    eventType: sessionUpdate === 'user_message_chunk' ? 'user.message'
      : sessionUpdate === 'done' ? 'turn.completed' : 'unknown',
    payloadVersion: 1,
    rawPayload: { update: { sessionUpdate, ...fields } },
  }
}

/** 直接构造信封：兼容路径用例不走会话层的行归一，直接喂投影。 */
function envelope(sequence: number, event: Record<string, unknown>) {
  return createWorkbenchEnvelope({
    sessionId: 'local:live',
    sequence,
    recordedAt: new Date(Date.UTC(2026, 8, 20, 0, 0, sequence)).toISOString(),
    source: { provider: 'peri', sourceId: `local:live#${sequence}` },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: event as never,
  })
}

const UNTERMINATED_ENVELOPES = [
  envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: '上一轮请求' }] }),
  envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '写到一半就断了' }] }),
]

const UNTERMINATED = [
  canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '上一轮请求' } }),
  canonicalRow(2, 'agent_message_chunk', { content: { type: 'text', text: '写到一半就断了' } }),
]
const TERMINATED = [
  canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '上一轮请求' } }),
  canonicalRow(2, 'agent_message_chunk', { content: { type: 'text', text: '答完了' } }),
  canonicalRow(3, 'done'),
]

/** 无时钟宿主（preview / legacy）：不申报 livenessSource，行为必须是文档派生。 */
function bareRuntime(): ReturnType<typeof createWorkbenchRuntime> {
  const initial: Omit<WorkbenchRuntimeSnapshot, 'revision'> = {
    sessionId: 'local:live', status: 'ready', messages: [],
    generating: false, generationStart: 0, tokenCount: 0, summary: null, tasks: [],
    availableModels: [], activeModel: '', availableModes: [], activeMode: '',
    canAttach: false, promptImage: false, error: null,
    document: createWorkbenchDocument('local:live'),
  }
  return createWorkbenchRuntime(initial)
}

function journalRuntime(rows: readonly unknown[]) {
  let pushEvent: ((row: unknown) => void) | undefined
  const service = createAgentWorkbenchSessionRuntime({
    loadAll: async () => rows,
    subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
    listenTerminalFallback: () => () => {},
  })
  return { service, push: (row: unknown) => pushEvent?.(row) }
}

describe('#213 活性权威 · 重放的无终态回合不再复活生成态', () => {
  it('journal 尾行没有终态：行仍是 running，但会话层无活动时钟 ⇒ generating=false', async () => {
    const { service } = journalRuntime(UNTERMINATED)
    await service.bind(session('session-live', 'local:live'))
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.document!.messages.at(-1)!.running).toBe(true)
    expect(snapshot.livenessSource).toBe('clock')
    expect(snapshot.generating).toBe(false)
    expect(snapshot.generationPhase).toBeUndefined()
    service.destroy()
  })

  it('对照：带终态行的回合同样 false（既有行为不回退）', async () => {
    const { service } = journalRuntime(TERMINATED)
    await service.bind(session('session-live', 'local:live'))
    expect(service.runtime.getSnapshot().document!.messages.at(-1)!.running).toBe(false)
    expect(service.runtime.getSnapshot().generating).toBe(false)
    service.destroy()
  })

  it('兼容路径：不申报 livenessSource 的宿主仍按文档形状推断', () => {
    const document = projectWorkbench(UNTERMINATED_ENVELOPES, { initialDocument: createWorkbenchDocument('local:live') }).document
    const runtime = bareRuntime()
    runtime.replaceDocument(document, { ownerKey: 'owner-live', generation: 1 })
    const snapshot = runtime.getSnapshot()
    expect(snapshot.livenessSource).toBeUndefined()
    expect(snapshot.generating).toBe(true)
    runtime.destroy()
  })
})

describe('#213 活性权威 · 实时帧建立权威', () => {
  it('他端先开回合：无时钟 + 实时正文帧 ⇒ 采纳时钟，起点取文档首个 running 行的时间', async () => {
    const { service, push } = journalRuntime(UNTERMINATED)
    await service.bind(session('session-live', 'local:live'))
    expect(service.runtime.getSnapshot().generating).toBe(false)

    // 他端的后续正文帧（本进程此前没有任何时钟）
    push(canonicalRow(3, 'agent_message_chunk', { content: { type: 'text', text: '又写了一段' } }))

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(true)
    expect(snapshot.summary).toBeNull()
    // 起点是那个 running 行的时间（第 2 条，UTC 00:00:02），不是"我们看见它"的时刻
    expect(snapshot.generationStart).toBe(Date.UTC(2026, 8, 20, 0, 0, 2))
    service.destroy()
  })

  it('自己的回合：user echo 起时钟，随后的正文帧保持生成态（不回落）', async () => {
    const { service, push } = journalRuntime([])
    await service.bind(session('session-live', 'local:live'))
    push(canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '新一轮' } }))
    expect(service.runtime.getSnapshot().generating).toBe(true)
    push(canonicalRow(2, 'agent_message_chunk', { content: { type: 'text', text: '在写' } }))
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(true)
    expect(snapshot.generationStart).toBeGreaterThan(0)
    expect(snapshot.summary).toBeNull()
    service.destroy()
  })

  it('终帧封存时钟 ⇒ 明确回落为静止（不靠文档派生顺手收敛）', async () => {
    const { service, push } = journalRuntime([])
    const active = session('session-live', 'local:live')
    await service.bind(active)
    push(canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '新一轮' } }))
    expect(service.runtime.getSnapshot().generating).toBe(true)

    await getCanonicalEventFeed().acceptFrame({ event: 'pylon:done', payload: { source: active.source } })
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({ reason: 'done' })
    service.destroy()
  })
})

/**
 * #217/ADR-0017 活性权威上移内核：`livenessSource: 'kernel'` 接入与优先级
 * （kernel > clock > document）。
 *
 * 内核事实 = `load_persisted_session` 冷挂载快照的 `turnInFlight`（经 refresh 传入）。
 * 语义严格为「本进程已派发 prompt、尚未收到终态」：
 *  · kernel=false：重放的 running 尾行与实时帧都不再能复活生成态（两条采纳启发式停用）；
 *  · kernel=true：无本地时钟（他端/他窗派发）也能正确显示生成态；
 *  · 无内核表态：回退 'clock' 权威，#213 行为不回退；
 *  · 新鲜度守卫：本地时钟活动期间，load 竞态带来的 kernel=false 不得压熄在途回合。
 */
describe('#217 活性权威上移内核 · kernel > clock > document', () => {
  it('重启后未终结会话：kernel=false 压住重放的 running 尾行，权威切换为 kernel', async () => {
    const { service } = journalRuntime(UNTERMINATED)
    await service.bind(session('session-live', 'local:live'))
    // bind 阶段尚无内核表态：仍是 clock 权威（#213 现状）。
    expect(service.runtime.getSnapshot().livenessSource).toBe('clock')

    // load 链带回冷挂载快照：本进程重启后未派发任何 prompt ⇒ 内核标记为 false。
    await service.refresh(session('session-live', 'local:live'), { turnInFlight: false })
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.livenessSource).toBe('kernel')
    expect(snapshot.generating).toBe(false)
    // 行级投影语义不变：running 尾行仍是"未见终态"。
    expect(snapshot.document!.messages.at(-1)!.running).toBe(true)
    service.destroy()
  })

  it('kernel=false 时实时帧不再被采纳：他端先开回合不复活生成态（启发式停用）', async () => {
    const { service, push } = journalRuntime(UNTERMINATED)
    await service.bind(session('session-live', 'local:live'))
    await service.refresh(session('session-live', 'local:live'), { turnInFlight: false })
    expect(service.runtime.getSnapshot().generating).toBe(false)

    // 他端的 user echo + 后续正文帧：#213 时钟权威下会采纳成 generating=true
    //（见下方对照用例），内核表态可用后一律停用。
    push(canonicalRow(3, 'user_message_chunk', { content: { type: 'text', text: '他端新回合' } }))
    push(canonicalRow(4, 'agent_message_chunk', { content: { type: 'text', text: '他端在写' } }))

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.livenessSource).toBe('kernel')
    expect(snapshot.generating).toBe(false)
    expect(snapshot.generationPhase).toBeUndefined()
    service.destroy()
  })

  it('kernel=true：无本地时钟的在途回合（他端/他窗派发）正确显示生成态', async () => {
    const { service } = journalRuntime(UNTERMINATED)
    await service.bind(session('session-live', 'local:live'))
    await service.refresh(session('session-live', 'local:live'), { turnInFlight: true })
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.livenessSource).toBe('kernel')
    expect(snapshot.generating).toBe(true)
    service.destroy()
  })

  it('无内核表态（旧内核）：refresh 不带 turnInFlight ⇒ 回退 clock 权威，#213 行为不回退', async () => {
    const { service, push } = journalRuntime(UNTERMINATED)
    await service.bind(session('session-live', 'local:live'))
    await service.refresh(session('session-live', 'local:live'), { turn: null })
    expect(service.runtime.getSnapshot().livenessSource).toBe('clock')

    // 启发式仍在（无内核表态时）：实时正文帧采纳时钟。
    push(canonicalRow(3, 'agent_message_chunk', { content: { type: 'text', text: '又写了一段' } }))
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.livenessSource).toBe('clock')
    expect(snapshot.generating).toBe(true)
    service.destroy()
  })

  it('终帧落静后内核事实同步为否（后续重放帧不得复活）', async () => {
    const { service, push } = journalRuntime([])
    const active = session('session-live', 'local:live')
    await service.bind(active)
    await service.refresh(active, { turnInFlight: true })
    expect(service.runtime.getSnapshot().generating).toBe(true)

    // 终帧：内核已收敛 ⇒ kernelLiveness=false + 时钟封存。
    await getCanonicalEventFeed().acceptFrame({ event: 'pylon:done', payload: { source: active.source } })
    expect(service.runtime.getSnapshot().generating).toBe(false)

    // 迟到的重放/直播帧不得复活生成态（权威仍为 kernel=false）。
    push(canonicalRow(1, 'agent_message_chunk', { content: { type: 'text', text: '迟到的正文' } }))
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.livenessSource).toBe('kernel')
    expect(snapshot.generating).toBe(false)
    service.destroy()
  })

  it('合并层：livenessSource=kernel 的权威值在 merge 中不被文档派生覆盖', () => {
    const document = projectWorkbench(UNTERMINATED_ENVELOPES, { initialDocument: createWorkbenchDocument('local:live') }).document
    const runtime = bareRuntime()
    runtime.replaceDocument(document, { ownerKey: 'owner-live', generation: 1, livenessSource: 'kernel', livenessGenerating: false })
    const snapshot = runtime.getSnapshot()
    expect(snapshot.livenessSource).toBe('kernel')
    expect(snapshot.generating).toBe(false)
    runtime.destroy()
  })
})

/**
 * #217 审核修复守卫（子代理审核发现 1/2/3 的回归锁）。
 */
describe('#217 守卫 · 终帧与 stale 快照的边界', () => {
  it('他 source 的终帧（双轨重复投递）不得误伤当前绑定会话的生成态', async () => {
    const { service } = journalRuntime([])
    const active = session('session-live', 'local:live')
    await service.bind(active)
    // A 会话在途（他窗派发 → kernel=true 无本地时钟）
    await service.refresh(active, { turnInFlight: true })
    expect(service.runtime.getSnapshot().generating).toBe(true)

    // 他 source B 的终帧：Channel 主轨 + 广播兜底设计上重复投递两次
    await getCanonicalEventFeed().acceptFrame({ event: 'pylon:done', payload: { source: 'local:other' } })
    await getCanonicalEventFeed().acceptFrame({ event: 'pylon:done', payload: { source: 'local:other' } })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(true)
    expect(snapshot.livenessSource).toBe('kernel')
    service.destroy()
  })

  it('终帧之后迟到的 stale 快照（同 turnId 的 turnInFlight=true）不得复活生成态', async () => {
    const { service } = journalRuntime([])
    const active = session('session-live', 'local:live')
    const turnKey = (turnId: number) => ({
      phase: 'streaming',
      key: { localSessionId: 'local:live', remoteSessionId: 'p1', generation: 1, turnId },
    })
    await service.bind(active)
    await service.refresh(active, { turnInFlight: true, turn: turnKey(5) })
    expect(service.runtime.getSnapshot().generating).toBe(true)

    // 终帧：落静，并把身份 1:5 记为 settled
    await getCanonicalEventFeed().acceptFrame({ event: 'pylon:done', payload: { source: active.source } })
    expect(service.runtime.getSnapshot().generating).toBe(false)

    // late 快照（早于终态合成，同一回合身份）：true 必须被身份判别挡住
    await service.refresh(active, { turnInFlight: true, turn: turnKey(5) })
    let snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.livenessSource).toBe('kernel')

    // 新回合（不同 turnId）：照常采纳
    await service.refresh(active, { turnInFlight: true, turn: turnKey(6) })
    snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(true)
    service.destroy()
  })

  it('旧内核（快照无 turnInFlight）：本地终态不得制造内核权威，#213 启发式保持', async () => {
    const { service, push } = journalRuntime([])
    const active = session('session-live', 'local:live')
    await service.bind(active)

    // 第一回合（时钟权威）：echo 开时钟 → 终态行落文档 + 终帧落静
    push(canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '第一回合' } }))
    expect(service.runtime.getSnapshot().generating).toBe(true)
    expect(service.runtime.getSnapshot().livenessSource).toBe('clock')
    // done 的 canonical 行落文档（与生产一致：终态行进投影，解除 running 标记）
    push(canonicalRow(2, 'done'))
    await getCanonicalEventFeed().acceptFrame({ event: 'pylon:done', payload: { source: active.source } })
    expect(service.runtime.getSnapshot().generating).toBe(false)
    expect(service.runtime.getSnapshot().livenessSource).toBe('clock')

    // 第二回合：采纳启发式必须仍然可用（未被前端自造的内核表态关闭）
    push(canonicalRow(3, 'user_message_chunk', { content: { type: 'text', text: '第二回合' } }))
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.livenessSource).toBe('clock')
    expect(snapshot.generating).toBe(true)
    service.destroy()
  })
})
