import { describe, expect, it } from 'vitest'
import {
  LIFECYCLE_PHASES,
  applyLifecycleEvent,
  createEmptyLifecycleState,
  normalizeNormalizedError,
  readableLifecycleLines,
  selectActiveErrors,
  type NormalizedError,
} from '../lifecycleModel.ts'

describe('lifecycle domain model (C13)', () => {
  it('keeps retry chain attempt/delay and settles previous retry on terminal event', () => {
    let state = createEmptyLifecycleState()
    state = applyLifecycleEvent(state, { type: 'lifecycle.retrying', attempt: 1, maxAttempts: 3, delayMs: 2000, error: { message: 'overloaded', code: 'provider_overloaded' } as unknown as Parameters<typeof JSON.stringify>[0] })
    state = applyLifecycleEvent(state, { type: 'lifecycle.retrying', attempt: 2, maxAttempts: 3, delayMs: 4000, error: { message: 'still overloaded', code: 'provider_overloaded' } as unknown as Parameters<typeof JSON.stringify>[0] })
    expect(state.retry).toMatchObject({ attempt: 2, maxAttempts: 3, delayMs: 4000 })
    expect(state.history.at(-1)?.delayMs).toBe(4000)
    // 终态事件收敛 retry 但不删除历史事实
    const beforeSettle = state.history.length
    state = applyLifecycleEvent(state, { type: 'lifecycle.recovered', source: 'canonical' })
    expect(state.retry).toBeUndefined()
    expect(state.history.length).toBeGreaterThan(beforeSettle)
    expect(state.history.some(item => item.kind === 'retry')).toBe(true)
    expect(state.history.some(item => item.kind === 'recovered')).toBe(true)
    expect(LIFECYCLE_PHASES).toContain('retry')
  })

  it('tracks compact before/after tokens and rewind preview without losing history', () => {
    let state = createEmptyLifecycleState()
    state = applyLifecycleEvent(state, { type: 'lifecycle.compact-started', strategy: 'rolling', trigger: 'context-full', tokensBefore: 180000 })
    expect(state.compact).toMatchObject({ strategy: 'rolling', trigger: 'context-full', tokensBefore: 180000, phase: 'started' })
    state = applyLifecycleEvent(state, { type: 'lifecycle.compact-completed', summary: '保留最近 40 条', tokensBefore: 180000, tokensAfter: 42000 })
    expect(state.compact).toMatchObject({ phase: 'completed', tokensAfter: 42000 })
    state = applyLifecycleEvent(state, {
      type: 'lifecycle.rewind-preview',
      files: [{ path: 'a.ts', additions: 10, deletions: 2 }] as unknown as readonly Parameters<typeof JSON.stringify>[0][],
      messages: [{ id: 'message-1', role: 'assistant' }] as unknown as readonly Parameters<typeof JSON.stringify>[0][],
    })
    expect(state.rewind).toMatchObject({ phase: 'preview' })
    expect(state.history.at(-1)?.messages).toEqual([{ id: 'message-1', role: 'assistant' }])
    state = applyLifecycleEvent(state, { type: 'lifecycle.rewind-completed', summary: '已回退 1 个文件' })
    expect(state.rewind).toMatchObject({ phase: 'completed' })
    expect(state.rewind?.messages).toEqual([{ id: 'message-1', role: 'assistant' }])
    // 历史事实保留：compact/rewind 各有一条 completed 记录
    expect(state.history.filter(item => item.kind === 'compact').at(-1)?.summary).toBe('保留最近 40 条')
    expect(state.history.filter(item => item.kind === 'rewind').at(-1)?.summary).toBe('已回退 1 个文件')
  })

  it('models suspend/resume with reason and keeps suspension visible until recovered', () => {
    let state = createEmptyLifecycleState()
    state = applyLifecycleEvent(state, { type: 'lifecycle.suspended', reason: '等待用户输入' })
    expect(state.suspended).toMatchObject({ reason: '等待用户输入' })
    // resume 无专用事件：recovered 即恢复
    state = applyLifecycleEvent(state, { type: 'lifecycle.recovered', source: 'agent-import', importedEvents: 42 })
    expect(state.suspended).toBeUndefined()
    expect(state.lastRecovery).toMatchObject({ source: 'agent-import', importedEvents: 42 })
  })

  it('normalizes nested cause chains into NormalizedError without string parsing in UI', () => {
    const error = normalizeNormalizedError({
      userMessage: '无法连接到 Agent',
      technicalMessage: 'connect ECONNREFUSED 127.0.0.1:9100',
      code: 'agent_connection_timeout',
      recoverability: 'retry',
      cause: {
        technicalMessage: 'socket hang up',
        code: 'ECONNRESET',
        recoverability: 'none',
      },
    }) as NormalizedError
    expect(error.userSummary).toBe('无法连接到 Agent')
    expect(error.technicalMessage).toContain('ECONNREFUSED')
    expect(error.recoverability).toBe('retry')
    expect(error.cause?.code).toBe('ECONNRESET')
    // cause chain 深度受控且可见
    expect(normalizeNormalizedError({ technicalMessage: 'x', cause: { technicalMessage: 'y', cause: { technicalMessage: 'z' } } })?.cause?.cause).toBeDefined()
  })

  it('retains provider error extensions in metadata and marks truncated cause chains', () => {
    const error = normalizeNormalizedError({
      userSummary: '连接失败',
      technicalMessage: 'ECONNRESET',
      code: 'provider.error',
      recoverability: 'retry',
      provider: 'hermes',
      retryAfterMs: 2000,
      classification: 'network',
      cause: { message: 'socket hang up' },
    }) as NormalizedError
    expect(error.metadata).toMatchObject({ retryAfterMs: 2000, classification: 'network' })

    let deep: Record<string, unknown> = { message: 'leaf' }
    for (let index = 0; index < 8; index += 1) deep = { message: `cause-${index}`, cause: deep }
    const bounded = normalizeNormalizedError({ message: 'root', cause: deep }) as NormalizedError
    let cursor: NormalizedError | undefined = bounded
    while (cursor?.cause) cursor = cursor.cause
    expect(cursor?.metadata).toMatchObject({ causeTruncated: true })
  })

  it('normalizes approved error detail, retryability, and renderer/plugin identity fields', () => {
    const error = normalizeNormalizedError({
      message: '渲染失败',
      detail: 'mount threw at LifecycleCard',
      retryable: true,
      session_id: 'session-snake',
      event_id: 'event-snake',
      renderKind: 'system.error',
      rendererId: 'solid.lifecycle',
      rendererSuiteId: 'builtin.solid',
      rendererSlotId: 'lifecycle.error',
      pluginId: 'plugin.example',
      runtimeInstanceId: 'runtime-1',
      phase: 'mount',
    }) as NormalizedError
    expect(error).toMatchObject({
      technicalMessage: 'mount threw at LifecycleCard',
      recoverability: 'retry',
      sessionId: 'session-snake',
      eventId: 'event-snake',
      renderKind: 'system.error',
      rendererId: 'solid.lifecycle',
      rendererSuiteId: 'builtin.solid',
      rendererSlotId: 'lifecycle.error',
      pluginId: 'plugin.example',
      runtimeInstanceId: 'runtime-1',
      phase: 'mount',
    })
  })

  it('separates transient errors from historical notices; recovery does not delete facts', () => {
    let state = createEmptyLifecycleState()
    state = applyLifecycleEvent(state, { type: 'lifecycle.retrying', attempt: 1, maxAttempts: 3, delayMs: 1000, error: { technicalMessage: 'boom', recoverability: 'retry' } as unknown as Parameters<typeof JSON.stringify>[0] })
    // transient：当前活动错误只有一条（最新 retry 的 error）
    expect(selectActiveErrors(state)).toHaveLength(1)
    expect(selectActiveErrors(state)[0]?.technicalMessage).toBe('boom')
    state = applyLifecycleEvent(state, { type: 'lifecycle.recovered', source: 'canonical' })
    // 恢复后 active 清空，历史仍在
    expect(selectActiveErrors(state)).toHaveLength(0)
    expect(readableLifecycleLines(state.history)).toEqual([
      expect.stringContaining('[retry]'),
      expect.stringContaining('[recovered]'),
    ])
  })

  it('tolerates malformed payloads without throwing', () => {
    let state = createEmptyLifecycleState()
    // attempt 缺失收窄为 0，不抛错
    state = applyLifecycleEvent(state, { type: 'lifecycle.retrying' })
    expect(state.retry?.attempt ?? 0).toBe(0)
    // 未知事件类型不进 history
    const before = state.history.length
    state = applyLifecycleEvent(state, { type: 'unknown-event' } as never)
    expect(state.history).toHaveLength(before)
  })
})
