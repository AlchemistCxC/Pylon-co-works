import { describe, expect, it } from 'vitest'
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'
import type { Session } from '../../../domains/identity/identityStore.ts'
import type { CanonicalTerminalSignal } from '../../../infrastructure/events/canonicalEventFeed.ts'

/**
 * issue #68 残留面：生成摘要**只**由终帧驱动，而终帧只经 per-source IPC Channel
 * 一条路交付。
 *
 * - `src-tauri/src/session/prompt.rs` 的 `send_channel_terminal` 用 `take` 语义
 *   （发送即注销），`lifecycle/mod.rs` 的 `stop_agent_runtime` 会 `clear_update_channels`；
 * - 前端 `activeStreams` 条目也会在 invoke 被拒时被 `close(source)` 移除，此后 Channel
 *   回调 `activeStreams.get(source)?.handler(frame)` 拿不到 handler，帧被静默丢弃；
 * - 而 `pylon:done`/`pylon:error` 的 window 广播在加兜底前**没有任何消费者**。
 *
 * 于是 Channel 一丢，终帧就没有第二次投递：文档投影照旧收敛到「不在生成」，运行时
 * 落到 `generating:false, summary:null`，footer 两样都不渲染（无 spinner、无「处理耗时」），
 * 唯一恢复手段是切 sheet 触发 canonical 重读。
 *
 * 本文件锁两条不依赖 Channel 注册的终态证据：
 * ① window 广播兜底订阅；
 * ② #99 冷挂载 turn 账本（随 `load_persisted_session` 回来，设计意图即「前端不再依赖
 *    一次性的 Tauri event」）。
 */

function session(id: string, source: string): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function runtimeFor(active: Session, overrides: {
  loadAll?: () => Promise<readonly unknown[]>
  listenTerminalFallback?: (listener: (signal: CanonicalTerminalSignal) => void) => () => void
} = {}) {
  return createAgentWorkbenchSessionRuntime({
    loadAll: overrides.loadAll ?? (async () => []),
    subscribe: () => () => {},
    ...(overrides.listenTerminalFallback ? { listenTerminalFallback: overrides.listenTerminalFallback } : {}),
    commands: {
      resolveSession: () => active,
      nextClientMessageId: () => 'client-68-fallback-1',
      sendMessage: async () => {},
      optimisticUser: () => {},
      rejectOptimisticUser: () => {},
      resolvePersona: () => 'default',
      requestCancel: () => {},
    },
  })
}

describe('terminal delivery does not depend on the per-source IPC Channel (issue #68 residue)', () => {
  it('publishes the summary from the window broadcast when no Channel frame ever arrives', async () => {
    const active = session('session-fallback', 'local:fallback')
    const listeners: Array<(signal: CanonicalTerminalSignal) => void> = []
    const service = runtimeFor(active, {
      listenTerminalFallback: listener => {
        listeners.push(listener)
        return () => { listeners.length = 0 }
      },
    })

    const sent = await service.commands.send(active.id, { text: '首条消息' })
    expect(sent.status).toBe('sent')
    await service.bind(active)
    expect(service.runtime.getSnapshot().generating).toBe(true)
    // 模拟 Channel 注册丢失：feed.onTerminal 一次都不触发（没有 Channel 帧）。
    expect(listeners).toHaveLength(1)

    // 终帧只从 window 广播兜底进来——它带 source，必须照常收敛。
    listeners[0]({ source: active.source, kind: 'done', payload: { source: active.source } })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({
      reason: 'done',
      durationSource: 'live-monotonic',
      durationAvailable: true,
    })
    expect(snapshot.summary?.elapsedMs).toBeGreaterThan(0)
    service.destroy()
  })

  it('keeps the broadcast redundant: a duplicate terminal is a no-op, not a second summary', async () => {
    const active = session('session-fallback-dup', 'local:fallback-dup')
    const listeners: Array<(signal: CanonicalTerminalSignal) => void> = []
    const service = runtimeFor(active, {
      listenTerminalFallback: listener => { listeners.push(listener); return () => {} },
    })

    await service.commands.send(active.id, { text: '首条消息' })
    await service.bind(active)
    const signal: CanonicalTerminalSignal = { source: active.source, kind: 'done', payload: { source: active.source } }
    listeners[0](signal)
    const first = service.runtime.getSnapshot().summary
    listeners[0](signal)
    expect(service.runtime.getSnapshot().summary).toBe(first)
    service.destroy()
  })

  it('#324: a done frame carrying stopReason=cancelled summarizes as cancelled (已停止), not a natural completion', async () => {
    const active = session('session-cancelled', 'local:cancelled')
    const listeners: Array<(signal: CanonicalTerminalSignal) => void> = []
    const service = runtimeFor(active, {
      listenTerminalFallback: listener => { listeners.push(listener); return () => {} },
    })

    await service.commands.send(active.id, { text: '首条消息' })
    await service.bind(active)
    expect(service.runtime.getSnapshot().generating).toBe(true)

    // 内核 #324 中性结算：done 帧 + stopReason=cancelled（用户主动停止）。
    listeners[0]({
      source: active.source,
      kind: 'done',
      payload: { source: active.source, data: { stopReason: 'cancelled' } },
    })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({ reason: 'cancelled' })
    service.destroy()
  })
})

