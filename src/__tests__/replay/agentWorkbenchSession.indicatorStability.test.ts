import { describe, expect, it } from 'vitest'
import { createAgentWorkbenchSessionRuntime } from '../../application/agent-workbench/agentWorkbenchSession.ts'
import type { Session } from '../../domains/identity/identityStore.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'

/**
 * #390 回归护栏：生成指示器的三个用户可见症状同源于一处——
 * 「本回合是否已终态」用了**回合无关**的证据（`hasCanonicalTurnTerminal`：
 * 「历史上有过终态」，而非「本轮收敛」），于是任何一次 canonical 重读（bind / refresh /
 * 草稿提交 / 被拒回滚）只要该会话**曾经**完成过一个回合，就会把在途回合判成已收敛：
 * 时钟被不可逆封存、补出上一轮的 displayOnly 摘要 ⇒ 页脚显示「已完成 + 上一轮的耗时」
 * 且不再走秒（用户原话：切换页面会导致状态混乱，时间不更新，一直显示已完成）。
 *
 * 用户报告（2026-09-27）：
 * 「生成指示器状态机不稳定，包括但不限于：切换页面会导致状态混乱，时间不更新，
 *   一直显示已完成」「真机有时候 spinner 和秒数都停」
 */

function session(id: string, source: string): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function canonicalRow(sequence: number, sessionUpdate: string, fields: Record<string, unknown> = {}) {
  const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:indicator' }
  return {
    schemaVersion: 1,
    eventId: `${toCanonicalOwnerKey(owner)}#${sequence}`,
    owner,
    provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'peri' },
    clientGeneration: 1,
    sequence,
    occurredAt: `2026-09-05T00:00:0${sequence}.000Z`,
    receivedAt: `2026-09-05T00:00:0${sequence}.000Z`,
    eventType: sessionUpdate === 'user_message_chunk' ? 'user.message'
      : sessionUpdate === 'done' ? 'turn.completed' : 'unknown',
    payloadVersion: 1,
    rawPayload: { update: { sessionUpdate, ...fields } },
  }
}

const USER_TURN_ONE = canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '上一轮请求' } })
const TURN_ONE_DONE = canonicalRow(2, 'done')

/**
 * 复现装置：journal 里只有**上一轮**的终态（row 2）；本轮（row 3/4）由 live 帧驱动。
 * `loadAll` 每次 bind/refresh 都读同一份 journal——与生产一致：本轮的行是否已落盘
 * 由后端决定，测试固定为「尚未落盘」，这正是塌陷窗口。
 */
function indicatorHarness() {
  const journal: unknown[] = [USER_TURN_ONE, TURN_ONE_DONE]
  let pushEvent: ((row: unknown) => void) | undefined
  let pushTerminal: ((signal: unknown) => void) | undefined
  const service = createAgentWorkbenchSessionRuntime({
    loadAll: async () => journal,
    subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
    listenTerminalFallback: listener => { pushTerminal = listener as never; return () => { pushTerminal = undefined } },
  })
  const active = session('session-indicator', 'local:indicator')
  const startNewTurn = () => {
    journal.push(canonicalRow(3, 'user_message_chunk', { content: { type: 'text', text: '本轮请求' } }))
    pushEvent?.(canonicalRow(3, 'user_message_chunk', { content: { type: 'text', text: '本轮请求' } }))
    pushEvent?.(canonicalRow(4, 'agent_message_chunk', { content: { type: 'text', text: '正在生成' } }))
  }
  return {
    service, active, startNewTurn,
    push: (row: unknown) => pushEvent?.(row),
    terminal: (signal: unknown) => pushTerminal?.(signal),
  }
}

describe('#390 在途回合不被 canonical 重读压成上一轮的已完成摘要', () => {
  it('前一回合已完成时，bind 仍恢复 displayOnly 摘要（既有行为不回退）', async () => {
    const h = indicatorHarness()
    await h.service.bind(h.active)
    const snapshot = h.service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({ reason: 'done', displayOnly: true })
    h.service.destroy()
  })

  it('在途回合中切走再切回（bind）：仍是在途，且不得出现摘要', async () => {
    const h = indicatorHarness()
    await h.service.bind(h.active)
    h.startNewTurn()
    expect(h.service.runtime.getSnapshot().generating, '本轮 live 帧必须开启生成态').toBe(true)

    // 切换页面：切走 → 切回。journal 里本轮的锚点行尚未落盘，尾行仍是上一轮的终态。
    await h.service.bind(session('session-other', 'local:other'))
    await h.service.bind(h.active)

    const snapshot = h.service.runtime.getSnapshot()
    expect(snapshot.generating, '在途回合切回后必须仍为生成态').toBe(true)
    expect(snapshot.summary, '在途回合切回后不得显示上一轮的已完成摘要').toBeNull()
    h.service.destroy()
  })

  it('在途回合中 canonical 重读（refresh 不带账本）：同上', async () => {
    const h = indicatorHarness()
    await h.service.bind(h.active)
    h.startNewTurn()
    expect(h.service.runtime.getSnapshot().generating).toBe(true)

    await h.service.refresh(h.active)

    const snapshot = h.service.runtime.getSnapshot()
    expect(snapshot.generating, '不带账本的重读不得压熄在途生成态').toBe(true)
    expect(snapshot.summary).toBeNull()
    h.service.destroy()
  })

  it('误判路径关闭后，真实终帧写的是 live 摘要（而不是上一轮的 displayOnly 值）', async () => {
    const h = indicatorHarness()
    await h.service.bind(h.active)
    h.startNewTurn()

    await h.service.bind(session('session-other', 'local:other'))
    await h.service.bind(h.active)
    h.terminal({ source: 'local:indicator', reason: 'done' })

    const snapshot = h.service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    // 用户症状的判据：耗时必须是**本轮**的 live 观测值，而不是上一轮 canonical 的静态值。
    expect(snapshot.summary).toMatchObject({ reason: 'done', durationSource: 'live-monotonic' })
    expect(snapshot.summary?.displayOnly).toBeUndefined()
    h.service.destroy()
  })

  it('live 帧推进 lastTokenAt（修「长流式回合被顶成等待/仍在等待」）', async () => {
    const h = indicatorHarness()
    await h.service.bind(h.active)
    h.startNewTurn()
    const first = h.service.runtime.getSnapshot().lastTokenAt
    expect(first).toBeGreaterThan(0)

    // 回合一味追加正文（append-delta 不更新 message.time）：idleMs 的分子必须跟着走。
    h.push({
      ...canonicalRow(5, 'agent_message_chunk', { content: { type: 'text', text: '继续输出' } }),
      occurredAt: '2026-09-05T00:00:09.000Z',
      receivedAt: '2026-09-05T00:00:09.000Z',
    })
    const second = h.service.runtime.getSnapshot().lastTokenAt
    expect(second, 'lastTokenAt 必须随 live 帧单调推进').toBeGreaterThan(first!)
    h.service.destroy()
  })

  it('会话确有终态且无在途时钟时，重读仍补出 displayOnly 摘要（#99 兜底不回退）', async () => {
    const h = indicatorHarness()
    await h.service.bind(h.active)
    // 无 live 回合：时钟未被开启，journal 最新边界是终态 ⇒ 摘要必须补出。
    await h.service.refresh(h.active)
    expect(h.service.runtime.getSnapshot().summary).toMatchObject({ reason: 'done', displayOnly: true })
    h.service.destroy()
  })
})