describe('#99 cold-mount turn ledger is the second terminal evidence (issue #68 residue)', () => {
  it('publishes a display-only summary when the journal read predates the terminal row', async () => {
    const active = session('session-ledger', 'local:ledger')
    // `loadAll` 返回空 = journal 里还没有终态行（后端 "done 先于 persist"，落盘滞后）。
    const service = runtimeFor(active, { listenTerminalFallback: () => () => {} })

    const sent = await service.commands.send(active.id, { text: '首条消息' })
    expect(sent.status).toBe('sent')
    await service.bind(active)
    expect(service.runtime.getSnapshot().generating).toBe(true)

    // 终帧从未到达（Channel 丢失且无广播），但一次 canonical 重载带回权威账本。
    await service.refresh(active, {
      source: active.source,
      turn: { phase: 'terminal', terminal: { cause: 'completed', settledAtMs: 1, detail: null } },
    })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({ reason: 'done', displayOnly: true })
    service.destroy()
  })

  it('carries the ledger terminal cause into the summary reason', async () => {
    const active = session('session-ledger-cancel', 'local:ledger-cancel')
    const service = runtimeFor(active, { listenTerminalFallback: () => () => {} })

    await service.commands.send(active.id, { text: '首条消息' })
    await service.bind(active)
    await service.refresh(active, {
      source: active.source,
      turn: { phase: 'terminal', terminal: { cause: 'cancelled', settledAtMs: 1 } },
    })

    expect(service.runtime.getSnapshot().summary).toMatchObject({ reason: 'cancelled', displayOnly: true })
    service.destroy()
  })

  it('never fabricates a summary while the ledger says the turn is still in flight', async () => {
    const active = session('session-ledger-inflight', 'local:ledger-inflight')
    const service = runtimeFor(active, { listenTerminalFallback: () => () => {} })

    await service.commands.send(active.id, { text: '首条消息' })
    await service.bind(active)
    await service.refresh(active, { source: active.source, turn: { phase: 'streaming' } })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.summary).toBeNull()
    expect(snapshot.generating).toBe(true)
    service.destroy()
  })

  it('drops a previous turn ledger reason once a new turn starts', async () => {
    const active = session('session-ledger-newturn', 'local:ledger-newturn')
    const service = runtimeFor(active, { listenTerminalFallback: () => () => {} })

    // 第一回合：账本已收敛 → displayOnly 摘要。
    await service.commands.send(active.id, { text: '第一回合' })
    await service.bind(active)
    await service.refresh(active, { source: active.source, turn: { phase: 'terminal', terminal: { cause: 'completed', settledAtMs: 1 } } })
    expect(service.runtime.getSnapshot().summary).toMatchObject({ reason: 'done', displayOnly: true })

    // 第二回合开始：上一回合的账本终态必须失效，否则新回合会被判成已收敛。
    await service.commands.send(active.id, { text: '第二回合' })
    await service.refresh(active, { source: active.source, turn: { phase: 'streaming' } })

    expect(service.runtime.getSnapshot().summary).toBeNull()
    expect(service.runtime.getSnapshot().generating).toBe(true)
    service.destroy()
  })
})
